'use strict';

const tangoClient = require('./tangoClient');
const hubspotClient = require('./hubspotClient');
const mapper = require('./mapper');
const procesos = require('../../config/tango.processes.json');
const mapeoProductos = require('../../config/mapeo.productos.json');

/**
 * Fase 1: Tango STA11 (articulos) -> HubSpot Products.
 *
 * Mismo molde que lib/syncClientes —hash diferencial, dry-run por defecto, la
 * logica fuera de la funcion de Azure para poder auditarla desde un script—
 * con dos diferencias que importan:
 *
 * 1. **Sin precio.** `process=87` no lo trae: ninguno de sus 141 campos es de
 *    precio, y el process de la lista de precios sigue sin conseguirse (5.7).
 *    Los productos se publican igual, con `price` vacio.
 *
 *    Eso NO bloquea la Fase 4: el renglon del pedido necesita `ID_STA11`, y el
 *    precio lo pone el line item del Deal, no el catalogo. Lo que queda cojo es
 *    armar presupuestos en HubSpot con los precios reales del ERP.
 *
 *    ⚠️ `price` es autoritativo de Tango en el mapeo. Mientras no haya de donde
 *    sacarlo, el mapper simplemente no lo emite: nunca se escribe un precio en
 *    blanco encima de uno cargado a mano.
 *
 * 2. **Se puede publicar un subconjunto.** `soloCodigos` limita la corrida a
 *    los COD_STA11 que se le pasen. Existe porque la primera prueba contra el
 *    ERP se hace con UN articulo (decision de Matias, 2026-08-25): si algo del
 *    circuito esta mal, que se note en un producto y no en 826.
 */

const PROP_HASH = 'tango_sync_hash';
const PROP_SYNC = 'tango_ultima_sync';

/**
 * Deja solo los articulos pedidos.
 *
 * `soloCodigos` vacio significa "todos". Un codigo que no existe en el ERP se
 * reporta en vez de pasar desapercibido: si alguien escribe mal el codigo de
 * prueba, el sync no puede terminar diciendo "0 productos" como si estuviera
 * todo bien.
 */
function filtrar(registros, soloCodigos, claveTango) {
    if (!soloCodigos || !soloCodigos.length) return { registros, noEncontrados: [] };

    const pedidos = new Set(soloCodigos.map((c) => String(c).trim()));
    const elegidos = registros.filter((r) => pedidos.has(String(r[claveTango] ?? '').trim()));
    const encontrados = new Set(elegidos.map((r) => String(r[claveTango]).trim()));

    return { registros: elegidos, noEncontrados: [...pedidos].filter((c) => !encontrados.has(c)) };
}

async function correr({ config, log, dryRun = true }) {
    const inicio = Date.now();
    const claveHs = mapeoProductos._meta.claveIdempotencia.hubspot;
    const claveTango = mapeoProductos._meta.claveIdempotencia.tango;

    const resumen = {
        dryRun, leidosTango: 0, filtrados: 0, enHubSpot: 0,
        aCrear: 0, aActualizar: 0, sinCambios: 0, respetados: 0,
        escritos: 0, problemas: [], fallidos: [], noEncontrados: [],
    };

    const tango = tangoClient.crear({
        baseUrl: config.TANGO_API_URL, apiKey: config.TANGO_API_KEY,
        company: config.TANGO_COMPANY, log,
    });
    const hs = hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });

    // 1. Articulos de Tango. No hacen falta tablas auxiliares: el mapeo de
    //    productos no resuelve ningun codigo -> ID interno.
    log.paso('TANGO', `leyendo articulos (process=${procesos.entidades.articulos.process})...`);
    const { registros, total } = await tango.get(procesos.entidades.articulos.process);
    resumen.leidosTango = registros.length;
    log.datos('TANGO-OK', { 'registros leidos': registros.length, 'totalCount informado': total });

    // 2. El recorte, si lo hay.
    const { registros: elegidos, noEncontrados } = filtrar(registros, config.SOLO_CODIGOS, claveTango);
    resumen.filtrados = elegidos.length;
    resumen.noEncontrados = noEncontrados;

    if (config.SOLO_CODIGOS?.length) {
        log.aviso('FILTRO', `corrida limitada a ${config.SOLO_CODIGOS.join(', ')} — ${elegidos.length} de ${registros.length} articulos`);
        for (const c of noEncontrados) {
            resumen.problemas.push(`el articulo '${c}' de SYNC_PRODUCTOS_SOLO no existe en Tango`);
            log.error('FILTRO', `el articulo '${c}' no existe en el ERP`);
        }
        if (!elegidos.length) {
            log.error('FILTRO', 'ningun articulo pedido existe: no se escribe nada');
            resumen.duracionMs = Date.now() - inicio;
            return resumen;
        }
    }

    // 3. Estado actual en HubSpot.
    const m = mapper.crear(mapeoProductos);
    const noAutoritativos = m.camposNoAutoritativos();

    log.paso('HUBSPOT', 'leyendo products existentes...');
    const existentes = await hs.leerTodos('products', [claveHs, PROP_HASH, ...noAutoritativos]);
    resumen.enHubSpot = existentes.length;

    const estadoPorClave = new Map();
    for (const p of existentes) {
        const k = p.properties[claveHs];
        if (k) estadoPorClave.set(String(k).trim(), { hash: p.properties[PROP_HASH] || null, props: p.properties });
    }

    // 4. Mapear y decidir.
    const ahora = new Date();
    const aEscribir = [];

    for (const registro of elegidos) {
        const clave = m.clave(registro);
        if (!clave) {
            resumen.problemas.push(`articulo sin ${claveTango}, se omite`);
            continue;
        }

        const { propiedades, problemas } = m.aHubSpot(registro);
        for (const p of problemas) resumen.problemas.push(p);

        const hash = m.hash(propiedades);
        const estado = estadoPorClave.get(clave);
        const existe = estadoPorClave.has(clave);

        if (existe && estado.hash === hash) { resumen.sinCambios++; continue; }

        // Misma regla que en clientes (7.5): lo cargado a mano no se pisa.
        if (existe) {
            for (const p of noAutoritativos) {
                const actual = estado.props[p];
                if (actual !== null && actual !== undefined && String(actual).trim() !== '') {
                    if (propiedades[p] !== undefined) { delete propiedades[p]; resumen.respetados++; }
                }
            }
        }

        existe ? resumen.aActualizar++ : resumen.aCrear++;

        aEscribir.push({
            id: clave,
            properties: {
                ...propiedades,
                [PROP_HASH]: hash,
                [PROP_SYNC]: Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()),
            },
        });
    }

    // 5. Escribir (o no).
    if (dryRun) {
        log.aviso('DRY-RUN', `SYNC_DRY_RUN activo: no se escribe nada. Se habrian escrito ${aEscribir.length} products.`);
    } else if (aEscribir.length) {
        log.paso('HUBSPOT', `escribiendo ${aEscribir.length} products...`);
        const r = await hs.batchUpsert('products', claveHs, aEscribir);
        resumen.escritos = r.procesados;
        resumen.fallidos = r.fallidos;
    } else {
        log.paso('HUBSPOT', 'no hay nada que escribir');
    }

    resumen.duracionMs = Date.now() - inicio;
    return resumen;
}

/** Lista separada por comas -> array. Vacio significa "todos". */
function leerSoloCodigos(valor) {
    return String(valor || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Lee y valida la configuracion. Falla temprano y claro si falta algo. */
function leerConfig(env = process.env) {
    const cfg = {
        TANGO_API_URL: env.TANGO_API_URL,
        TANGO_API_KEY: env.TANGO_API_KEY,
        TANGO_COMPANY: env.TANGO_COMPANY || '1',
        HUBSPOT_TOKEN: env.HUBSPOT_TOKEN,
        SOLO_CODIGOS: leerSoloCodigos(env.SYNC_PRODUCTOS_SOLO),
        DRY_RUN: String(env.SYNC_DRY_RUN ?? 'true').toLowerCase() !== 'false',
    };
    const faltan = ['TANGO_API_URL', 'TANGO_API_KEY', 'HUBSPOT_TOKEN'].filter((k) => !cfg[k]);
    if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    return cfg;
}

module.exports = { correr, filtrar, leerConfig, leerSoloCodigos, PROP_HASH, PROP_SYNC };
