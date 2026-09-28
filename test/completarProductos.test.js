'use strict';

const test = require('node:test');
const assert = require('node:assert');

const completar = require('../src/lib/completarProductos');
const { crear } = require('../src/lib/mapper');
const mapeoProductos = require('../config/mapeo.productos.json');

/**
 * La pasada unica sobre los productos que subio Ultraschall (2026-09-22):
 * completa los datos de Tango por el SKU, sin crear, sin tocar lo que ellos
 * cargaron y sin hacer de sync. Los codigos imitan los reales (BT200, LX85).
 */

const m = crear(mapeoProductos);
const articulo = (cod, over = {}) => ({ COD_STA11: cod, ID_STA11: 500, DESCRIPCIO: `EQUIPO ${cod}`, STOCK: true, ...over });
const producto = (id, sku, over = {}) => ({ id, properties: { name: `Equipo ${sku}`, hs_sku: sku, price: '1000', ...over } });
const plan = (registros, productos) => completar.planificar({ registros, productos, m });
const porId = (p, id) => p.updates.find((u) => u.id === id)?.properties;

test('un producto cuyo SKU es un codigo de Tango recibe el ID interno', () => {
    const p = plan([articulo('BT200', { ID_STA11: 394 })], [producto('p1', 'BT200')]);
    assert.strictEqual(porId(p, 'p1').tango_id_sta11, 394, 'es lo que usa el renglon del pedido');
    assert.strictEqual(p.filas[0].resultado, completar.RESULTADO.COMPLETA);
});

test('solo se escriben propiedades de Tango: ni nombre, ni descripcion, ni precio, ni SKU', () => {
    const p = plan([articulo('BT200', { DESC_ADIC: 'texto de Tango' })], [producto('p1', 'BT200', { name: 'Detector fetal Bistos BT-200', price: '' })]);
    const w = porId(p, 'p1');
    for (const k of Object.keys(w)) assert.ok(k.startsWith('tango_'), `'${k}' no es del grupo Tango: lo cargo Ultraschall`);
    assert.strictEqual(w.price, undefined, 'aunque este vacio: el precio es de comercial (y no tiene moneda)');
});

test('no marca el producto como sincronizado: ni hash ni fecha', () => {
    const w = porId(plan([articulo('BT200')], [producto('p1', 'BT200')]), 'p1');
    assert.strictEqual(w.tango_sync_hash, undefined);
    assert.strictEqual(w.tango_ultima_sync, undefined);
});

test('solo llena vacios: lo que ya tiene valor no se pisa', () => {
    const p = plan([articulo('BT200', { COD_NCM: '9018.12' })], [producto('p1', 'BT200', { tango_ncm: 'cargado a mano' })]);
    assert.strictEqual(porId(p, 'p1').tango_ncm, undefined);
    assert.ok(p.resumen.respetados >= 1);
});

test('si ya tiene OTRO ID interno no se toca nada: no se decide solo', () => {
    const p = plan([articulo('BT200', { ID_STA11: 394 })], [producto('p1', 'BT200', { tango_id_sta11: '777' })]);
    assert.strictEqual(porId(p, 'p1'), undefined);
    assert.strictEqual(p.filas[0].resultado, completar.RESULTADO.OTRO_ID);
});

test('con el mismo ID y todo cargado, no hay nada que escribir', () => {
    const primera = porId(plan([articulo('BT200')], [producto('p1', 'BT200')]), 'p1');
    const p = plan([articulo('BT200')], [producto('p1', 'BT200', primera)]);
    assert.strictEqual(p.updates.length, 0);
    assert.strictEqual(p.filas[0].resultado, completar.RESULTADO.YA_ESTABA);
});

test('el SKU se compara tal cual: un parecido se informa y no se escribe', () => {
    const p = plan([articulo('BT-200'), articulo('LX85')], [producto('p1', 'bt200'), producto('p2', ' LX85 '), producto('p3', '123'), producto('p4', '')]);
    assert.strictEqual(porId(p, 'p1'), undefined);
    assert.strictEqual(p.filas[0].resultado, completar.RESULTADO.PARECIDO);
    assert.deepStrictEqual(p.filas[0].parecidos, ['BT-200'], 'dice a cual se parece');
    assert.ok(porId(p, 'p2'), 'los espacios de los costados no son parte del codigo');
    assert.strictEqual(p.filas[2].resultado, completar.RESULTADO.NO_EXISTE);
    assert.strictEqual(p.filas[3].resultado, completar.RESULTADO.SIN_SKU);
});

test('no crea productos: un articulo de Tango sin producto en HubSpot no aparece', () => {
    const p = plan([articulo('BT200'), articulo('OTRO1')], [producto('p1', 'BT200')]);
    assert.deepStrictEqual(p.updates.map((u) => u.id), ['p1']);
});

test('un SKU repetido en HubSpot se completa en los dos, y se avisa', () => {
    const p = plan([articulo('BT200')], [producto('p1', 'BT200'), producto('p2', 'BT200')]);
    assert.deepStrictEqual(p.updates.map((u) => u.id), ['p1', 'p2']);
    assert.ok(p.filas.every((f) => f.repetido));
});

test('las palabras en comun marcan un SKU que puede ser de otro articulo', () => {
    assert.deepStrictEqual(completar.palabrasEnComun('Detector fetal Bistos BT-200', articulo('BT200', { DESCRIPCIO: 'DETECTOR FETAL BISTOS' })), ['DETECTOR', 'FETAL', 'BISTOS']);
    assert.deepStrictEqual(completar.palabrasEnComun('Estimulador de Piso Pelvico', articulo('123', { DESCRIPCIO: 'CABLE ECG' })), []);
});

test('las propiedades que completa salen del mapeo y son todas del grupo Tango', () => {
    assert.ok(completar.CAMPOS.includes('tango_id_sta11'));
    for (const c of completar.CAMPOS) assert.ok(c.startsWith('tango_'), c);
    assert.ok(!completar.CAMPOS.includes('tango_sync_hash'));
});

test('observaciones y codigo de barras NO se copian: en Tango tienen texto que no corresponde', () => {
    // El LX85 real dice "Ecografo 4D portatil Edan Acclarix AX8" en observaciones,
    // y el C5-2Q tiene "LX85, LX9" como codigo de barras.
    const w = porId(plan([articulo('LX85', { OBSERVACIONES: 'Ecografo 4D portatil Edan Acclarix AX8', COD_BARRA: 'LX85, LX9' })], [producto('p1', 'LX85')]), 'p1');
    assert.strictEqual(w.tango_observaciones, undefined);
    assert.strictEqual(w.tango_cod_barra, undefined);
    assert.ok(w.tango_id_sta11, 'el ID si');
});
