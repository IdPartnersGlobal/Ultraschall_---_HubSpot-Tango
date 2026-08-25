'use strict';

const { app } = require('@azure/functions');
const logger = require('../lib/logger');
const dealToTango = require('../lib/dealToTango');
const etapas = require('../lib/etapas');
const tangoClient = require('../lib/tangoClient');
const hubspotClient = require('../lib/hubspotClient');
const lookups = require('../lib/lookups');

/**
 * Fase 4 — negocio ganado en HubSpot -> pedido en Tango.
 *
 * ANONIMA a proposito: el disparador son webhooks de la app sobre cambio de
 * etapa (decision del 2026-08-21), y HubSpot no puede mandar API keys ni
 * headers propios. La autenticacion real es la firma v3, en lib/firmaHubSpot.
 *
 * ⚠️ La URL no lleva query params: la firma cubre la URI completa y cualquier
 * parametro agregado por el camino la rompe (ARQUITECTURA.md 10.2).
 *
 * ⚠️ El cuerpo se valida CRUDO, antes de parsearlo. Parsear y re-serializar
 * cambia el JSON y la firma deja de coincidir.
 *
 * 🟡 Riesgo 5 sin resolver: hoy contesta despues de hacer el trabajo. Un alta
 * de cliente mas el pedido pueden pasarse del tiempo que HubSpot espera, y
 * entonces reintenta. Por ahora lo cubre la idempotencia —el segundo intento
 * ve `tango_nro_pedido` cargado y no hace nada—, pero la solucion de fondo es
 * contestar 200 y encolar.
 */

const HABILITADO = String(process.env.DEAL_TO_TANGO_ENABLED || 'false').toLowerCase() === 'true';

/** Las etapas ganadas se leen una vez y se guardan: no cambian seguido. */
let ganadasCache = null;

async function etapasGanadas(hs, log) {
    if (ganadasCache) return ganadasCache;
    try {
        ganadasCache = etapas.desdePipelines(await hs.pipelines('deals'));
        log.paso('ETAPAS', `etapas ganadas: ${[...ganadasCache].join(', ')}`);
    } catch (e) {
        // Si HubSpot no contesta, se sigue con las conocidas: es preferible a
        // rechazar un negocio ganado de verdad.
        ganadasCache = etapas.GANADAS;
        log.aviso('ETAPAS', `no se pudieron leer los pipelines (${e.message}); se usan las conocidas`);
    }
    return ganadasCache;
}

app.http('dealToTango', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const log = logger.crear(context, 'DEAL');

        // El cuerpo crudo, sin parsear. Es lo que se firma.
        const cuerpoCrudo = await request.text();

        const config = dealToTango.leerConfig();
        const hs = hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });

        const admision = dealToTango.admitir({
            metodo: request.method,
            uri: request.url,
            cuerpoCrudo,
            headers: request.headers,
            secreto: config.HUBSPOT_CLIENT_SECRET,
            ganadas: await etapasGanadas(hs, log),
        });

        if (admision.status === 401) {
            // 401 seco, sin detalle: no se le dan pistas a quien este probando.
            // El motivo queda de nuestro lado.
            log.error('AUTH', `peticion rechazada: ${admision.motivo}`);
            return { status: 401, body: '' };
        }

        if (admision.status === 204) {
            log.paso('DEAL', admision.motivo);
            return { status: 204 };
        }

        if (!HABILITADO) {
            // Mismo criterio que el timer: desplegar el codigo y activar algo
            // que escribe en el ERP son dos decisiones distintas.
            log.aviso('DEAL', `${admision.eventos.length} negocio(s) ganado(s), pero DEAL_TO_TANGO_ENABLED != true. No se hace nada.`);
            return { status: 204 };
        }

        log.inicio(`${admision.eventos.length} negocio(s) ganado(s)`);

        const tango = tangoClient.crear({
            baseUrl: config.TANGO_API_URL,
            apiKey: config.TANGO_API_KEY,
            company: config.TANGO_COMPANY,
            log,
        });
        const tablas = await lookups.cargar(tango, log);

        const resultados = [];
        for (const evento of admision.eventos) {
            const dealId = String(evento.objectId);
            try {
                resultados.push(await dealToTango.procesarDeal({
                    dealId, hs, tango, lookups: tablas,
                    estrategiaNumeracion: config.TANGO_NUMERACION,
                    log, dryRun: config.DRY_RUN,
                }));
            } catch (e) {
                // Se sigue con los demas eventos: que un negocio falle no puede
                // llevarse puestos a los otros que vinieron en la misma tanda.
                log.error('DEAL', `${dealId} fallo: ${e.message}`);
                resultados.push({ dealId, estado: 'error', motivo: e.message });
            }
        }

        const hubo = (e) => resultados.filter((r) => r.estado === e).length;
        log.datos('RESUMEN', {
            'creados': hubo('creado'),
            'ya tenian pedido': hubo('ya-tenia'),
            'incompletos': hubo('incompleto'),
            'con error': hubo('error'),
            'modo': config.DRY_RUN ? 'DRY-RUN' : 'ESCRITURA REAL',
        });

        // 200 aunque alguno haya fallado: si se devolviera un error, HubSpot
        // reintentaria la tanda entera, incluidos los que si se crearon.
        return { status: 200, jsonBody: { procesados: resultados.length, resultados } };
    },
});
