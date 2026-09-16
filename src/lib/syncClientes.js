'use strict';

const tangoClient = require('./tangoClient');
const hubspotClient = require('./hubspotClient');
const lookups = require('./lookups');
const mapper = require('./mapper');
const documento = require('./documento');
const vinculoCliente = require('./vinculoCliente');
const dryRun = require('./dryRun');
const procesos = require('../../config/tango.processes.json');
const mapeoClientes = require('../../config/mapeo.clientes.json');
const defaults = require('../../config/defaults.tango.json');

/**
 * Fase 2: Tango GVA14 (clientes) -> HubSpot Companies.
 *
 * La logica vive aca y no en la funcion de Azure para poder correrla desde
 * un script sin levantar el runtime (Tango solo acepta trafico desde Azure,
 * pero la comparacion y el mapeo se pueden auditar desde cualquier lado).
 *
 * Estrategia (ARQUITECTURA.md 8.2): se lee el padron completo y se escribe
 * solo lo que cambio, comparando un hash por registro guardado en
 * tango_sync_hash. Sin el hash, cada corrida reescribiria 5.670 companies.
 *
 * Existe GVA14.FECHA_MODI y permite una lectura incremental (9 s contra 107),
 * pero depende de una subconsulta SQL no documentada y de que Tango mantenga
 * el campo. Queda para una segunda etapa: el hash ya evita las escrituras
 * innecesarias, que es donde estaba el costo real.
 *
 * DESDE EL 2026-09-15 (§7.15), decisiones de Matias
 * -------------------------------------------------
 * El 2026-09-03 Ultraschall importo 41.225 empresas: 7.586 con `codigo_tango`
 * y NINGUNA con la clave del sync. Corriendo como estaba, el sync no las
 * reconocia y creaba ~5.700 duplicadas. Ahora:
 *
 *   1. En CADA corrida, un cliente que no aparece por su clave se busca entre
 *      las empresas sin clave con ese `codigo_tango`, y si es el mismo
 *      (`vinculoCliente.comparar`: documento, o nombre) se VINCULA esa empresa
 *      en vez de crear otra. Se arregla solo si vuelven a importar.
 *   2. Solo ESCRIBE contra la empresa 3 de Tango (productivo). En dry-run
 *      corre contra cualquiera.
 *   3. Toda empresa que declara un codigo de Tango lleva `tango_estado`:
 *      vinculada · no existe · codigo de otro cliente · ficha duplicada ·
 *      marcada para borrar. Lo que no cierra se etiqueta y NO se toca.
 *   4. Tango NO pisa lo que se cargo en HubSpot: los campos que la importacion
 *      o comercial cargan son `autoritativoTango: false` en el mapeo.
 *   5. Los clientes basura de Tango se crean igual, etiquetados, y decide la
 *      gente.
 */

const PROP_HASH = 'tango_sync_hash';
const PROP_SYNC = 'tango_ultima_sync';
const PROP_ESTADO = 'tango_estado';
const PROP_DETALLE = 'tango_estado_detalle';
const CLAVE_HS = mapeoClientes._meta.claveIdempotencia.hubspot;
const SYNC = defaults.clientes.sync;

/** Los valores de `tango_estado`. Las etiquetas viven en el mapeo. */
const ESTADOS = {
    VINCULADA: 'vinculada',
    NO_EXISTE: 'no_existe',
    OTRO_CLIENTE: 'codigo_de_otro_cliente',
    DUPLICADA: 'ficha_duplicada',
    BASURA: 'marcada_para_borrar',
};

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

async function correr({ config, log, dryRun = true, fetchImpl }) {
    const inicio = Date.now();

    // Antes de gastar un solo request: escribir contra la copia llevaria datos
    // viejos a un portal que es el real.
    verificarEmpresaDeTango(config, dryRun);

    const tango = tangoClient.crear({
        baseUrl: config.TANGO_API_URL, apiKey: config.TANGO_API_KEY,
        company: config.TANGO_COMPANY, log, ...(fetchImpl ? { fetchImpl } : {}),
    });
    const hs = hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });

    // 1. Tablas auxiliares. Si alguna falla, cortamos: sin los diccionarios
    //    completos se escribirian IDs incorrectos sin error (ARQUITECTURA.md 5.4).
    log.paso('LOOKUPS', 'cargando tablas auxiliares...');
    const lk = await lookups.cargar(tango, log);

    // 2. Padron completo de Tango.
    log.paso('TANGO', `leyendo clientes (process=${procesos.entidades.clientes.process})...`);
    const { registros, total } = await tango.get(procesos.entidades.clientes.process);
    log.datos('TANGO-OK', { 'registros leidos': registros.length, 'totalCount informado': total });

    // 3. Estado actual en HubSpot.
    const m = mapper.crear(mapeoClientes, lk);
    log.paso('HUBSPOT', 'leyendo companies existentes...');
    const existentes = await hs.leerTodos('companies', propiedadesALeer(m));

    // 4. Que escribir.
    const plan = planificar({ registros, existentes, m, ahora: new Date() });
    const resumen = { dryRun, ...plan.resumen, escritos: 0, fallidos: [] };

    // 5. Escribir (o no).
    const aEscribir = plan.updates.length + plan.upserts.length;
    if (dryRun) {
        log.aviso('DRY-RUN', `${config.MODO || 'dry-run'}: no se escribe nada. Se habrian escrito ${aEscribir} companies (${plan.updates.length} por ID, ${plan.upserts.length} por clave).`);
    } else if (aEscribir) {
        // Primero las vinculaciones y etiquetas, que van por ID: son las que le
        // ponen la clave a las importadas. Despues el upsert por clave.
        if (plan.updates.length) {
            log.paso('HUBSPOT', `vinculando y etiquetando ${plan.updates.length} companies por ID...`);
            const r = await hs.batchUpdate('companies', plan.updates);
            resumen.escritos += r.procesados;
            resumen.fallidos.push(...r.fallidos);
        }
        if (plan.upserts.length) {
            log.paso('HUBSPOT', `escribiendo ${plan.upserts.length} companies por clave...`);
            const r = await hs.batchUpsert('companies', CLAVE_HS, plan.upserts);
            resumen.escritos += r.procesados;
            resumen.fallidos.push(...r.fallidos);
        }
    } else {
        log.paso('HUBSPOT', 'no hay nada que escribir');
    }

    resumen.duracionMs = Date.now() - inicio;
    return resumen;
}

/**
 * Lo que hay que leer de cada company. Se DERIVA: una lista escrita a mano se
 * queda corta y el bug no se ve (§9.12, §9.16). `planificar` lee la clave, el
 * hash, el estado, lo que compara la identidad y los campos que no se pisan.
 */
function propiedadesALeer(m) {
    return [...new Set([
        CLAVE_HS, PROP_HASH, PROP_ESTADO, PROP_DETALLE,
        ...vinculoCliente.PROPIEDADES,
        ...m.camposNoAutoritativos(),
    ])];
}

/**
 * El sync solo ESCRIBE contra la empresa productiva de Tango (decision de
 * Matias 2026-09-15). El portal de HubSpot es el real: sincronizar desde la
 * copia lo llenaria de datos viejos y etiquetaria como "no existe" a clientes
 * que en produccion si existen.
 */
function verificarEmpresaDeTango(config, dryRun) {
    const empresa = String(config.TANGO_COMPANY ?? '').trim();
    if (dryRun || empresa === String(SYNC.empresaProductiva)) return;
    throw new Error(
        `syncClientes: solo escribe contra la empresa ${SYNC.empresaProductiva} de Tango (productivo) y TANGO_COMPANY es '${empresa}'. ` +
        'Si es a proposito, correrlo en dry-run.'
    );
}

/**
 * Que escribir, dado el padron de Tango y las companies de HubSpot. Pura: sin
 * red, se testea sola.
 *
 * Cada company que declara un codigo cae en UNO de estos casos:
 *
 *   ya vinculada (tiene la clave)
 *     - es su cliente         -> se actualiza si cambio el hash.  vinculada / basura
 *     - no es su cliente      -> NO se pisa nada.                 codigo de otro cliente
 *     - el codigo no existe   -> no se toca.                      no existe
 *   sin clave, con `codigo_tango`
 *     - es la unica que es    -> se VINCULA por ID.               vinculada / basura
 *     - hay mas de una que es -> no se vincula ninguna.           ficha duplicada
 *     - ya hay otra vinculada -> no se vincula.                   ficha duplicada
 *     - no es ese cliente     -> no se toca.                      codigo de otro cliente
 *     - el codigo no existe   -> no se toca.                      no existe
 *
 * Un cliente de Tango sin ninguna company con su codigo se CREA. Si su codigo
 * lo tiene una company que no es el, NO se crea: habria dos fichas con el
 * mismo codigo y la gente no sabria cual es. Queda en `conflictos`.
 *
 * Una company SIN codigo es un prospecto: no lleva estado. Si tenia uno (le
 * borraron el codigo que estaba mal), se limpia.
 *
 * @returns {{ upserts: Array<{id, properties}>, updates: Array<{id, properties}>, resumen }}
 *   upserts va por `tango_codigo_cliente`; updates, por el ID de HubSpot.
 */
function planificar({ registros, existentes, m, ahora = new Date(), palabrasBasura = SYNC.basura.palabras }) {
    const noAutoritativos = m.camposNoAutoritativos();
    const fecha = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate());
    const resumen = {
        leidosTango: registros.length, enHubSpot: existentes.length,
        aCrear: 0, aActualizar: 0, aVincular: 0, sinCambios: 0, respetados: 0,
        etiquetasCambiadas: 0, estados: {}, conflictos: [], problemas: [],
    };

    // El sync ya NO escribe `domain` (decision 2026-08-24, ARQUITECTURA.md 7.2).
    // La sugerencia derivada de los mails si, pero solo cuando pertenece a un
    // unico cliente: requiere ver el lote entero.
    const sugeridosUnicos = calcularDominiosUnicos(registros, m, 'tango_dominio_sugerido');
    resumen.dominiosSugeridos = sugeridosUnicos.size;

    // ── indices ──────────────────────────────────────────────────────────
    const porCodigo = new Map();
    for (const r of registros) {
        const k = m.clave(r);
        if (!k) { resumen.problemas.push(`registro sin ${mapeoClientes._meta.claveIdempotencia.tango}, se omite`); continue; }
        porCodigo.set(k, r);
    }

    const porClave = new Map();
    const sinClavePorCodigo = new Map();
    for (const c of existentes) {
        const p = c.properties || {};
        if (!vacio(p[CLAVE_HS])) { porClave.set(String(p[CLAVE_HS]).trim(), c); continue; }
        const cod = vinculoCliente.codigoDeclarado(p);
        if (cod) (sinClavePorCodigo.get(cod) || sinClavePorCodigo.set(cod, []).get(cod)).push(c);
    }

    // ── lo que se va a escribir ──────────────────────────────────────────
    const upserts = new Map(); // clave -> properties
    const porId = new Map();   // id de HubSpot -> properties
    const estadoDe = new Map(); // id de HubSpot -> { estado, detalle }

    const marcar = (c, estado, detalle = '') => estadoDe.set(String(c.id), { estado, detalle });

    function mapear(registro) {
        const { propiedades, problemas } = m.aHubSpot(registro);
        for (const p of problemas) resumen.problemas.push(p);
        if (propiedades.tango_dominio_sugerido && !sugeridosUnicos.has(propiedades.tango_dominio_sugerido)) {
            delete propiedades.tango_dominio_sugerido;
        }
        // El hash representa lo que dice TANGO, asi que se calcula antes de
        // descartar nada. Si se calculara despues, un campo protegido haria
        // que cambiara en cada corrida y el registro nunca cerraria.
        return { propiedades, hash: m.hash(propiedades) };
    }

    // Los campos no autoritativos solo se escriben si estan vacios en HubSpot:
    // lo que cargo la importacion o comercial no se pisa (§7.15).
    function respetar(propiedades, actuales) {
        for (const p of noAutoritativos) {
            if (propiedades[p] !== undefined && !vacio(actuales?.[p])) { delete propiedades[p]; resumen.respetados++; }
        }
        return propiedades;
    }

    for (const [codigo, fila] of porCodigo) {
        const suEstado = esBasura(fila, palabrasBasura) ? ESTADOS.BASURA : ESTADOS.VINCULADA;
        const suDetalle = suEstado === ESTADOS.BASURA ? detalles.basura(codigo, fila) : '';

        const vinculada = porClave.get(codigo) || null;
        const candidatas = sinClavePorCodigo.get(codigo) || [];
        const mismas = candidatas.filter((c) => vinculoCliente.comparar(c.properties, fila).mismo);
        const ajenas = candidatas.filter((c) => !mismas.includes(c));
        for (const c of ajenas) marcar(c, ESTADOS.OTRO_CLIENTE, detalles.otroCliente(codigo, fila));

        if (vinculada) {
            if (!vinculoCliente.comparar(vinculada.properties, fila).mismo) {
                // La clave apunta a un cliente que no es: pisarla le cambiaria
                // los IDs a la ficha, y el proximo pedido saldria a otro. Paso
                // con la empresa de prueba al pasar a productivo (2026-09-15).
                marcar(vinculada, ESTADOS.OTRO_CLIENTE, detalles.otroCliente(codigo, fila));
                for (const c of mismas) marcar(c, ESTADOS.DUPLICADA, detalles.duplicada(codigo, fila, [vinculada]));
                resumen.conflictos.push({ codigo, tipo: 'vinculada a una ficha que no es el cliente', empresas: [vinculada.id] });
                continue;
            }
            for (const c of mismas) marcar(c, ESTADOS.DUPLICADA, detalles.duplicada(codigo, fila, [vinculada]));
            marcar(vinculada, suEstado, suDetalle);

            const { propiedades, hash } = mapear(fila);
            if (vinculada.properties?.[PROP_HASH] === hash) { resumen.sinCambios++; continue; }
            upserts.set(codigo, { ...respetar(propiedades, vinculada.properties), [PROP_HASH]: hash, [PROP_SYNC]: fecha });
            resumen.aActualizar++;
            continue;
        }

        if (mismas.length === 1) {
            const [empresa] = mismas;
            const { propiedades, hash } = mapear(fila);
            porId.set(String(empresa.id), { ...respetar(propiedades, empresa.properties), [PROP_HASH]: hash, [PROP_SYNC]: fecha });
            marcar(empresa, suEstado, suDetalle);
            resumen.aVincular++;
            continue;
        }

        if (mismas.length > 1) {
            for (const c of mismas) marcar(c, ESTADOS.DUPLICADA, detalles.duplicada(codigo, fila, mismas.filter((x) => x !== c)));
            resumen.conflictos.push({ codigo, tipo: 'mas de una ficha es el mismo cliente', empresas: mismas.map((c) => c.id) });
            continue;
        }

        if (ajenas.length) {
            resumen.conflictos.push({ codigo, tipo: 'el codigo lo tiene una ficha que no es el cliente: no se crea otra', empresas: ajenas.map((c) => c.id) });
            continue;
        }

        const { propiedades, hash } = mapear(fila);
        upserts.set(codigo, { ...propiedades, [PROP_HASH]: hash, [PROP_SYNC]: fecha, [PROP_ESTADO]: suEstado, [PROP_DETALLE]: suDetalle });
        contar(resumen, suEstado);
        resumen.aCrear++;
    }

    // Codigos que Tango no tiene.
    for (const [codigo, lista] of sinClavePorCodigo) {
        if (!porCodigo.has(codigo)) for (const c of lista) marcar(c, ESTADOS.NO_EXISTE, detalles.noExiste(codigo));
    }
    for (const [codigo, c] of porClave) {
        if (!porCodigo.has(codigo)) marcar(c, ESTADOS.NO_EXISTE, detalles.noExiste(codigo));
    }

    // Prospectos que tenian estado: el codigo se borro, el estado tambien.
    for (const c of existentes) {
        const p = c.properties || {};
        if (vinculoCliente.codigoDeclarado(p)) continue;
        if (!vacio(p[PROP_ESTADO]) || !vacio(p[PROP_DETALLE])) marcar(c, '', '');
    }

    // ── el estado viaja con la escritura que ya haya, o solo ─────────────
    const porIdDeClave = new Map([...porClave].map(([k, c]) => [String(c.id), k]));
    // Un Map y no `existentes.find`: son 41.000 companies por ~7.600 estados.
    const existentePorId = new Map(existentes.map((c) => [String(c.id), c]));
    for (const [id, { estado, detalle }] of estadoDe) {
        if (estado) contar(resumen, estado); else resumen.estados.limpiadas = (resumen.estados.limpiadas || 0) + 1;
        const nuevo = { [PROP_ESTADO]: estado, [PROP_DETALLE]: detalle };

        if (porId.has(id)) { Object.assign(porId.get(id), nuevo); continue; }
        const clave = porIdDeClave.get(id);
        if (clave && upserts.has(clave)) { Object.assign(upserts.get(clave), nuevo); continue; }

        const actual = existentePorId.get(id)?.properties || {};
        if (String(actual[PROP_ESTADO] ?? '') === estado && String(actual[PROP_DETALLE] ?? '') === detalle) continue;
        porId.set(id, nuevo);
        resumen.etiquetasCambiadas++;
    }

    return {
        upserts: [...upserts].map(([id, properties]) => ({ id, properties })),
        updates: [...porId].map(([id, properties]) => ({ id, properties })),
        resumen,
    };
}

function contar(resumen, estado) {
    resumen.estados[estado] = (resumen.estados[estado] || 0) + 1;
}

/**
 * ¿Es un cliente basura de Tango? Por PALABRA ENTERA en la razon social o el
 * nombre de fantasia: "NO USAR", "BORRAR", "REPETIDO". Por fragmento se
 * llevaba a Testa, Contestin y Carabajal (medido 2026-09-15).
 */
function esBasura(fila, palabras = SYNC.basura.palabras) {
    const normal = (s) => ` ${String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;
    const texto = `${normal(fila.RAZON_SOCI)}${normal(fila.NOM_COM)}`;
    return palabras.some((p) => texto.includes(normal(p)));
}

/** Los textos de `tango_estado_detalle`. Los lee comercial, en la ficha. */
const detalles = {
    noExiste: (codigo) => `En Tango no existe ningún cliente con el código ${codigo}.`,
    otroCliente: (codigo, fila) => {
        const cuit = documento.formatear(fila.CUIT);
        return `En Tango el ${codigo} es «${String(fila.RAZON_SOCI ?? '').trim()}»${cuit ? `, CUIT ${cuit}` : ''}.`;
    },
    duplicada: (codigo, fila, otras) => {
        const nombres = otras.map((c) => `«${String(c.properties?.name || c.properties?.razon_social || c.id).trim()}»`).join(', ');
        return `El cliente ${codigo} de Tango («${String(fila.RAZON_SOCI ?? '').trim()}») también está en ${nombres}. Fusionar las fichas.`;
    },
    basura: (codigo, fila) => `En Tango el cliente ${codigo} figura como «${String(fila.RAZON_SOCI ?? '').trim()}»${String(fila.HABILITADO) === 'false' ? ' y está inhabilitado' : ''}. Decidir si se sigue usando.`,
};

/**
 * Dominios que pertenecen a un solo cliente del lote.
 *
 * Un dominio compartido no identifica a nadie. El caso real que motivo esto: MAIL_DE
 * incluye al vendedor de Ultraschall que recibe copia de los comprobantes,
 * y 903 clientes quedarian con ultraschall.com.ar. Ese dominio ya lo
 * descarta el transform; esta pasada cubre el resto.
 *
 * @returns {Set<string>} dominios que sirven como sugerencia
 */
function calcularDominiosUnicos(registros, m, prop = 'tango_dominio_sugerido') {
    const cuenta = new Map();
    for (const r of registros) {
        const { propiedades } = m.aHubSpot(r);
        const d = propiedades[prop];
        if (d) cuenta.set(d, (cuenta.get(d) || 0) + 1);
    }
    const unicos = new Set();
    for (const [d, n] of cuenta) if (n === 1) unicos.add(d);
    return unicos;
}

/** Lee y valida la configuracion. Falla temprano y claro si falta algo. */
function leerConfig(env = process.env) {
    const faltan = [];
    const cfg = {
        TANGO_API_URL: env.TANGO_API_URL,
        TANGO_API_KEY: env.TANGO_API_KEY,
        // Sin default a proposito (§7.15): caia en '1', que no es ni la copia
        // (11) ni productivo (3). Sin empresa no se sabe a que base se lee.
        TANGO_COMPANY: env.TANGO_COMPANY,
        HUBSPOT_TOKEN: env.HUBSPOT_TOKEN,
        // Por seguridad el dry-run es el default: solo un 'false' explicito escribe.
        // Y lo decide SYNC_DRY_RUN_CLIENTES, no la global: este circuito no
        // hereda el modo del circuito de negocios (src/lib/dryRun.js).
        DRY_RUN: dryRun.leer('clientes', env),
        MODO: dryRun.descripcion('clientes', env),
    };
    for (const k of ['TANGO_API_URL', 'TANGO_API_KEY', 'TANGO_COMPANY', 'HUBSPOT_TOKEN']) if (!cfg[k]) faltan.push(k);
    if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    return cfg;
}

module.exports = {
    correr, planificar, propiedadesALeer, verificarEmpresaDeTango, esBasura, leerConfig, calcularDominiosUnicos,
    detalles, ESTADOS, PROP_HASH, PROP_SYNC, PROP_ESTADO, PROP_DETALLE,
};
