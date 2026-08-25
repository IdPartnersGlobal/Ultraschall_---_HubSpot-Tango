'use strict';

const tangoClient = require('./tangoClient');
const hubspotClient = require('./hubspotClient');
const lookups = require('./lookups');
const mapper = require('./mapper');
const procesos = require('../../config/tango.processes.json');
const mapeoClientes = require('../../config/mapeo.clientes.json');

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
 */

const PROP_HASH = 'tango_sync_hash';
const PROP_SYNC = 'tango_ultima_sync';

async function correr({ config, log, dryRun = true }) {
    const inicio = Date.now();
    const claveHs = mapeoClientes._meta.claveIdempotencia.hubspot;
    const resumen = {
        dryRun, leidosTango: 0, enHubSpot: 0,
        aCrear: 0, aActualizar: 0, sinCambios: 0, respetados: 0,
        escritos: 0, problemas: [], fallidos: [],
    };

    const tango = tangoClient.crear({
        baseUrl: config.TANGO_API_URL, apiKey: config.TANGO_API_KEY,
        company: config.TANGO_COMPANY, log,
    });
    const hs = hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });

    // 1. Tablas auxiliares. Si alguna falla, cortamos: sin los diccionarios
    //    completos se escribirian IDs incorrectos sin error (ARQUITECTURA.md 5.4).
    log.paso('LOOKUPS', 'cargando tablas auxiliares...');
    const lk = await lookups.cargar(tango, log);

    // 2. Padron completo de Tango.
    log.paso('TANGO', `leyendo clientes (process=${procesos.entidades.clientes.process})...`);
    const { registros, total } = await tango.get(procesos.entidades.clientes.process);
    resumen.leidosTango = registros.length;
    log.datos('TANGO-OK', { 'registros leidos': registros.length, 'totalCount informado': total });

    // 3. Estado actual en HubSpot.
    //    Ademas de la clave y el hash se leen los campos NO autoritativos: hay
    //    que saber si ya tienen valor para no pisarlos (paso 4).
    const m = mapper.crear(mapeoClientes, lk);
    const noAutoritativos = m.camposNoAutoritativos();

    log.paso('HUBSPOT', 'leyendo companies existentes...');
    const existentes = await hs.leerTodos('companies', [claveHs, PROP_HASH, ...noAutoritativos]);
    resumen.enHubSpot = existentes.length;
    const estadoPorClave = new Map();
    for (const c of existentes) {
        const k = c.properties[claveHs];
        if (k) estadoPorClave.set(String(k).trim(), { hash: c.properties[PROP_HASH] || null, props: c.properties });
    }

    // 4. Mapear y decidir que escribir.
    const ahora = new Date();
    const aEscribir = [];

    // El sync ya NO escribe `domain` (decision 2026-08-24, ARQUITECTURA.md 7.2):
    // era la segunda clave de matcheo de HubSpot y la unica via por la que dos
    // clientes distintos podian terminar fusionados en una company.
    //
    // La sugerencia derivada de los mails si se escribe, pero solo cuando
    // pertenece a un unico cliente: un dominio compartido no sugiere nada.
    // Requiere ver el lote entero, asi que va en una pasada previa.
    const sugeridosUnicos = calcularDominiosUnicos(registros, m, 'tango_dominio_sugerido');
    resumen.dominiosSugeridos = sugeridosUnicos.size;

    for (const registro of registros) {
        const clave = m.clave(registro);
        if (!clave) {
            resumen.problemas.push(`registro sin ${mapeoClientes._meta.claveIdempotencia.tango}, se omite`);
            continue;
        }

        const { propiedades, problemas } = m.aHubSpot(registro);
        for (const p of problemas) resumen.problemas.push(p);

        if (propiedades.tango_dominio_sugerido && !sugeridosUnicos.has(propiedades.tango_dominio_sugerido)) {
            delete propiedades.tango_dominio_sugerido;
        }

        // El hash representa lo que dice TANGO, asi que se calcula antes de
        // descartar nada. Si se calculara despues, un campo protegido haria
        // que el hash cambiara en cada corrida y el registro nunca cerraria.
        const hash = m.hash(propiedades);
        const estado = estadoPorClave.get(clave);
        const existe = estadoPorClave.has(clave);

        if (existe && estado.hash === hash) { resumen.sinCambios++; continue; }

        // Los campos no autoritativos solo se escriben si estan vacios en
        // HubSpot. Protege la migracion manual de Ultraschall: los nombres
        // normalizados a mano no vuelven a MAYUSCULAS en la proxima corrida.
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
        log.aviso('DRY-RUN', `SYNC_DRY_RUN activo: no se escribe nada. Se habrian escrito ${aEscribir.length} companies.`);
    } else if (aEscribir.length) {
        log.paso('HUBSPOT', `escribiendo ${aEscribir.length} companies en tandas de 100...`);
        const r = await hs.batchUpsert('companies', claveHs, aEscribir);
        resumen.escritos = r.procesados;
        resumen.fallidos = r.fallidos;
    } else {
        log.paso('HUBSPOT', 'no hay nada que escribir');
    }

    resumen.duracionMs = Date.now() - inicio;
    return resumen;
}

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
        TANGO_COMPANY: env.TANGO_COMPANY || '1',
        HUBSPOT_TOKEN: env.HUBSPOT_TOKEN,
        // Por seguridad el dry-run es el default: solo un 'false' explicito escribe.
        DRY_RUN: String(env.SYNC_DRY_RUN ?? 'true').toLowerCase() !== 'false',
    };
    for (const k of ['TANGO_API_URL', 'TANGO_API_KEY', 'HUBSPOT_TOKEN']) if (!cfg[k]) faltan.push(k);
    if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    return cfg;
}

module.exports = { correr, leerConfig, calcularDominiosUnicos, PROP_HASH, PROP_SYNC };
