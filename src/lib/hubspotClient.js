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

        /**
         * La tabla de owners: id -> mail, en minuscula.
         *
         * HubSpot guarda en los registros el ID del owner, nunca el mail, asi
         * que para cualquier cosa que se decida por persona hay que traer esta
         * tabla aparte. La consumen `soloOwner` (el freno de las pruebas) y
         * `verificarEmpresa.emailDelOwner` (owner -> vendedor de Tango).
         *
         * Se devuelve un Map y no un array porque las dos la usan como lookup.
         * Son 19 owners: entra en una pagina y no hace falta paginar, pero se
         * pagina igual — el dia que sean 120 no se va a acordar nadie.
         */
        async owners() {
            const tabla = new Map();
            let despues = null;
            do {
                const qs = despues ? `?limit=100&after=${encodeURIComponent(despues)}` : '?limit=100';
                const d = await pedir(`/crm/v3/owners${qs}`);
                for (const o of d.results || []) {
                    if (o.email) tabla.set(String(o.id), String(o.email).toLowerCase());
                }
                despues = d.paging?.next?.after || null;
            } while (despues);
            return tabla;
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

        propiedad(objeto, nombre) {
            return pedir(`/crm/v3/properties/${objeto}/${nombre}`);
        },

        /**
         * ⚠️ `hasUniqueValue` NO se puede cambiar despues de crear la propiedad.
         * Si se crea mal hay que borrarla y rehacerla.
         */
        crearPropiedad(objeto, propiedad) {
            return pedir(`/crm/v3/properties/${objeto}`, { metodo: 'POST', body: propiedad });
        },

        /**
         * PATCH de una propiedad existente. Sirve para agregar opciones a un
         * desplegable o moverla de grupo. NO sirve para cambiar `type` ni
         * `hasUniqueValue`: eso exige borrar y recrear.
         *
         * OJO con `options`: el PATCH REEMPLAZA la lista entera, no la agrega.
         * Hay que mandar siempre las viejas junto con las nuevas o se pierden
         * las opciones que ya tenian valor cargado.
         */
        actualizarPropiedad(objeto, nombre, cambios) {
            return pedir(`/crm/v3/properties/${objeto}/${nombre}`, { metodo: 'PATCH', body: cambios });
        },

        /**
         * ⚠️ DESTRUCTIVO: borra la propiedad y el valor que tenga en todos los
         * registros. HubSpot la archiva 90 dias, pero no hay que contar con eso.
         */
        borrarPropiedad(objeto, nombre) {
            return pedir(`/crm/v3/properties/${objeto}/${nombre}`, { metodo: 'DELETE' });
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

        /**
         * Un registro puntual, por su ID de HubSpot. Devuelve null si no existe.
         *
         * Lo usa la escritura de vuelta del alta (lib/altaCliente): antes de
         * pisar una company hay que saber que campos ya tienen valor cargado a
         * mano, y para un solo registro leer el objeto entero es absurdo.
         */
        async objeto(objeto, id, propiedades = []) {
            const qs = propiedades.length ? `?properties=${encodeURIComponent(propiedades.join(','))}` : '';
            try {
                return await pedir(`/crm/v3/objects/${objeto}/${id}${qs}`);
            } catch (e) {
                if (e instanceof HubSpotError && e.status === 404) return null;
                throw e;
            }
        },

        /**
         * Crea un registro suelto.
         *
         * No lo usa el sync —que va por `batchUpsert`, con su clave de
         * idempotencia— ni el alta de clientes, que actualiza una company que
         * comercial ya creo. Existe para las companies de prueba
         * (`scripts/crearEmpresaDemo.js`): un registro que a proposito NO tiene
         * codigo de Tango, para poder ejercitar el alta al vuelo.
         */
        crearObjeto(objeto, propiedades) {
            return pedir(`/crm/v3/objects/${objeto}`, { metodo: 'POST', body: { properties: propiedades } });
        },

        /**
         * Una nota en la linea de tiempo de un registro.
         *
         * `hs_timestamp` es OBLIGATORIO: sin el HubSpot rechaza la creacion.
         * El cuerpo se interpreta como HTML, asi que lo que venga de datos
         * tiene que llegar escapado (lo hace lib/notaProblema).
         *
         * La asociacion va en el alta y no en una llamada aparte: una nota que
         * queda sin asociar no aparece en ningun registro y no la ve nadie.
         * `associationTypeId` 214 es NOTE_TO_DEAL, definido por HubSpot.
         *
         * Permiso: verificado el 2026-08-28 contra el portal real que el token
         * actual puede crear y borrar notas, aunque `crm.objects.notes.write`
         * no este declarado en app-hsmeta.json. Si algun dia HubSpot lo
         * empieza a exigir, ese es el scope que hay que agregar.
         */
        crearNota(objeto, id, cuerpoHtml, { cuando = new Date(), tipoAsociacion = 214 } = {}) {
            return pedir('/crm/v3/objects/notes', {
                metodo: 'POST',
                body: {
                    properties: {
                        hs_timestamp: new Date(cuando).toISOString(),
                        hs_note_body: cuerpoHtml,
                    },
                    associations: [{
                        to: { id: String(id) },
                        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: tipoAsociacion }],
                    }],
                },
            });
        },

        /** PATCH de un registro puntual, por su ID de HubSpot. */
        actualizarObjeto(objeto, id, propiedades) {
            return pedir(`/crm/v3/objects/${objeto}/${id}`, { metodo: 'PATCH', body: { properties: propiedades } });
        },

        /**
         * IDs asociados a un registro. Va por la v4, que es la unica que
         * devuelve las asociaciones con su tipo.
         *
         * Lo usa el webhook de negocios ganados: del Deal salen la company
         * (a que cliente de Tango va el pedido) y los line items (los renglones).
         */
        async asociaciones(objeto, id, destino) {
            const d = await pedir(`/crm/v4/objects/${objeto}/${id}/associations/${destino}?limit=500`);
            return (d.results || []).map((r) => String(r.toObjectId));
        },

        /**
         * Varios registros de una, por sus IDs. Un Deal con 20 renglones son
         * 20 productos: pedirlos de a uno serian 20 viajes con el reloj del
         * webhook corriendo.
         *
         * Los que no existen no vienen en la respuesta; no es un error.
         */
        async objetos(objeto, ids, propiedades = []) {
            if (!ids.length) return [];
            const salida = [];
            for (const tanda of trozos([...ids], 100)) {
                const d = await pedir(`/crm/v3/objects/${objeto}/batch/read`, {
                    metodo: 'POST',
                    body: { properties: propiedades, inputs: tanda.map((id) => ({ id: String(id) })) },
                });
                salida.push(...(d.results || []));
            }
            return salida;
        },

        /** Pipelines de un objeto, con sus etapas. De ahi sale cual es 'ganado'. */
        async pipelines(objeto) {
            const d = await pedir(`/crm/v3/pipelines/${objeto}`);
            return d.results || [];
        },

        /**
         * Busca registros con los filtros de HubSpot, una pagina por llamada.
         *
         * Distinto de `leerTodos`, que trae el objeto entero: aca el filtro lo
         * aplica HubSpot. Importa para el ensayo de negocios, que tiene que
         * poder mirar SOLO los negocios de un owner sin leer los de comercial.
         *
         * La paginacion queda afuera a proposito: el que llama decide si sigue,
         * y `after` va en el cuerpo.
         */
        buscar(objeto, cuerpo) {
            return pedir(`/crm/v3/objects/${objeto}/search`, { metodo: 'POST', body: cuerpo });
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
