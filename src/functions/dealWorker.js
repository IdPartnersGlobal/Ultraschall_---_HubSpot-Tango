'use strict';

const { app } = require('@azure/functions');
const logger = require('../lib/logger');
const dealToTango = require('../lib/dealToTango');
const cola = require('../lib/cola');
const tangoClient = require('../lib/tangoClient');
const hubspotClient = require('../lib/hubspotClient');
const lookups = require('../lib/lookups');

/**
 * Fase 4 — EL TRABAJO. Un mensaje = un negocio ganado = un pedido en Tango.
 *
 * El webhook (`functions/dealToTango`) ya valido la firma y que la etapa sea
 * ganada; aca no se vuelve a discutir eso. Lo que llega es un negocio que hay
 * que convertir en pedido, y este proceso puede tardar lo que tenga que tardar:
 * nadie del otro lado esta esperando con un cronometro. Ver ARQUITECTURA.md 9.5.
 *
 * ⚠️ La cola es *at-least-once*: el mismo mensaje puede llegar dos veces. Lo
 * primero que hace `procesarDeal` es mirar `tango_nro_pedido`, y por eso se
 * banca la repeticion. No sacar ese control.
 *
 * Que se reintenta y que no:
 *   - Un problema de DATOS (falta el ID de un producto, el cliente no se pudo
 *     crear) no se reintenta: `procesarDeal` lo escribe en el Deal y devuelve
 *     normal, asi que el mensaje se borra. Reintentar no lo va a arreglar.
 *   - Una falla de VERDAD (el ERP caido, HubSpot rechazando) se propaga: el
 *     mensaje vuelve a la cola y Azure lo reintenta hasta `maxDequeueCount`
 *     (host.json). Despues cae en la cola de veneno, que tiene su propia
 *     funcion y deja constancia en el Deal.
 */

/**
 * Las tablas auxiliares de Tango se cargan una vez por instancia y se guardan
 * un rato. Antes se cargaban una vez por TANDA de webhook; ahora cada mensaje
 * es una invocacion propia y sin esto seria una lectura completa del ERP por
 * cada negocio. No cambian en el dia.
 */
const TTL_LOOKUPS_MS = 30 * 60 * 1000;
let cacheLookups = null;

async function tablas(tango, log) {
    if (cacheLookups && Date.now() - cacheLookups.cuando < TTL_LOOKUPS_MS) return cacheLookups.valor;
    const valor = await lookups.cargar(tango, log);
    cacheLookups = { valor, cuando: Date.now() };
    return valor;
}

app.storageQueue('dealWorker', {
    queueName: cola.NOMBRE,
    connection: 'AzureWebJobsStorage',
    handler: async (entrada, context) => {
        const log = logger.crear(context, 'DEAL-W');

        const m = cola.leer(entrada);
        if (!m.ok) {
            // Un mensaje que no se entiende no se va a entender en el reintento
            // numero cinco: se descarta ahora y queda dicho por que.
            log.error('COLA', `mensaje descartado: ${m.motivo}`);
            return;
        }

        const intento = Number(context.triggerMetadata?.dequeueCount ?? 1);
        const espera = cola.demora(m.mensaje);
        log.inicio(`negocio ${m.dealId} (intento ${intento}${espera === null ? '' : `, espero ${espera} ms en la cola`})`);

        const config = dealToTango.leerConfig();
        const hs = hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });
        const tango = tangoClient.crear({
            baseUrl: config.TANGO_API_URL,
            apiKey: config.TANGO_API_KEY,
            company: config.TANGO_COMPANY,
            log,
        });

        const resultado = await dealToTango.procesarDeal({
            dealId: m.dealId,
            hs, tango,
            lookups: await tablas(tango, log),
            estrategiaNumeracion: config.TANGO_NUMERACION,
            log,
            dryRun: config.DRY_RUN,
        });

        log.datos('RESULTADO', {
            'negocio': m.dealId,
            'estado': resultado.estado,
            'pedido': resultado.nroPedido || '—',
            'motivo': resultado.motivo || '—',
            'modo': config.DRY_RUN ? 'DRY-RUN' : 'ESCRITURA REAL',
        });
        log.fin(resultado.estado);
    },
});

/**
 * La cola de veneno: los mensajes que fallaron `maxDequeueCount` veces.
 *
 * Sin esto, un negocio ganado que no se pudo mandar desaparece: el unico rastro
 * queda en Application Insights, donde comercial no entra, y el Deal se queda
 * "ganado" sin pedido y sin que nadie se entere. Es el mismo criterio que el
 * resto de la Fase 4 — los problemas se escriben en el Deal (9.3).
 *
 * Esta funcion NO reintenta nada: solo deja constancia.
 */
app.storageQueue('dealVeneno', {
    queueName: cola.NOMBRE_VENENO,
    connection: 'AzureWebJobsStorage',
    handler: async (entrada, context) => {
        const log = logger.crear(context, 'DEAL-V');

        const m = cola.leer(entrada);
        if (!m.ok) {
            log.error('VENENO', `mensaje ilegible en la cola de veneno: ${m.motivo}`);
            return;
        }

        const motivo = 'El pedido no se pudo crear despues de varios intentos. Revisar los logs de Azure (Application Insights) y volver a guardar el negocio para reintentar.';
        log.error('VENENO', `negocio ${m.dealId}: agotados los reintentos`);

        try {
            const config = dealToTango.leerConfig();
            const hs = hubspotClient.crear({ token: config.HUBSPOT_TOKEN, log });
            await hs.actualizarObjeto('deals', m.dealId, { [dealToTango.PROP_PROBLEMA]: motivo });
        } catch (e) {
            // Si tampoco se puede anotar, no hay a donde escalar: que quede en
            // el log y no se propague, o el mensaje rebota para siempre.
            log.error('VENENO', `tampoco se pudo anotar el problema en el negocio ${m.dealId}: ${e.message}`);
        }
    },
});
