'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const firma = require('../src/lib/firmaHubSpot');

const SECRETO = 'client-secret-de-prueba';
const URI = 'https://ultraschall.azurewebsites.net/api/dealToTango';
const CUERPO = JSON.stringify([{ objectId: 123, propertyName: 'dealstage', propertyValue: 'closedwon' }]);

/** Arma una peticion firmada como la mandaria HubSpot. */
function peticion({ ahora = Date.now(), secreto = SECRETO, cuerpo = CUERPO, uri = URI, metodo = 'POST' } = {}) {
    const timestamp = String(ahora);
    return {
        metodo, uri, cuerpo,
        headers: {
            'x-hubspot-signature-v3': firma.firmar({ metodo, uri, cuerpo, timestamp, secreto }),
            'x-hubspot-request-timestamp': timestamp,
        },
    };
}

test('una peticion legitima de HubSpot valida', () => {
    const r = firma.validar({ ...peticion(), secreto: SECRETO });
    assert.strictEqual(r.ok, true, r.motivo);
});

test('la cadena a firmar es metodo + uri + cuerpo + timestamp, en ese orden', () => {
    assert.strictEqual(
        firma.cadenaAFirmar({ metodo: 'post', uri: 'https://a/b', cuerpo: '{"x":1}', timestamp: '1700000000000' }),
        'POSThttps://a/b{"x":1}1700000000000'
    );
});

test('un cuerpo alterado invalida la firma', () => {
    // El caso real que esto ataja: alguien intercepta el webhook y cambia el
    // negocio o los renglones antes de reenviarlo.
    const p = peticion();
    p.cuerpo = JSON.stringify([{ objectId: 999, propertyName: 'dealstage', propertyValue: 'closedwon' }]);
    const r = firma.validar({ ...p, secreto: SECRETO });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /no coincide/);
});

test('una firma de otro secreto no vale', () => {
    const r = firma.validar({ ...peticion({ secreto: 'otro-secreto' }), secreto: SECRETO });
    assert.strictEqual(r.ok, false);
});

test('la URI es parte de la firma: no se puede reapuntar a otro endpoint', () => {
    const p = peticion();
    p.uri = 'https://ultraschall.azurewebsites.net/api/otraCosa';
    assert.strictEqual(firma.validar({ ...p, secreto: SECRETO }).ok, false);
});

// ------------------------------------------------------------------ replay

test('una peticion de mas de 5 minutos se rechaza', () => {
    const hace6min = Date.now() - 6 * 60 * 1000;
    const r = firma.validar({ ...peticion({ ahora: hace6min }), secreto: SECRETO });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /vencida/);
});

test('a los 4 minutos todavia vale', () => {
    const hace4min = Date.now() - 4 * 60 * 1000;
    assert.strictEqual(firma.validar({ ...peticion({ ahora: hace4min }), secreto: SECRETO }).ok, true);
});

test('un timestamp adelantado tambien se rechaza', () => {
    // Sin este control, una firma capturada se podria reusar por mas tiempo.
    const dentroDe10 = Date.now() + 10 * 60 * 1000;
    const r = firma.validar({ ...peticion({ ahora: dentroDe10 }), secreto: SECRETO });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /futuro/);
});

test('el timestamp esta firmado: cambiarlo para revivir una peticion no sirve', () => {
    const vieja = peticion({ ahora: Date.now() - 60 * 60 * 1000 });
    vieja.headers['x-hubspot-request-timestamp'] = String(Date.now()); // se "actualiza"
    const r = firma.validar({ ...vieja, secreto: SECRETO });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /no coincide/);
});

// ------------------------------------------------------- entradas invalidas

test('nunca lanza: un webhook malformado es un 401, no un 500', () => {
    const casos = [
        {},
        { headers: {} },
        { headers: { 'x-hubspot-signature-v3': 'abc' } },
        { headers: { 'x-hubspot-request-timestamp': 'no-es-un-numero', 'x-hubspot-signature-v3': 'abc' } },
        { metodo: null, uri: null, cuerpo: null, headers: { 'x-hubspot-signature-v3': 'a', 'x-hubspot-request-timestamp': String(Date.now()) } },
    ];
    for (const c of casos) {
        const r = firma.validar({ ...c, secreto: SECRETO });
        assert.strictEqual(r.ok, false);
        assert.ok(r.motivo);
    }
});

test('sin secreto configurado no valida nada', () => {
    // Falla cerrado: si falta la variable de entorno, no se acepta la peticion.
    const r = firma.validar({ ...peticion(), secreto: undefined });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /HUBSPOT_CLIENT_SECRET/);
});

test('la comparacion no se rompe con firmas de otro largo', () => {
    const p = peticion();
    p.headers['x-hubspot-signature-v3'] = 'corta';
    assert.strictEqual(firma.validar({ ...p, secreto: SECRETO }).ok, false);
});

// ------------------------------------------------------------------- uri

test('decodifica solo los caracteres de la lista de HubSpot', () => {
    assert.strictEqual(firma.normalizarUri('https%3A%2F%2Fa.com%2Fb'), 'https://a.com/b');
    assert.strictEqual(firma.normalizarUri('/api/x?a=1%20b'), '/api/x?a=1%20b', '%20 NO se decodifica');
});

test('igualesSeguro compara de verdad', () => {
    assert.strictEqual(firma.igualesSeguro('abc', 'abc'), true);
    assert.strictEqual(firma.igualesSeguro('abc', 'abd'), false);
    assert.strictEqual(firma.igualesSeguro('abc', 'abcd'), false);
});
