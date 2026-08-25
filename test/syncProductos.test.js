'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sync = require('../src/lib/syncProductos');
const { crear } = require('../src/lib/mapper');
const mapeoProductos = require('../config/mapeo.productos.json');

const CLAVE = mapeoProductos._meta.claveIdempotencia.tango; // COD_STA11

const articulo = (cod, over = {}) => ({
    COD_STA11: cod,
    ID_STA11: Number(cod.replace(/\D/g, '')) || 1,
    DESCRIPCIO: `Articulo ${cod}`,
    STOCK: true,
    ...over,
});

// ── El filtro de la corrida de prueba ────────────────────────────────────

test('sin codigos, pasan todos', () => {
    const r = sync.filtrar([articulo('A1'), articulo('A2')], [], CLAVE);
    assert.strictEqual(r.registros.length, 2);
    assert.deepStrictEqual(r.noEncontrados, []);
});

test('con un codigo, pasa solo ese', () => {
    // El caso real: la primera corrida contra el ERP va con UN articulo.
    const r = sync.filtrar([articulo('A1'), articulo('A2'), articulo('A3')], ['A2'], CLAVE);
    assert.deepStrictEqual(r.registros.map((x) => x.COD_STA11), ['A2']);
});

test('un codigo que no existe se reporta, no se ignora', () => {
    // Si alguien escribe mal el codigo de prueba, el sync no puede terminar
    // diciendo "0 productos" como si estuviera todo bien.
    const r = sync.filtrar([articulo('A1')], ['A1', 'NO-EXISTE'], CLAVE);
    assert.deepStrictEqual(r.registros.map((x) => x.COD_STA11), ['A1']);
    assert.deepStrictEqual(r.noEncontrados, ['NO-EXISTE']);
});

test('el filtro ignora espacios de mas', () => {
    const r = sync.filtrar([articulo('A1')], ['  A1  '], CLAVE);
    assert.strictEqual(r.registros.length, 1);
});

test('leerSoloCodigos parte la lista y limpia', () => {
    assert.deepStrictEqual(sync.leerSoloCodigos('A1, A2 ,,A3 '), ['A1', 'A2', 'A3']);
    assert.deepStrictEqual(sync.leerSoloCodigos(''), []);
    assert.deepStrictEqual(sync.leerSoloCodigos(undefined), [], 'sin la variable, van todos');
});

// ── El precio, que es lo que no viene ────────────────────────────────────

test('el articulo se mapea sin precio, y no escribe un precio vacio', () => {
    // process=87 no trae precio en ninguno de sus 141 campos. Lo que importa es
    // que `price` NO viaje: escribir vacio pisaria un precio cargado a mano.
    const m = crear(mapeoProductos);
    const { propiedades } = m.aHubSpot(articulo('001'));
    assert.strictEqual(propiedades.price, undefined);
    assert.strictEqual(propiedades.hs_sku, '001', 'pero si viaja el SKU, que es la clave');
    assert.strictEqual(propiedades.tango_id_sta11, 1, 'y el ID interno, que es lo que necesita la Fase 4');
});

test('tango_id_sta11 es lo que destraba los renglones del pedido', () => {
    // El renglon necesita ID_STA11; el precio lo pone el line item del Deal.
    const m = crear(mapeoProductos);
    const { propiedades } = m.aHubSpot(articulo('123', { ID_STA11: 394 }));
    assert.strictEqual(propiedades.tango_id_sta11, 394);
});

// ── La corrida ───────────────────────────────────────────────────────────

test('leerConfig exige lo minimo y deja el dry-run como default', () => {
    assert.throws(() => sync.leerConfig({ TANGO_API_URL: 'x' }), /TANGO_API_KEY/);

    const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't' });
    assert.strictEqual(cfg.DRY_RUN, true);
    assert.deepStrictEqual(cfg.SOLO_CODIGOS, []);
    assert.strictEqual(cfg.TANGO_COMPANY, '1');
});

test('SYNC_PRODUCTOS_SOLO limita la corrida', () => {
    const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', SYNC_PRODUCTOS_SOLO: 'ART-001' });
    assert.deepStrictEqual(cfg.SOLO_CODIGOS, ['ART-001']);
});

test('solo un escritor: el dry-run es lo que sale por default', () => {
    for (const v of [undefined, 'true', 'TRUE', 'cualquier cosa']) {
        const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', SYNC_DRY_RUN: v });
        assert.strictEqual(cfg.DRY_RUN, true, `'${v}' no deberia habilitar la escritura`);
    }
    const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', SYNC_DRY_RUN: 'false' });
    assert.strictEqual(cfg.DRY_RUN, false, 'solo un false explicito escribe');
});

test('el hash evita reescribir un articulo que no cambio', () => {
    // Es lo mismo que hace el sync de clientes: sin el hash, cada corrida
    // reescribiria el catalogo entero.
    const m = crear(mapeoProductos);
    const a = articulo('001');
    const h1 = m.hash(m.aHubSpot(a).propiedades);
    const h2 = m.hash(m.aHubSpot(articulo('001')).propiedades);
    assert.strictEqual(h1, h2, 'el mismo articulo da el mismo hash');

    const h3 = m.hash(m.aHubSpot(articulo('001', { DESCRIPCIO: 'Otra cosa' })).propiedades);
    assert.notStrictEqual(h1, h3, 'y si cambia, cambia');
});
