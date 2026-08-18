'use strict';

const { silencioso } = require('./logger');

/**
 * Cliente de la API de HubSpot.
 *
 * Portal de Ultraschall: 51311915. Auth con private app token (pat-...).
 *
 * Limites que respeta:
 *  - Batch de 100 registros por request (tope de HubSpot).
 *  - Rate limit: reintento con backoff ante 429 y 5xx, leyendo Retry-After.
 */

const BASE = 'https://api.hubapi.com';
const TAM_BATCH = 100;
const REINTENTOS = 4;
const TIMEOUT_MS = 60000;

class HubSpotError extends Error {
    constructor(mensaje, { status, cuerpo, url, categoria } = {}) {
        super(mensaje);
        this.name = 'HubSpotError';
        this.status = status;
        this.cuerpo = cuerpo;
        this.url = url;
        this.categoria = categoria;
    }
    /** Un scope faltante no se arregla reintentando: hay que tocar la app. */
    get esFaltaDeScope() {
        return this.status === 403 && /scope/i.test(String(this.cuerpo));
    }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const trozos = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function crear({ token, log = silencioso, fetchImpl = fetch } = {}) {
    if (!token) throw new Error('hubspotClient: falta token (HUBSPOT_TOKEN)');

    async function pedir(ruta, { metodo = 'GET', body } = {}) {
        const url = `${BASE}${ruta}`;
        let ultimo;

        for (let intento = 1; intento <= REINTENTOS; intento++) {
            try {
                const res = await fetchImpl(url, {
                    method: metodo,
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });

                const texto = await res.text();
                const datos = texto ? JSON.parse(texto) : {};

                if (res.ok) return datos;

                const err = new HubSpotError(
                    datos.message || `HubSpot respondio ${res.status}`,
                    { status: res.status, cuerpo: texto.slice(0, 600), url, categoria: datos.category }
                );

                // 429 y 5xx se reintentan; el resto no tiene sentido reintentarlo.
                if (res.status !== 429 && res.status < 500) throw err;
                if (intento === REINTENTOS) throw err;

                const retryAfter = Number(res.headers.get('Retry-After'));
                const espera = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** intento * 500;
                log.aviso('HS-RETRY', `${res.status} en ${ruta}, reintento ${intento}/${REINTENTOS} en ${espera}ms`);
                await esperar(espera);
                ultimo = err;
            } catch (e) {
                if (e instanceof HubSpotError) { if (intento === REINTENTOS) throw e; ultimo = e; }
                else if (intento === REINTENTOS) throw e;
                else { ultimo = e; await esperar(2 ** intento * 500); }
            }
        }
        throw ultimo;
    }

    return {
        HubSpotError,

        /** Datos del portal. Sirve para verificar el token al arrancar. */
        cuenta() {
            return pedir('/account-info/v3/details');
        },

        // ------------------------------------------------------- propiedades

        async propiedades(objeto) {
            const d = await pedir(`/crm/v3/properties/${objeto}`);
            return d.results || [];
        },

        async grupos(objeto) {
            const d = await pedir(`/crm/v3/properties/${objeto}/groups`);
            return d.results || [];
        },

        crearGrupo(objeto, grupo) {
            return pedir(`/crm/v3/properties/${objeto}/groups`, { metodo: 'POST', body: grupo });
        },

        /**
         * ⚠️ `hasUniqueValue` NO se puede cambiar despues de crear la propiedad.
         * Si se crea mal hay que borrarla y rehacerla.
         */
        crearPropiedad(objeto, propiedad) {
            return pedir(`/crm/v3/properties/${objeto}`, { metodo: 'POST', body: propiedad });
        },

        // ----------------------------------------------------------- objetos

        /**
         * Upsert por una propiedad unica (idProperty). Parte en tandas de 100.
         *
         * @param {string} objeto      'companies', 'products', ...
         * @param {string} idProperty  propiedad unica que identifica el registro
         * @param {Array<{id:string, properties:object}>} registros
         * @returns {{ procesados, fallidos: Array }}
         */
        async batchUpsert(objeto, idProperty, registros) {
            let procesados = 0;
            const fallidos = [];
            const tandas = trozos(registros, TAM_BATCH);

            for (const [i, tanda] of tandas.entries()) {
                try {
                    const d = await pedir(`/crm/v3/objects/${objeto}/batch/upsert`, {
                        metodo: 'POST',
                        body: { inputs: tanda.map((r) => ({ idProperty, id: r.id, properties: r.properties })) },
                    });
                    procesados += (d.results || []).length;
                    // HubSpot devuelve 207 con errores parciales adentro.
                    for (const e of d.errors || []) fallidos.push({ tanda: i + 1, error: e.message || JSON.stringify(e) });
                    log.paso('HS-UPSERT', `tanda ${i + 1}/${tandas.length}: ${(d.results || []).length} registros`);
                } catch (e) {
                    // Una tanda que falla no corta la corrida (ARQUITECTURA.md 8.4).
                    log.error('HS-UPSERT', `tanda ${i + 1}/${tandas.length} fallo: ${e.message}`);
                    for (const r of tanda) fallidos.push({ id: r.id, error: e.message });
                    if (e instanceof HubSpotError && e.esFaltaDeScope) throw e; // esto no se arregla solo
                }
            }
            return { procesados, fallidos };
        },

        /** Lee todos los registros de un objeto con las propiedades pedidas. */
        async leerTodos(objeto, propiedades) {
            const salida = [];
            let after;
            do {
                const qs = new URLSearchParams({ limit: '100', properties: propiedades.join(',') });
                if (after) qs.set('after', after);
                const d = await pedir(`/crm/v3/objects/${objeto}?${qs}`);
                salida.push(...(d.results || []));
                after = d.paging?.next?.after;
            } while (after);
            return salida;
        },
    };
}

module.exports = { crear, HubSpotError, TAM_BATCH };
