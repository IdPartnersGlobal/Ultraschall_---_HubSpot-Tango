'use strict';

const test = require('node:test');
const assert = require('node:assert');

/**
 * Quien puede golpear cada endpoint HTTP.
 *
 * Existe porque el `authLevel` es una linea suelta en un archivo que casi no se
 * toca, y es la unica cosa que decide si el ERP de produccion esta abierto a
 * internet. Una mutacion que lo volviera 'anonymous' no la agarraba ningun
 * test: el 2026-09-16 se probo y paso limpia.
 *
 * Se registra de verdad: se le presta `app.http` al modulo y se mira con que
 * se registro, en vez de leer el archivo como texto.
 */

const azure = require('@azure/functions');

/** Deja que el modulo se registre y devuelve lo que registro. */
function registrar(modulo) {
    const registros = [];
    const originalHttp = azure.app.http;
    azure.app.http = (nombre, opciones) => { registros.push({ nombre, opciones }); };
    try {
        delete require.cache[require.resolve(modulo)];
        require(modulo);
    } finally {
        azure.app.http = originalHttp;
    }
    return registros;
}

test('el proxy de Tango pide clave de funcion', () => {
    // 2026-09-16 (10.0.1), a pedido de Matias. Estuvo anonimo mientras Azure
    // leia la COPIA; cuando paso a leer produccion, con relevamiento y
    // escritura encendidos, cualquiera con la URL podia crear y borrar en el
    // ERP real.
    const [reg] = registrar('../src/functions/testTangoConnection');
    assert.strictEqual(reg.nombre, 'testTangoConnection');
    assert.strictEqual(reg.opciones.authLevel, 'function');
});

test('el webhook de HubSpot sigue anonimo, y por eso la firma es obligatoria', () => {
    // No es un descuido: HubSpot no manda claves de funcion. La autenticacion
    // real es la firma v3 (lib/firmaHubSpot), y sin ella el handler contesta
    // 401 seco. Si algun dia esto pasara a 'function', HubSpot dejaria de
    // poder llamarlo.
    const [reg] = registrar('../src/functions/dealToTango');
    assert.strictEqual(reg.nombre, 'dealToTango');
    assert.strictEqual(reg.opciones.authLevel, 'anonymous');
    assert.deepStrictEqual(reg.opciones.methods, ['POST']);

    const dealToTango = require('../src/lib/dealToTango');
    const firma = require('../src/lib/firmaHubSpot');
    const SECRETO = 'client-secret-de-prueba';
    const URI = 'https://ultraschall.azurewebsites.net/api/dealToTango';
    const CUERPO = '[]';
    const peticion = { metodo: 'POST', uri: URI, cuerpoCrudo: CUERPO, secreto: SECRETO };

    const sinFirma = dealToTango.admitir({ ...peticion, headers: {} });
    assert.strictEqual(sinFirma.status, 401, 'sin firma no entra');

    // Y con la firma correcta SI entra: si no, el 401 de arriba no probaria nada.
    const timestamp = String(Date.now());
    const conFirma = dealToTango.admitir({
        ...peticion,
        headers: {
            'x-hubspot-signature-v3': firma.firmar({ metodo: 'POST', uri: URI, cuerpo: CUERPO, timestamp, secreto: SECRETO }),
            'x-hubspot-request-timestamp': timestamp,
        },
    });
    assert.notStrictEqual(conFirma.status, 401, `la firma valida deberia pasar: ${conFirma.motivo}`);
});
