'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cola = require('../src/lib/cola');
const d2t = require('../src/lib/dealToTango');
const firma = require('../src/lib/firmaHubSpot');

const SECRETO = 'client-secret-de-prueba';
const URI = 'https://ultraschall.azurewebsites.net/api/dealToTango';

/** Una peticion firmada como la manda HubSpot. */
function peticion(cuerpo, { ahora = Date.now() } = {}) {
    const cuerpoCrudo = JSON.stringify(cuerpo);
    const timestamp = String(ahora);
    return {
        metodo: 'POST', uri: URI, cuerpoCrudo, secreto: SECRETO, ahora,
        headers: {
            'x-hubspot-signature-v3': firma.firmar({ metodo: 'POST', uri: URI, cuerpo: cuerpoCrudo, timestamp, secreto: SECRETO }),
            'x-hubspot-request-timestamp': timestamp,
        },
    };
}

const evento = (objectId, extra = {}) => ({
    objectId, propertyName: 'dealstage', propertyValue: 'closedwon',
    subscriptionType: 'object.propertyChange', ...extra,
});

// ── El nombre de la cola ─────────────────────────────────────────────────

test('el nombre de la cola cumple las reglas de Azure', () => {
    // Minusculas, numeros y guiones, entre 3 y 63. Un nombre invalido no falla
    // al desplegar: falla al primer mensaje, en produccion.
    assert.match(cola.NOMBRE, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
});

test('la cola de veneno es la de Azure, no una inventada', () => {
    // Azure la arma con el sufijo -poison y el nombre no es elegible: si aca se
    // pusiera otro, la funcion escucharia una cola que nunca recibe nada.
    assert.strictEqual(cola.NOMBRE_VENENO, `${cola.NOMBRE}-poison`);
});

// ── Armado del mensaje ───────────────────────────────────────────────────

test('un evento ganado se convierte en un mensaje con lo justo', () => {
    const ahora = new Date('2026-08-26T12:00:00.000Z');
    const [m] = cola.mensajes([evento(111, { eventId: 9, portalId: 51311915, occurredAt: 1756209600000 })], ahora);

    assert.strictEqual(m.v, cola.VERSION);
    assert.strictEqual(m.dealId, '111', 'el id viaja como texto, igual que en todo el resto del circuito');
    assert.strictEqual(m.etapa, 'closedwon');
    assert.strictEqual(m.eventId, 9);
    assert.strictEqual(m.encoladoEn, '2026-08-26T12:00:00.000Z');
});

test('el mismo negocio dos veces en la tanda se encola UNA sola vez', () => {
    // HubSpot manda un evento por cambio de propiedad, y puede mandar dos del
    // mismo Deal juntos. Encolar los dos seria procesar el negocio dos veces.
    const ms = cola.mensajes([
        evento(111, { occurredAt: 100 }),
        evento(111, { occurredAt: 300 }),
        evento(222, { occurredAt: 200 }),
    ]);
    assert.deepStrictEqual(ms.map((m) => m.dealId), ['111', '222']);
});

test('del negocio repetido se queda el evento mas reciente', () => {
    const ms = cola.mensajes([
        evento(111, { occurredAt: 300, eventId: 'nuevo' }),
        evento(111, { occurredAt: 100, eventId: 'viejo' }),
    ]);
    assert.strictEqual(ms[0].eventId, 'nuevo', 'no gana el que llego primero, gana el mas nuevo');
});

test('sin occurredAt gana el ultimo del array', () => {
    const ms = cola.mensajes([evento(111, { eventId: 'a' }), evento(111, { eventId: 'b' })]);
    assert.strictEqual(ms[0].eventId, 'b');
});

test('un evento sin objectId no se encola', () => {
    assert.deepStrictEqual(cola.mensajes([{ propertyName: 'dealstage' }]), []);
    assert.deepStrictEqual(cola.mensajes([]), []);
    assert.deepStrictEqual(cola.mensajes(undefined), []);
});

// ── Lectura del mensaje ──────────────────────────────────────────────────

test('el mensaje se lee venga como objeto o como texto', () => {
    // El trigger de Azure lo entrega parseado cuando es JSON valido, pero no
    // siempre: encolado a mano llega crudo.
    const [m] = cola.mensajes([evento(111)]);
    assert.strictEqual(cola.leer(m).dealId, '111');
    assert.strictEqual(cola.leer(JSON.stringify(m)).dealId, '111');
});

test('un mensaje que no se entiende se descarta, no se reintenta', () => {
    // Reintentarlo cinco veces y mandarlo a la cola de veneno seria ruido: no
    // se va a entender mejor en el intento cinco.
    assert.strictEqual(cola.leer('{no es json').ok, false);
    assert.strictEqual(cola.leer(null).ok, false);
    assert.strictEqual(cola.leer([1, 2]).ok, false, 'un array no es un mensaje');
    assert.strictEqual(cola.leer({ v: 1 }).ok, false, 'sin dealId no hay nada que procesar');
});

test('un mensaje de otra version se descarta con motivo', () => {
    // Pasa durante un despliegue: quedan mensajes viejos en la cola.
    const r = cola.leer({ v: 99, dealId: '111' });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /version/);
});

test('la demora en la cola se puede medir, y un mensaje sin fecha no rompe', () => {
    const ahora = new Date('2026-08-26T12:00:05.000Z');
    assert.strictEqual(cola.demora({ encoladoEn: '2026-08-26T12:00:00.000Z' }, ahora), 5000);
    assert.strictEqual(cola.demora({}, ahora), null);
});

// ── La puerta: admitir y encolar ─────────────────────────────────────────

test('de una tanda mixta se encolan solo los negocios ganados', () => {
    const admision = d2t.admitir(peticion([
        evento(1),
        { objectId: 2, propertyName: 'dealstage', propertyValue: 'closedlost' },
        evento(3, { propertyValue: '1376134021' }),
        { objectId: 4, propertyName: 'amount', propertyValue: '5' },
    ]));

    assert.strictEqual(admision.status, 200);
    assert.deepStrictEqual(cola.mensajes(admision.eventos).map((m) => m.dealId), ['1', '3'], 'incluye el ganado de Licitaciones');
});

test('lo que se rechaza no llega a la cola', () => {
    const p = peticion([evento(1)]);
    p.headers['x-hubspot-signature-v3'] = 'firma-falsa';
    const admision = d2t.admitir(p);
    assert.strictEqual(admision.status, 401);
    assert.strictEqual(admision.eventos, undefined, 'sin eventos no hay nada que encolar');
});

// ── Configuracion de la puerta ───────────────────────────────────────────

test('el webhook NO exige la configuracion de Tango', () => {
    // Desde que encola, el hook no habla con el ERP. Si le pidiera igual las
    // variables de Tango contestaria 500 y HubSpot reintentaria, por una
    // configuracion que no iba a usar.
    const cfg = d2t.leerConfigWebhook({ HUBSPOT_CLIENT_SECRET: 'x' });
    assert.strictEqual(cfg.HUBSPOT_CLIENT_SECRET, 'x');
    assert.strictEqual(cfg.HUBSPOT_TOKEN, null, 'sin token se usan las etapas conocidas y el hook igual contesta');
});

test('sin client secret no se puede validar nada: el webhook no arranca', () => {
    assert.throws(() => d2t.leerConfigWebhook({ HUBSPOT_TOKEN: 'x' }), /HUBSPOT_CLIENT_SECRET/);
});

test('el interruptor esta apagado salvo que diga true explicitamente', () => {
    const base = { HUBSPOT_CLIENT_SECRET: 'x' };
    assert.strictEqual(d2t.leerConfigWebhook(base).HABILITADO, false);
    assert.strictEqual(d2t.leerConfigWebhook({ ...base, DEAL_TO_TANGO_ENABLED: 'TRUE' }).HABILITADO, true);
    assert.strictEqual(d2t.leerConfigWebhook({ ...base, DEAL_TO_TANGO_ENABLED: '1' }).HABILITADO, false, 'solo true, nada de valores parecidos');
});
