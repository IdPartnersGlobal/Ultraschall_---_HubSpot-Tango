'use strict';

const { silencioso } = require('./logger');

/**
 * Cliente de la API de Tango Gestion.
 *
 * Unico lugar del proyecto que conoce la URL del ERP y sus endpoints.
 * Ninguna funcion debe hacer fetch a Tango por su cuenta.
 *
 * Endpoints (relevados 2026-08-14, ver ARQUITECTURA.md 5.8 — no hay
 * documentacion oficial de esta API):
 *
 *   GET  Api/Get?process={p}&pages={n}&pageSize={n}   -> { resultData: { list, totalCount } }
 *   GET  Api/GetById?process={p}&id={id}              -> { value: {...} }
 *   GET  Api/GetByFilter?process={p}&filtroSql=...    -> { list: [...] }
 *   POST Api/Create?process={p}                       -> alta
 *
 * OJO con dos cosas que no son obvias:
 *  - Las rutas path-style (Api/Get/{process}/{pageSize}/...) NO existen en
 *    esta instalacion: devuelven el HTML de la SPA. Todo va por query params.
 *  - Cada endpoint devuelve una forma distinta. normalizar*() lo unifica.
 */

const PAGE_SIZE_DEFAULT = 6000; // sin tope practico: 5670 clientes entran en una sola llamada
const REINTENTOS = 3;
const TIMEOUT_MS = 180000; // la lectura full de clientes tarda ~107s

class TangoError extends Error {
    constructor(mensaje, { status, cuerpo, url } = {}) {
        super(mensaje);
        this.name = 'TangoError';
        this.status = status;
        this.cuerpo = cuerpo;
        this.url = url;
    }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function crear({ baseUrl, apiKey, company = '1', log = silencioso, fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error('tangoClient: falta baseUrl (TANGO_API_URL)');
    if (!apiKey) throw new Error('tangoClient: falta apiKey (TANGO_API_KEY)');

    const raiz = baseUrl.replace(/\/+$/, '');

    async function pedir(ruta, params, { metodo = 'GET', body } = {}) {
        const url = new URL(`${raiz}/${ruta}`);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }

        let ultimoError;
        for (let intento = 1; intento <= REINTENTOS; intento++) {
            const t0 = Date.now();
            try {
                const res = await fetchImpl(url.toString(), {
                    method: metodo,
                    headers: {
                        ApiAuthorization: apiKey,
                        company: String(company),
                        'Content-Type': 'application/json',
                    },
                    body: body ? JSON.stringify(body) : undefined,
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });

                const texto = await res.text();

                // Una ruta inexistente devuelve el HTML de la SPA con status 200.
                if (texto.startsWith('<!DOCTYPE') || texto.startsWith('<html')) {
                    throw new TangoError(`La ruta '${ruta}' no existe en el ERP (devolvio el HTML de la SPA)`, { url: url.toString() });
                }

                if (!res.ok) {
                    throw new TangoError(`Tango respondio ${res.status}`, { status: res.status, cuerpo: texto.slice(0, 500), url: url.toString() });
                }

                let datos;
                try {
                    datos = JSON.parse(texto);
                } catch {
                    throw new TangoError('Tango devolvio algo que no es JSON', { cuerpo: texto.slice(0, 300), url: url.toString() });
                }

                // Tango devuelve 200 con el error adentro del cuerpo.
                if (datos && datos.succeeded === false) {
                    const msg = datos.exceptionInfo?.messages?.join(' | ') || datos.message || 'error sin detalle';
                    throw new TangoError(`Tango rechazo la consulta: ${msg}`, { cuerpo: texto.slice(0, 500), url: url.toString() });
                }

                log.paso('TANGO', `${metodo} ${ruta} process=${params.process} — ${Date.now() - t0}ms`);
                return datos;
            } catch (e) {
                ultimoError = e;

                // Un error de negocio de Tango no se reintenta: va a fallar igual.
                const esDeNegocio = e instanceof TangoError && e.status === undefined && !/timeout|fetch failed/i.test(e.message);
                if (esDeNegocio || intento === REINTENTOS) break;

                const espera = 2 ** intento * 1000;
                log.aviso('TANGO-RETRY', `intento ${intento}/${REINTENTOS} fallo (${e.message}). Reintento en ${espera}ms`);
                await esperar(espera);
            }
        }
        throw ultimoError;
    }

    return {
        /** Lee una entidad completa. Devuelve el array de registros. */
        async get(process, { pageSize = PAGE_SIZE_DEFAULT, pagina = 1 } = {}) {
            const d = await pedir('Api/Get', { process, pages: pagina, pageSize });
            const rd = d.resultData;
            if (!rd) throw new TangoError(`Respuesta inesperada de Api/Get para process=${process}`);
            return { registros: rd.list || [], total: rd.totalCount, hayMas: !!rd.hasNextPage };
        },

        /** Un registro por su ID interno. Devuelve null si no existe. */
        async getById(process, id) {
            const d = await pedir('Api/GetById', { process, id });
            return d.value ?? null;
        },

        /**
         * Filtra por SQL. La condicion va SIN el WHERE: se agrega aca.
         *
         * ⚠️ filtroSql es SQL concatenado del lado del ERP. La condicion se
         * arma SIEMPRE en codigo. Nunca interpolar datos que vengan de un
         * request externo (webhook de HubSpot incluido). Ver ARQUITECTURA.md 10.0.
         */
        async getByFilter(process, condicion) {
            if (!condicion || !condicion.trim()) throw new Error('tangoClient.getByFilter: condicion vacia');
            if (/^\s*where\b/i.test(condicion)) throw new Error("tangoClient.getByFilter: pasar la condicion sin 'WHERE', se agrega solo");
            const d = await pedir('Api/GetByFilter', { process, filtroSql: `WHERE ${condicion}` });
            return d.list || d.resultData?.list || [];
        },

        /** Alta. */
        async create(process, payload) {
            return pedir('Api/Create', { process }, { metodo: 'POST', body: payload });
        },
    };
}

module.exports = { crear, TangoError, PAGE_SIZE_DEFAULT };
