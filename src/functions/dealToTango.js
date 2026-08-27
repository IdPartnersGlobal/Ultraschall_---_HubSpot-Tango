'use strict';

const { app, output } = require('@azure/functions');
const logger = require('../lib/logger');
const dealToTango = require('../lib/dealToTango');
const etapas = require('../lib/etapas');
const cola = require('../lib/cola');
const hubspotClient = require('../lib/hubspotClient');

/**
 * Fase 4 — negocio ganado en HubSpot -> pedido en Tango. LA PUERTA.
 *
 * Esta funcion NO crea el pedido. Valida quien golpea, descarta lo que no
 * corresponde y encola un mensaje por negocio ganado; el trabajo lo hace
 * `dealWorker`. Es la respuesta al riesgo 5: antes contestaba recien despues
 * de hablar con HubSpot y con Tango, y si tardaba de mas HubSpot cortaba y
 * reintentaba la tanda entera. Ver lib/cola.js y ARQUITECTURA.md 9.5.
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
 */

const salida = output.storageQueue({
    queueName: cola.NOMBRE,
    connection: 'AzureWebJobsStorage',
});

/** Las etapas ganadas se leen una vez y se guardan: no cambian seguido. */
let ganadasCache = null;

async function etapasGanadas(hs, log) {
    if (ganadasCache) return ganadasCache;
    if (!hs) return (ganadasCache = etapas.GANADAS);
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
    extraOutputs: [salida],
    handler: async (request, context) => {
        const log = logger.crear(context, 'DEAL');

        // El cuerpo crudo, sin parsear. Es lo que se firma.
        const cuerpoCrudo = await request.text();

        const config = dealToTango.leerConfigWebhook();
        const hs = config.HUBSPOT_TOKEN
            ? hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log })
            : null;

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

        if (!config.HABILITADO) {
            // Mismo criterio que el timer: desplegar el codigo y activar algo
            // que escribe en el ERP son dos decisiones distintas. El freno esta
            // ACA y en un solo lugar; el worker no lo mira, para que apagarlo
            // nunca se coma mensajes que ya estaban encolados.
            log.aviso('DEAL', `${admision.eventos.length} negocio(s) ganado(s), pero DEAL_TO_TANGO_ENABLED != true. No se encola nada.`);
            return { status: 204 };
        }

        const aEncolar = cola.mensajes(admision.eventos);
        context.extraOutputs.set(salida, aEncolar);

        log.paso('DEAL', `encolados ${aEncolar.length} negocio(s) en '${cola.NOMBRE}': ${aEncolar.map((m) => m.dealId).join(', ')}`);

        // 202: recibido y aceptado, todavia no hecho. Es lo unico honesto que
        // se puede contestar, y a HubSpot le alcanza con un 2xx.
        return { status: 202, jsonBody: { encolados: aEncolar.length, dealIds: aEncolar.map((m) => m.dealId) } };
    },
});
