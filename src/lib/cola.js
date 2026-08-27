'use strict';

/**
 * Riesgo 5 — el webhook tiene que contestar rapido.
 *
 * Antes el hook hacia todo el trabajo y recien despues contestaba: leer el
 * Deal, la company, los renglones, dar de alta el cliente en Tango y crear el
 * pedido. Eso son varios segundos contra dos sistemas ajenos, y HubSpot no
 * espera tanto: corta y reintenta la tanda ENTERA. La idempotencia lo tapaba
 * (el segundo intento ve `tango_nro_pedido` y no hace nada), pero tapar no es
 * resolver: si el primer intento todavia esta a mitad de camino, el segundo no
 * ve nada escrito y arranca de nuevo en paralelo.
 *
 * Ahora el hook valida, encola y contesta; el trabajo lo hace `dealWorker`
 * cuando le toca. Este modulo es lo unico que los dos comparten: el nombre de
 * la cola y la forma del mensaje. Vive en lib/ y no en functions/ para poder
 * testearlo sin levantar Azure.
 *
 * ⚠️ La cola es *at-least-once*: el mismo mensaje puede llegar dos veces (una
 * entrega que tardo mas que el `visibilityTimeout` vuelve a la cola). Por eso
 * el control de idempotencia de `procesarDeal` sigue siendo obligatorio, no es
 * un resto de la version anterior.
 */

/**
 * El nombre se puede pisar por entorno, pero el trigger y la salida tienen que
 * leer el MISMO: si se separan, el hook encola en una cola que nadie escucha y
 * no hay error en ningun lado.
 *
 * Reglas de Azure para nombres de cola: minusculas, numeros y guiones.
 */
const NOMBRE = String(process.env.DEAL_COLA_NOMBRE || 'deals-ganados').toLowerCase();

/** La cola de veneno la arma Azure con este sufijo; el nombre no es elegible. */
const NOMBRE_VENENO = `${NOMBRE}-poison`;

/**
 * Version del mensaje. Si algun dia cambia la forma, los mensajes viejos que
 * quedaron en la cola durante el despliegue se descartan con un motivo claro
 * en vez de romper el worker.
 */
const VERSION = 1;

/**
 * Los mensajes a encolar para una tanda de eventos ya admitidos.
 *
 * HubSpot puede mandar varios eventos del mismo Deal en la misma tanda (dos
 * cambios de etapa seguidos, o un reintento suyo). Encolarlos todos seria
 * procesar el mismo negocio N veces: se deja UNO por Deal, el mas reciente.
 *
 * @param {Array} eventos  los que devolvio `dealToTango.admitir`
 * @returns {Array<object>} un mensaje por Deal distinto
 */
function mensajes(eventos, ahora = new Date()) {
    const porDeal = new Map();

    for (const e of eventos || []) {
        const dealId = String(e?.objectId ?? '').trim();
        if (!dealId) continue;

        const previo = porDeal.get(dealId);
        // Sin `occurredAt` vale el ultimo que llego: el orden del array es el
        // unico dato que queda.
        if (previo && Number(previo.occurredAt || 0) > Number(e.occurredAt || 0)) continue;
        porDeal.set(dealId, e);
    }

    return [...porDeal.values()].map((e) => ({
        v: VERSION,
        dealId: String(e.objectId),
        etapa: e.propertyValue ?? null,
        // Para poder correlacionar en Application Insights con lo que muestra
        // HubSpot en el detalle del webhook.
        eventId: e.eventId ?? null,
        portalId: e.portalId ?? null,
        occurredAt: e.occurredAt ?? null,
        encoladoEn: ahora.toISOString(),
    }));
}

/**
 * Lee un mensaje de la cola. Nunca lanza.
 *
 * Un mensaje que no se entiende NO se puede reintentar: reintentarlo cinco
 * veces y mandarlo a la cola de veneno seria ruido. Se devuelve `ok: false` y
 * el worker lo descarta dejando dicho por que.
 *
 * @returns {{ok:boolean, dealId?:string, mensaje?:object, motivo?:string}}
 */
function leer(entrada) {
    let m = entrada;

    // El trigger de Azure entrega el mensaje ya parseado cuando es JSON valido,
    // pero no siempre: si alguien encola a mano llega el texto crudo.
    if (typeof m === 'string') {
        try {
            m = JSON.parse(m);
        } catch {
            return { ok: false, motivo: 'el mensaje no es JSON' };
        }
    }

    if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return { ok: false, motivo: 'el mensaje no es un objeto' };
    }
    if (Number(m.v) !== VERSION) {
        return { ok: false, motivo: `version de mensaje desconocida: ${m.v}` };
    }

    const dealId = String(m.dealId ?? '').trim();
    if (!dealId) return { ok: false, motivo: 'el mensaje no trae dealId' };

    return { ok: true, dealId, mensaje: m };
}

/**
 * Cuanto espero el mensaje en la cola, en milisegundos.
 * Es la medida de si el desacople alcanza o si hay que mirar la concurrencia.
 */
function demora(mensaje, ahora = new Date()) {
    const t = Date.parse(mensaje?.encoladoEn ?? '');
    if (Number.isNaN(t)) return null;
    return Math.max(0, ahora.getTime() - t);
}

module.exports = { NOMBRE, NOMBRE_VENENO, VERSION, mensajes, leer, demora };
