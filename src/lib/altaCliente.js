'use strict';

const mapper = require('./mapper');
const numeracion = require('./numeracion');
const { silencioso } = require('./logger');
const { PROP_HASH, PROP_SYNC } = require('./syncClientes');
const procesos = require('../../config/tango.processes.json');
const verificarEmpresa = require('./verificarEmpresa');
const defaultsTango = require('../../config/defaults.tango.json');
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

/**
 * Cuantos codigos se preparan por adelantado.
 *
 * "Sumar uno hasta que entre" (decision de Matias 2026-08-27) necesita margen:
 * cada colision consume un candidato, y volver a pedir mas cuesta releer el
 * padron entero (107 s). Son strings, calculados sobre un padron que ya esta
 * en memoria: pedir 25 no cuesta nada y cubre cualquier tanda de altas
 * manuales simultaneas que se pueda dar en la practica.
 */
const CANDIDATOS = 25;

/**
 * La fila de Tango con ese COD_GVA14, o null.
 *
 * Es como se distingue una COLISION de cualquier otro rechazo del ERP, sin
 * depender de como venga redactado el mensaje de error —que no esta
 * documentado en ningun lado (§5.7)—. Preguntar cuesta 1,6 s y solo se paga
 * cuando el alta ya fallo.
 */
async function filaPorCodigo(tango, codigo, log = silencioso) {
    try {
        const filas = await tango.getByFilter(procesos.entidades.clientes.process, condicionPorCodigo(codigo));
        return filas.length ? filas[0] : null;
    } catch (e) {
        // Si no se puede preguntar, se contesta lo conservador: "no es una
        // colision". Asi el error original se propaga en vez de que el alta
        // siga sumando codigos a ciegas.
        log.aviso('ALTA', `no se pudo verificar si ${codigo} ya existe en Tango: ${e.message}`);
        return null;
    }
}

/**
 * Si la fila que ocupa el codigo es el cliente que acabamos de mandar.
 *
 * El caso que cubre: el alta entro en Tango pero la respuesta se perdio. Sin
 * esto, el reintento crearia un SEGUNDO cliente identico para la misma
 * company. Se compara por CUIT, que es lo mas identificatorio que mandamos —
 * y aunque el CUIT se repita entre sucursales (§7.5), lo que importa aca es
 * que no sea el cliente de otro.
 */
function esElMismoCliente(fila, valores) {
    const norm = (v) => String(v ?? '').replace(/\D/g, '');
    const cuit = norm(valores.CUIT);
    if (cuit && norm(fila.CUIT) === cuit) return true;

    const texto = (v) => String(v ?? '').trim().toUpperCase();
    return !!texto(valores.RAZON_SOCI) && texto(fila.RAZON_SOCI) === texto(valores.RAZON_SOCI);
}

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

/**
 * Da de alta el cliente en Tango y ata la company al cliente creado.
 *
 * Es lo que falta cuando un negocio se gana y la empresa todavia no existe en
 * el ERP: sin `tango_id_gva14` no hay pedido posible (§9.2). Al terminar, la
 * company queda con su codigo y su ID interno, asi que la proxima vez —y el
 * timer nocturno— ya no crean nada.
 *
 * El orden importa y es este:
 *
 *   1. verificarEmpresa dice si se puede y devuelve los campos ya resueltos.
 *      Si falta algo, se corta ACA: sin haber tocado el ERP y sin gastar codigo.
 *   2. numeracion elige el COD_GVA14, que Tango no autoasigna (§7.6).
 *   3. POST Api/Create. Si el codigo colisiona con un alta manual hecha en el
 *      mismo momento, se le SUMA UNO y se reintenta hasta que entre (decision
 *      de Matias 2026-08-27): por eso numeracion devuelve varios y no uno.
 *      ⚠️ Se reintenta SOLO si se verifico contra el ERP que el codigo quedo
 *      tomado por OTRO cliente. Cualquier otro rechazo se propaga sin quemar
 *      codigos, y si el codigo lo ocupa el cliente que acabamos de mandar es
 *      que el alta entro y se perdio la respuesta: se sigue, no se recrea.
 *   4. escribirDeVuelta lee el cliente creado y lo copia a la company. Va
 *      FUERA del reintento a proposito: si falla, el cliente YA existe en el
 *      ERP y volver a crear lo duplicaria.
 *
 * @returns {Promise<{creado, codigo, idGva14, companyId, problemas, pendientes, dryRun}>}
 */
async function crear({ tango, hs, lookups, companyId, propiedades, estrategia, owners = null, ownerId = null, log = silencioso, dryRun = true, ahora = new Date() }) {
    if (!companyId) throw new Error('altaCliente.crear: falta companyId');
    if (!estrategia) {
        // Sin default a proposito: es una decision de administracion (§7.6).
        throw new Error("altaCliente.crear: falta la estrategia de numeracion ('correlativo' o 'reservado', TANGO_NUMERACION)");
    }

    // 1. ¿Se puede?
    // `ownerId` es el owner del NEGOCIO: es lo que decide el vendedor de Tango.
    const v = verificarEmpresa.verificar({ propiedades, mapper: mapper.crear(mapeoClientes, lookups), lookups, owners, ownerId });
    if (!v.ok) {
        log.aviso('ALTA', `la company ${companyId} no se puede dar de alta todavia: ${v.problemas.map((p) => p.campo).join(', ')}`);
        return { creado: false, codigo: null, idGva14: null, companyId, problemas: v.problemas, pendientes: v.pendientes, avisos: v.avisos || [], dryRun };
    }

    // 2. El codigo.
    const padron = await tango.get(procesos.entidades.clientes.process);
    const { codigos } = numeracion.planificar(padron.registros.map((r) => r.COD_GVA14), { estrategia, cantidad: CANDIDATOS });
    log.paso('ALTA', `candidatos de codigo (${estrategia}): ${codigos.join(', ')}`);

    if (dryRun) {
        log.aviso('DRY-RUN', `no se crea nada: la company ${companyId} habria quedado como el cliente ${codigos[0]}`);
        return { creado: false, codigo: codigos[0], idGva14: null, companyId, problemas: [], pendientes: [], dryRun: true, payload: { ...defaultsTango.clientes.defaults, ...v.valores, COD_GVA14: codigos[0] } };
    }

    // 3. El alta. Se suma uno y se reintenta HASTA QUE ENTRE, pero solo cuando
    //    el motivo del rechazo es que el codigo ya estaba tomado.
    const tomados = [];
    let codigoCreado = null;

    for (const codigo of codigos) {
        const payload = { ...defaultsTango.clientes.defaults, ...v.valores, COD_GVA14: codigo };

        try {
            await tango.create(procesos.entidades.clientes.process, payload);
            codigoCreado = codigo;
            log.paso('ALTA-OK', `cliente ${codigo} creado en Tango`);
            break;
        } catch (e) {
            const fila = await filaPorCodigo(tango, codigo, log);

            // No existe: el ERP rechazo por otra cosa (un campo invalido, el
            // ERP caido). Sumar uno no lo arregla y quemaria codigos, asi que
            // se propaga tal cual.
            if (!fila) {
                log.error('ALTA', `el alta de ${codigo} fallo y el codigo NO quedo tomado: no es una colision`);
                throw e;
            }

            // Existe y es el nuestro: el alta SI entro y lo que fallo fue la
            // respuesta. Reintentar con otro codigo crearia un segundo cliente
            // para la misma company.
            if (esElMismoCliente(fila, v.valores)) {
                codigoCreado = codigo;
                log.aviso('ALTA', `el alta de ${codigo} devolvio error (${e.message}) pero el cliente esta creado y es el nuestro; se continua`);
                break;
            }

            // Existe y es de otro: colision con un alta manual. Siguiente.
            tomados.push(codigo);
            log.aviso('ALTA-RETRY', `el codigo ${codigo} ya lo tomo otro cliente ('${fila.RAZON_SOCI ?? ''}'). Se prueba el siguiente.`);
        }
    }

    if (!codigoCreado) {
        throw new Error(
            `altaCliente.crear: los ${tomados.length} codigos candidatos estaban tomados (${tomados[0]}..${tomados.at(-1)}). ` +
            'Se leyo el padron y aun asi colisionaron todos: revisar si hay un alta masiva corriendo en Tango.'
        );
    }

    // 4. Atar la company. FUERA del try de arriba a proposito: el cliente ya
    //    existe en el ERP, asi que si esto falla el error tiene que salir a la
    //    superficie. Reintentar el alta duplicaria el cliente.
    const vuelta = await escribirDeVuelta({ tango, hs, lookups, companyId, codigo: codigoCreado, log, dryRun: false, ahora });
    // Los avisos viajan aunque el alta haya salido bien: son justamente lo que
    // se creo con un default y alguien tiene que completar (9.10).
    return { creado: true, codigo: codigoCreado, idGva14: vuelta.idGva14, companyId, problemas: vuelta.problemas, pendientes: [], avisos: v.avisos || [], dryRun: false };
}

module.exports = {
    crear,
    filaPorCodigo,
    esElMismoCliente,
    CANDIDATOS,
    escribirDeVuelta,
    planificarEscritura,
    condicionPorCodigo,
    leerCreado,
    numeracion,
    REINTENTOS_LECTURA,
};
