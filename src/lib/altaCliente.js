'use strict';

const mapper = require('./mapper');
const numeracion = require('./numeracion');
const { silencioso } = require('./logger');
const { PROP_HASH, PROP_SYNC } = require('./syncClientes');
const procesos = require('../../config/tango.processes.json');
const mapeoClientes = require('../../config/mapeo.clientes.json');

/**
 * Escritura de vuelta del alta de clientes: Tango -> la MISMA company de HubSpot.
 *
 * ⚠️ Esto es lo que cierra el riesgo 1 del circuito. Sin escritura de vuelta,
 * la company que creo comercial en HubSpot queda sin `codigo_tango`, el timer
 * nocturno lee el padron, no la encuentra por su clave de idempotencia y crea
 * una SEGUNDA company con el mismo cliente. El alta y el sync se pisan.
 *
 * La idea, y es lo unico que hay que entender de este modulo: la escritura de
 * vuelta no copia dos campos a mano, sino que **corre sobre el cliente recien
 * creado exactamente el mismo mapeo que corre el timer**. Se lee de Tango con
 * la misma proyeccion (`process=2117`), se mapea con `lib/mapper` y se guarda
 * tambien el hash. Asi la primera pasada del timer encuentra el registro, ve
 * el mismo hash y no hace nada: la no-duplicacion no depende de que alguien
 * mantenga dos listas de campos sincronizadas a mano.
 *
 * Se lee de vuelta en vez de reusar lo que mandamos en el alta porque Tango
 * completa y normaliza campos al grabar (ID_GVA14 arranca, las descripciones
 * de las auxiliares vienen resueltas). Cuesta 1,6 s por cliente (§7.6) y es
 * deterministico.
 */

// Cuanto tarda Tango en hacer visible el alta a GetByFilter. En el relevamiento
// el registro aparecio siempre en la primera lectura, pero el alta y la lectura
// son dos requests distintos: si no esta todavia, se reintenta en vez de dar el
// alta por perdida y dejar la company sin codigo, que es el peor final posible.
const REINTENTOS_LECTURA = 3;
const ESPERA_LECTURA_MS = 1500;

/**
 * ⚠️ `filtroSql` es SQL concatenado del lado del ERP (ARQUITECTURA.md 10.0).
 * El codigo puede venir de un webhook, asi que se valida su forma ANTES de
 * meterlo en la condicion. La regla de 10.0 es que el filtro se arma en el
 * codigo; esto es el cinturon que la hace cumplir aunque el dato sea externo.
 */
const COD_SEGURO = /^[A-Za-z0-9]{1,15}$/;

function condicionPorCodigo(codigo) {
    const s = String(codigo ?? '').trim();
    if (!COD_SEGURO.test(s)) {
        throw new Error(`altaCliente: codigo '${codigo}' con forma invalida; no se arma un filtro SQL con eso`);
    }
    return `COD_GVA14 = '${s}'`;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lee de Tango el cliente recien creado, con la proyeccion del sync. */
async function leerCreado(tango, codigo, log = silencioso, espera = ESPERA_LECTURA_MS) {
    const condicion = condicionPorCodigo(codigo);
    const process = procesos.entidades.clientes.process;

    for (let intento = 1; intento <= REINTENTOS_LECTURA; intento++) {
        const filas = await tango.getByFilter(process, condicion);

        if (filas.length === 1) return filas[0];

        // Mas de uno con el mismo COD_GVA14 no deberia poder pasar: la clave es
        // unica en el padron (5.670 registros, cero duplicados). Si pasa, algo
        // se entendio mal y escribir de vuelta cualquiera de los dos ata la
        // company al cliente equivocado.
        if (filas.length > 1) {
            throw new Error(
                `altaCliente: ${filas.length} clientes con COD_GVA14='${codigo}'. ` +
                'La clave dejo de ser unica; no se escribe nada.'
            );
        }

        if (intento < REINTENTOS_LECTURA) {
            log.aviso('ALTA', `el cliente ${codigo} todavia no aparece en Tango, reintento ${intento}/${REINTENTOS_LECTURA - 1}`);
            await esperar(espera);
        }
    }

    throw new Error(
        `altaCliente: el cliente ${codigo} no aparece en Tango despues del alta. ` +
        'Verificar a mano en el ERP antes de reintentar: puede haber quedado creado sin que la company lo sepa.'
    );
}

/**
 * Que se le escribe a la company, dado el registro de Tango y lo que la company
 * ya tiene cargado. Pura: sin red, se testea sola.
 *
 * @param {object} registroTango  el cliente tal como lo devuelve Tango
 * @param {object} propsActuales  propiedades actuales de la company en HubSpot
 * @param {object} m              instancia de mapper para clientes
 * @param {Date}   ahora
 * @returns {{ propiedades: object, problemas: string[], respetados: string[], clave: string }}
 */
function planificarEscritura(registroTango, propsActuales, m, ahora = new Date()) {
    const { propiedades, problemas } = m.aHubSpot(registroTango);
    const respetados = [];

    // La sugerencia de dominio no se escribe desde el alta: solo vale cuando
    // pertenece a un unico cliente, y eso se juzga mirando el padron entero
    // (syncClientes.calcularDominiosUnicos). Desde un registro suelto esa
    // verificacion no existe.
    //
    // Se descarta ANTES del hash, igual que hace el timer con una sugerencia
    // compartida. Consecuencia asumida: si resulta ser unica, la primera
    // corrida del timer vera un hash distinto y la completara. Eso es una
    // reescritura de mas, no un duplicado.
    //
    // `domain` no aparece aca porque el sync ya no lo escribe en ningun lado
    // (decision 2026-08-24, ARQUITECTURA.md 7.2).
    delete propiedades.tango_dominio_sugerido;

    const hash = m.hash(propiedades);

    // Los campos no autoritativos que comercial ya cargo en HubSpot no se pisan:
    // el alta la escribio una persona hace segundos y Tango los tiene en
    // MAYUSCULAS. Es la misma regla del timer (ARQUITECTURA.md 7.5), y aca
    // importa mas todavia porque el dato de HubSpot es el mas fresco de los dos.
    for (const p of m.camposNoAutoritativos()) {
        const actual = propsActuales?.[p];
        if (actual !== null && actual !== undefined && String(actual).trim() !== '') {
            if (propiedades[p] !== undefined) { delete propiedades[p]; respetados.push(p); }
        }
    }

    propiedades[PROP_HASH] = hash;
    propiedades[PROP_SYNC] = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());

    return { propiedades, problemas, respetados, clave: m.clave(registroTango) };
}

/**
 * Escribe de vuelta en la company el cliente que Tango acaba de crear.
 *
 * @param {object}  o
 * @param {object}  o.tango       instancia de lib/tangoClient
 * @param {object}  o.hs          instancia de lib/hubspotClient
 * @param {object}  o.lookups     instancia de lib/lookups ya cargada
 * @param {string}  o.companyId   ID de HubSpot de la company que disparo el alta
 * @param {string}  o.codigo      COD_GVA14 que se uso en el alta
 * @param {boolean} [o.dryRun=true]
 * @returns {Promise<object>} resumen
 */
async function escribirDeVuelta({ tango, hs, lookups, companyId, codigo, log = silencioso, dryRun = true, ahora = new Date() }) {
    if (!companyId) throw new Error('altaCliente: falta companyId');

    const claveHs = mapeoClientes._meta.claveIdempotencia.hubspot;
    const m = mapper.crear(mapeoClientes, lookups);

    // 1. La company tiene que existir y no estar ya atada a otro cliente.
    const company = await hs.objeto('companies', companyId, [claveHs, ...m.camposNoAutoritativos()]);
    if (!company) throw new Error(`altaCliente: la company ${companyId} no existe en HubSpot`);

    const yaTiene = company.properties?.[claveHs];
    if (yaTiene && String(yaTiene).trim() && String(yaTiene).trim() !== String(codigo).trim()) {
        // Reatarla al cliente nuevo dejaria al anterior huerfano y el timer
        // volveria a crear una company para el. Se corta y lo mira una persona.
        throw new Error(
            `altaCliente: la company ${companyId} ya esta vinculada al cliente '${yaTiene}' y el alta genero '${codigo}'. ` +
            'No se pisa: revisar cual de los dos corresponde.'
        );
    }

    // 2. El cliente recien creado, leido con la proyeccion del sync.
    log.paso('ALTA', `leyendo de Tango el cliente ${codigo} recien creado...`);
    const registro = await leerCreado(tango, codigo, log);

    // 3. Que escribir.
    const { propiedades, problemas, respetados, clave } = planificarEscritura(registro, company.properties, m, ahora);

    if (clave !== String(codigo).trim()) {
        throw new Error(`altaCliente: Tango devolvio COD_GVA14='${clave}' y se pidio '${codigo}'. No coinciden; no se escribe nada.`);
    }

    const resumen = {
        companyId,
        codigo: clave,
        idGva14: propiedades.tango_id_gva14 ?? null,
        propiedades,
        problemas,
        respetados,
        dryRun,
        escrito: false,
    };

    // El ID interno es la razon de ser de todo esto: sin el, la Fase 4 no puede
    // armar el pedido de ese cliente (ARQUITECTURA.md 5.3 y 9.2).
    if (resumen.idGva14 === null) {
        problemas.push(`${clave}: Tango no devolvio ID_GVA14; la company queda sin el ID interno y no va a poder facturar`);
    }

    // 4. Escribir.
    if (dryRun) {
        log.aviso('DRY-RUN', `no se escribe: la company ${companyId} habria quedado con ${claveHs}=${clave} y tango_id_gva14=${resumen.idGva14}`);
        return resumen;
    }

    await hs.actualizarObjeto('companies', companyId, propiedades);
    resumen.escrito = true;
    log.paso('ALTA-OK', `company ${companyId} vinculada al cliente ${clave} (ID_GVA14=${resumen.idGva14})`);
    return resumen;
}

module.exports = {
    escribirDeVuelta,
    planificarEscritura,
    condicionPorCodigo,
    leerCreado,
    numeracion,
    REINTENTOS_LECTURA,
};
