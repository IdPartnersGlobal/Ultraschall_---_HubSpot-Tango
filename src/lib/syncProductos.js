'use strict';

const tangoClient = require('./tangoClient');
const hubspotClient = require('./hubspotClient');
const mapper = require('./mapper');
const preciosArticulo = require('./preciosArticulo');
const procesos = require('../../config/tango.processes.json');
const mapeoProductos = require('../../config/mapeo.productos.json');
const defaults = require('../../config/defaults.tango.json');

/**
 * Fase 1: Tango STA11 (articulos) -> HubSpot Products.
 *
 * Mismo molde que lib/syncClientes —hash diferencial, dry-run por defecto, la
 * logica fuera de la funcion de Azure para poder auditarla desde un script—
 * con dos diferencias que importan:
 *
 * 1. **El precio viene de otra tabla.** `process=87` no lo trae —ninguno de sus
 *    141 campos es de precio— porque los precios no estan en STA11 sino en
 *    GVA17, una fila por articulo y por lista. Desde el 2026-08-31 se leen sin
 *    el process de GVA17: ver lib/preciosArticulo y ARQUITECTURA.md 9.12.
 *
 *    El precio NO entra en el hash, a proposito. El hash resume el registro de
 *    STA11 y decide si hay algo que reescribir; el precio vive afuera y se
 *    consulta aparte, asi que meterlo adentro haria que el hash cambiara segun
 *    si se pudo leer el precio o no, y eso reescribiria productos sin motivo.
 *
 *    ⚠️ `price` NO es autoritativo (decision de Matias, 2026-08-25): los
 *    precios se cargan a mano en HubSpot. El sync solo COMPLETA los que estan
 *    vacios y nunca pisa uno cargado.
 *
 * 2. **Se puede publicar un subconjunto.** `soloCodigos` limita la corrida a
 *    los COD_STA11 que se le pasen. Existe porque la primera prueba contra el
 *    ERP se hace con UN articulo (decision de Matias, 2026-08-25): si algo del
 *    circuito esta mal, que se note en un producto y no en 826.
 */

const PROP_HASH = 'tango_sync_hash';
const PROP_SYNC = 'tango_ultima_sync';

/**
 * El precio se lee de HubSpot APARTE, y hay que acordarse de pedirlo.
 *
 * `mapper.camposNoAutoritativos()` no lo incluye: el mapper solo conoce los
 * campos con origen en Tango (`c.tango && c.hubspot`) y el precio tiene
 * `tango: null` porque viene de GVA17, no de STA11. Si no se pide explicito,
 * `price` no vuelve en la lectura, parece vacio en TODOS los productos y el
 * sync termina pisando los precios cargados a mano — justo lo contrario de la
 * decision del 2026-08-25.
 */
const PROP_PRECIO = 'price';

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

/**
 * Deja solo los articulos que se venden.
 *
 * `PERFIL` dice si el articulo participa de compras, de ventas, de las dos o de
 * ninguna: A=714, V=62, C=9, N=41 sobre los 826 del catalogo. Publicar los C
 * —barra de grilon, cinta de embalaje, manija— es ofrecerle a comercial cosas
 * que Ultraschall compra y no vende.
 *
 * Es el mismo criterio que los depositos inhabilitados (9.11): no ofrecer lo
 * que no se puede usar. Y NO borra nada: un articulo que ya este en HubSpot se
 * queda donde esta, simplemente deja de recibir actualizaciones.
 *
 * Una lista vacia significa "todos", para poder volver atras sin tocar codigo.
 */
function porPerfil(registros, perfiles) {
    if (!perfiles || !perfiles.length) return { registros, excluidos: [] };
    const permitidos = new Set(perfiles.map((p) => String(p).trim().toUpperCase()));
    const registrosOk = [];
    const excluidos = [];
    for (const r of registros) {
        const perfil = String(r.PERFIL ?? '').trim().toUpperCase();
        (permitidos.has(perfil) ? registrosOk : excluidos).push(r);
    }
    return { registros: registrosOk, excluidos };
}

/**
 * @param {object} p
 * @param {object} [p.tango]  cliente de Tango ya armado. Se inyecta en los
 *                            tests para poder ejercitar la corrida entera sin
 *                            red; en produccion no se pasa y se arma con config.
 * @param {object} [p.hs]     idem para HubSpot.
 */
async function correr({ config, log, dryRun = true, tango: tangoInyectado = null, hs: hsInyectado = null }) {
    const inicio = Date.now();
    const claveHs = mapeoProductos._meta.claveIdempotencia.hubspot;
    const claveTango = mapeoProductos._meta.claveIdempotencia.tango;

    const resumen = {
        dryRun, leidosTango: 0, filtrados: 0, enHubSpot: 0,
        aCrear: 0, aActualizar: 0, sinCambios: 0, respetados: 0,
        escritos: 0, problemas: [], fallidos: [], noEncontrados: [],
        excluidosPorPerfil: 0, listaPrecios: null, nombreLista: null,
        conPrecioEnLaLista: 0, preciosCompletados: 0, preciosRespetados: 0, sinPrecioEnTango: 0,
    };

    const tango = tangoInyectado || tangoClient.crear({
        baseUrl: config.TANGO_API_URL, apiKey: config.TANGO_API_KEY,
        company: config.TANGO_COMPANY, log,
    });
    const hs = hsInyectado || hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });

    // 1. Articulos de Tango. No hacen falta tablas auxiliares: el mapeo de
    //    productos no resuelve ningun codigo -> ID interno.
    log.paso('TANGO', `leyendo articulos (process=${procesos.entidades.articulos.process})...`);
    const { registros, total } = await tango.get(procesos.entidades.articulos.process);
    resumen.leidosTango = registros.length;
    log.datos('TANGO-OK', { 'registros leidos': registros.length, 'totalCount informado': total });

    // 1b. Los que se venden. Antes del recorte por codigo, para que una corrida
    //     de prueba con un articulo de compras diga por que no publico nada.
    const { registros: vendibles, excluidos } = porPerfil(registros, config.PERFILES);
    resumen.excluidosPorPerfil = excluidos.length;
    if (excluidos.length) {
        log.aviso('PERFIL', `${excluidos.length} articulos no se publican por su PERFIL (se publican ${config.PERFILES.join(', ')})`);
    }

    // 2. El recorte, si lo hay.
    const { registros: elegidos, noEncontrados } = filtrar(vendibles, config.SOLO_CODIGOS, claveTango);
    resumen.filtrados = elegidos.length;
    resumen.noEncontrados = noEncontrados;

    if (config.SOLO_CODIGOS?.length) {
        log.aviso('FILTRO', `corrida limitada a ${config.SOLO_CODIGOS.join(', ')} — ${elegidos.length} de ${registros.length} articulos`);
        const porCodigo = new Map(registros.map((r) => [String(r[claveTango] ?? '').trim(), r]));
        for (const c of noEncontrados) {
            const enElErp = porCodigo.get(c);
            const motivo = enElErp
                ? `el articulo '${c}' existe en Tango pero no se publica: su PERFIL es '${enElErp.PERFIL}' y se publican ${config.PERFILES.join(', ')}`
                : `el articulo '${c}' de SYNC_PRODUCTOS_SOLO no existe en Tango`;
            resumen.problemas.push(motivo);
            log.error('FILTRO', motivo);
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
    const existentes = await hs.leerTodos('products', [...new Set([claveHs, PROP_HASH, PROP_PRECIO, ...noAutoritativos])]);
    resumen.enHubSpot = existentes.length;

    const estadoPorClave = new Map();
    for (const p of existentes) {
        const k = p.properties[claveHs];
        if (k) estadoPorClave.set(String(k).trim(), { hash: p.properties[PROP_HASH] || null, props: p.properties });
    }

    // 4. Mapear y decidir.
    const ahora = new Date();
    const aEscribir = [];
    const candidatosPrecio = new Map();   // clave de HubSpot -> ID_STA11
    const sinCambiosPorClave = new Map(); // los que solo podrian necesitar el precio

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

        // Candidato a que le completemos el precio: todo el que no lo tenga
        // cargado en HubSpot. Se decide ANTES del corte por hash, porque el
        // precio no esta en el hash: un articulo sin cambios en STA11 al que
        // recien ahora le cargaron el precio en Tango tiene que poder recibirlo.
        const precioEnHubSpot = existe ? estado.props.price : null;
        const tienePrecioCargado = precioEnHubSpot !== null && precioEnHubSpot !== undefined && String(precioEnHubSpot).trim() !== '';
        if (tienePrecioCargado) resumen.preciosRespetados++;
        else if (Number.isInteger(Number(registro.ID_STA11))) candidatosPrecio.set(clave, Number(registro.ID_STA11));

        if (existe && estado.hash === hash) {
            resumen.sinCambios++;
            sinCambiosPorClave.set(clave, hash);
            continue;
        }

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

    // 4b. Los precios, que viven en GVA17 y no en STA11 (9.12).
    //
    //     Primero se pregunta QUIENES tienen precio en la lista —una consulta,
    //     con la subconsulta de 7.7— y recien despues se pagan los GetById de
    //     esos. Al reves serian 826 requests por corrida para completar 133
    //     precios.
    if (config.LISTA_PRECIOS && candidatosPrecio.size) {
        try {
            const r = await preciosArticulo.cargar({
                tango,
                nroDeLista: config.LISTA_PRECIOS,
                soloIds: [...candidatosPrecio.values()],
                log,
            });

            resumen.listaPrecios = config.LISTA_PRECIOS;
            resumen.nombreLista = r.nombreLista;
            resumen.conPrecioEnLaLista = r.conPrecioEnLaLista;
            for (const f of r.fallidos) resumen.problemas.push(`no se pudo leer el precio del articulo ${f.idSta11}: ${f.motivo}`);

            for (const [clave, idSta11] of candidatosPrecio) {
                const precio = r.precios.get(String(idSta11));
                if (precio === undefined) { resumen.sinPrecioEnTango++; continue; }

                const yaEnCola = aEscribir.find((e) => e.id === clave);
                if (yaEnCola) {
                    yaEnCola.properties.price = precio;
                } else {
                    // Estaba sin cambios: se escribe SOLO para completar el
                    // precio. El hash va igual al que ya tenia, porque el
                    // registro de STA11 no cambio.
                    aEscribir.push({
                        id: clave,
                        properties: {
                            price: precio,
                            [PROP_HASH]: sinCambiosPorClave.get(clave),
                            [PROP_SYNC]: Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()),
                        },
                    });
                    resumen.sinCambios--;
                    resumen.aActualizar++;
                }
                resumen.preciosCompletados++;
            }
        } catch (e) {
            // Un problema con los precios no puede voltear el sync del
            // catalogo: los articulos se publican igual, sin precio.
            resumen.problemas.push(`no se pudieron leer los precios (lista ${config.LISTA_PRECIOS}): ${e.message}`);
            log.error('PRECIOS', e.message);
        }
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
        // De que lista salen los precios. Vive versionada en defaults y el
        // entorno solo la pisa: cambiar de lista es una decision, no una
        // variable que alguien toca en Azure sin dejar rastro.
        // `TANGO_LISTA_PRECIOS=0` (o vacio) apaga la lectura de precios.
        LISTA_PRECIOS: env.TANGO_LISTA_PRECIOS !== undefined && env.TANGO_LISTA_PRECIOS !== ''
            ? (Number(env.TANGO_LISTA_PRECIOS) || null)
            : (defaults.productos?.listaPrecios ?? null),
        PERFILES: defaults.productos?.perfilesQueSePublican ?? [],
    };
    const faltan = ['TANGO_API_URL', 'TANGO_API_KEY', 'HUBSPOT_TOKEN'].filter((k) => !cfg[k]);
    if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    return cfg;
}

module.exports = { correr, filtrar, porPerfil, leerConfig, leerSoloCodigos, PROP_HASH, PROP_SYNC, PROP_PRECIO };
