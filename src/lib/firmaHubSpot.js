'use strict';

const crypto = require('node:crypto');

/**
 * Validacion de la firma v3 de HubSpot.
 *
 * Es la UNICA autenticacion del webhook de negocios ganados. La funcion tiene
 * que ser anonima porque HubSpot no manda API keys ni headers propios: sin
 * esta validacion, cualquiera que conozca la URL crea pedidos y clientes en
 * el ERP. Por eso vive en lib/ y esta testeada: es un control de seguridad,
 * no un detalle de plomeria.
 *
 * Algoritmo (developers.hubspot.com/docs/guides/apps/authentication/validating-requests):
 *   1. cadena = metodo + uri + cuerpo + timestamp   (UTF-8, en ese orden)
 *   2. HMAC-SHA256 con el CLIENT SECRET de la app, salida en base64
 *   3. Comparar contra el header X-HubSpot-Signature-v3
 *   4. Rechazar si el timestamp tiene mas de 5 minutos (anti-replay)
 *
 * El secreto es el client secret de la app, NO el token de private app que
 * usa hubspotClient. Son dos credenciales distintas.
 */

const HEADER_FIRMA = 'x-hubspot-signature-v3';
const HEADER_TIMESTAMP = 'x-hubspot-request-timestamp';
const VENTANA_MS = 5 * 60 * 1000;

/**
 * HubSpot firma la URI con algunos caracteres decodificados. Se decodifican
 * los de la lista y NADA mas: un decodeURIComponent() completo tocaria
 * tambien %20 y compania y la firma dejaria de coincidir.
 *
 * El '?' que abre el query string queda como esta.
 */
const DECODIFICAR = {
    '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
    '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

function normalizarUri(uri) {
    return String(uri).replace(/%[0-9A-Fa-f]{2}/g, (m) => DECODIFICAR[m.toUpperCase()] ?? m);
}

/** Comparacion en tiempo constante. Una comparacion normal filtra la firma. */
function igualesSeguro(a, b) {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/** La cadena que se firma. Expuesta aparte para poder testearla. */
function cadenaAFirmar({ metodo, uri, cuerpo, timestamp }) {
    return `${String(metodo).toUpperCase()}${normalizarUri(uri)}${cuerpo ?? ''}${timestamp}`;
}

function firmar({ metodo, uri, cuerpo, timestamp, secreto }) {
    return crypto
        .createHmac('sha256', secreto)
        .update(cadenaAFirmar({ metodo, uri, cuerpo, timestamp }), 'utf8')
        .digest('base64');
}

/**
 * @param {object} p
 * @param {string} p.metodo     metodo HTTP tal cual llego
 * @param {string} p.uri        URL completa, con esquema y host
 * @param {string} p.cuerpo     cuerpo CRUDO, sin parsear ni re-serializar
 * @param {object} p.headers    headers de la peticion
 * @param {string} p.secreto    client secret de la app
 * @param {number} [p.ahora]    epoch ms, inyectable para testear
 * @returns {{ ok: boolean, motivo?: string }}
 *
 * Nunca lanza: un webhook malformado es una respuesta 401, no un 500.
 * El motivo se loguea del lado nuestro; al que llama se le contesta 401 seco,
 * sin detalle, para no darle pistas a quien este probando.
 */
function validar({ metodo, uri, cuerpo, headers = {}, secreto, ahora = Date.now() }) {
    if (!secreto) return { ok: false, motivo: 'falta HUBSPOT_CLIENT_SECRET en la configuracion' };

    // Los headers pueden venir como objeto plano o como Headers de fetch.
    const leer = (n) => (typeof headers.get === 'function' ? headers.get(n) : headers[n] ?? headers[n.toLowerCase()]);

    const firma = leer(HEADER_FIRMA);
    const timestamp = leer(HEADER_TIMESTAMP);

    if (!firma) return { ok: false, motivo: `falta el header ${HEADER_FIRMA}` };
    if (!timestamp) return { ok: false, motivo: `falta el header ${HEADER_TIMESTAMP}` };

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, motivo: 'timestamp no numerico' };

    // Anti-replay. Se controla tambien el futuro: un timestamp adelantado
    // extenderia la ventana de reuso de una firma capturada.
    const edad = ahora - ts;
    if (edad > VENTANA_MS) return { ok: false, motivo: `peticion vencida (${Math.round(edad / 1000)}s)` };
    if (edad < -VENTANA_MS) return { ok: false, motivo: 'timestamp en el futuro' };

    const esperada = firmar({ metodo, uri, cuerpo, timestamp, secreto });
    if (!igualesSeguro(firma, esperada)) return { ok: false, motivo: 'la firma no coincide' };

    return { ok: true };
}

module.exports = {
    validar, firmar, cadenaAFirmar, normalizarUri, igualesSeguro,
    HEADER_FIRMA, HEADER_TIMESTAMP, VENTANA_MS,
};
