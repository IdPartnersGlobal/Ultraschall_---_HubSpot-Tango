'use strict';

const test = require('node:test');
const assert = require('node:assert');

const porCodigo = require('../src/lib/articuloPorCodigo');

/**
 * Un producto con el codigo de Tango en el SKU y sin `tango_id_sta11` sale con
 * su articulo real (2026-10-02, §9.34). Los que ya tienen ID no cambian.
 */

/**
 * Tango falso: responde como SQL Server, SIN distinguir mayusculas — es lo que
 * hace el real (`L15-7B` le trae `L15-7b`, medido el 2026-10-02).
 */
function tangoFalso(articulos = []) {
    return {
        consultas: [],
        async getByFilter(process, condicion) {
            this.consultas.push({ process, condicion });
            const pedidos = [...condicion.matchAll(/'([^']*)'/g)].map((m) => m[1].toUpperCase());
            return articulos.filter((a) => pedidos.includes(String(a.COD_STA11).trim().toUpperCase()));
        },
    };
}

const ARTICULOS = [
    { ID_STA11: 200, COD_STA11: 'BT250' },
    { ID_STA11: 486, COD_STA11: 'L15-7b' },
    { ID_STA11: 915, COD_STA11: 'VRES5W-6,8' },
    { ID_STA11: 543, COD_STA11: 'P5-1XD+' },
];

test('un producto que ya tiene su ID no consulta Tango', async () => {
    const tango = tangoFalso(ARTICULOS);
    const productos = new Map([['1', { name: 'Detector', hs_sku: 'BT250', tango_id_sta11: '200' }]]);
    const r = await porCodigo.completar({ tango, productos });

    assert.strictEqual(tango.consultas.length, 0, 'si todos tienen ID, el paso no gasta red');
    assert.strictEqual(r.productos.get('1').tango_id_sta11, '200');
    assert.deepStrictEqual(r.porCodigo, []);
});

test('el ID que ya tiene el producto manda, aunque el SKU diga otra cosa', async () => {
    // Lo de siempre no cambia: el ID cargado (a mano o por la pasada) gana.
    const tango = tangoFalso(ARTICULOS);
    const productos = new Map([['1', { hs_sku: 'BT250', tango_id_sta11: '999' }]]);
    const r = await porCodigo.completar({ tango, productos });
    assert.strictEqual(r.productos.get('1').tango_id_sta11, '999');
    assert.strictEqual(tango.consultas.length, 0);
});

test('sin ID y con el codigo en el SKU, sale con el ID del articulo de Tango', async () => {
    const tango = tangoFalso(ARTICULOS);
    const productos = new Map([['1', { name: 'Detector', hs_sku: ' BT250 ' }]]);
    const r = await porCodigo.completar({ tango, productos });

    assert.strictEqual(r.productos.get('1').tango_id_sta11, '200');
    assert.strictEqual(r.productos.get('1').tango_id_por_codigo, 'BT250');
    assert.strictEqual(r.productos.get('1').name, 'Detector', 'el resto del producto queda igual');
    assert.deepStrictEqual(r.porCodigo, [{ producto: '1', sku: 'BT250', codigo: 'BT250', idSta11: 200 }]);
    assert.strictEqual(tango.consultas[0].process, 87, 'articulos');
    assert.strictEqual(productos.get('1').tango_id_sta11, undefined, 'el Map de entrada no se toca');
});

test('igual salvo mayusculas y UNO solo en Tango: se usa (L15-7B es L15-7b)', async () => {
    // Decision de Matias 2026-10-05. Medido ese dia: 21 de 942 codigos tienen
    // minusculas y ningun par choca si se ignoran.
    const tango = tangoFalso(ARTICULOS);
    const r = await porCodigo.completar({ tango, productos: new Map([['1', { hs_sku: 'L15-7B' }]]) });
    assert.strictEqual(r.productos.get('1').tango_id_sta11, '486');
    assert.strictEqual(r.productos.get('1').tango_id_por_codigo, 'L15-7b', 'el codigo tal cual esta en Tango');
    assert.deepStrictEqual(r.porCodigo, [{ producto: '1', sku: 'L15-7B', codigo: 'L15-7b', idSta11: 486 }]);
});

test('igual salvo mayusculas con VARIOS en Tango: no se elige ninguno, y se nombran', async () => {
    // Hoy no pasa. Si aparece, elegir uno a ciegas es entregar otra cosa.
    const tango = tangoFalso([{ ID_STA11: 1, COD_STA11: 'abc' }, { ID_STA11: 2, COD_STA11: 'ABC' }]);
    const r = await porCodigo.completar({ tango, productos: new Map([['1', { hs_sku: 'Abc' }]]) });
    assert.strictEqual(r.productos.get('1').tango_id_sta11, undefined);
    assert.deepStrictEqual(r.productos.get('1').tango_codigos_parecidos.sort(), ['ABC', 'abc']);
    assert.deepStrictEqual(r.porCodigo, []);
});

test('el exacto gana aunque haya otro que solo cambia en mayusculas', async () => {
    const tango = tangoFalso([{ ID_STA11: 1, COD_STA11: 'abc' }, { ID_STA11: 2, COD_STA11: 'ABC' }]);
    const r = await porCodigo.completar({ tango, productos: new Map([['1', { hs_sku: 'ABC' }], ['2', { hs_sku: 'abc' }]]) });
    assert.strictEqual(r.productos.get('1').tango_id_sta11, '2');
    assert.strictEqual(r.productos.get('2').tango_id_sta11, '1');
});

test('un SKU que no es codigo de Tango deja el producto como estaba', async () => {
    const tango = tangoFalso(ARTICULOS);
    const r = await porCodigo.completar({ tango, productos: new Map([['1', { hs_sku: 'No Existe' }]]) });
    assert.strictEqual(r.productos.get('1').tango_id_sta11, undefined);
});

test('los caracteres raros de los codigos reales se buscan bien', async () => {
    const tango = tangoFalso(ARTICULOS);
    const productos = new Map([['1', { hs_sku: 'VRES5W-6,8' }], ['2', { hs_sku: 'P5-1XD+' }]]);
    const r = await porCodigo.completar({ tango, productos });
    assert.strictEqual(r.productos.get('1').tango_id_sta11, '915');
    assert.strictEqual(r.productos.get('2').tango_id_sta11, '543');
});

test('un SKU con comilla, vacio o demasiado largo NO llega al filtro de Tango', async () => {
    // El filtro es SQL concatenado del lado del ERP (§10.0).
    const tango = tangoFalso(ARTICULOS);
    const productos = new Map([
        ['1', { hs_sku: "BT250' OR '1'='1" }],
        ['2', { hs_sku: '' }],
        ['3', {}],
        ['4', { hs_sku: 'A'.repeat(16) }],
    ]);
    const r = await porCodigo.completar({ tango, productos });
    assert.strictEqual(tango.consultas.length, 0);
    for (const id of ['1', '2', '3', '4']) assert.strictEqual(r.productos.get(id).tango_id_sta11, undefined);
    assert.strictEqual(porCodigo.codigoBuscable({ hs_sku: "X'Y" }), null);
});

test('dos productos con el mismo SKU: una sola pregunta, los dos resueltos', async () => {
    const tango = tangoFalso(ARTICULOS);
    const productos = new Map([['1', { hs_sku: 'BT250' }], ['2', { hs_sku: 'BT250' }]]);
    const r = await porCodigo.completar({ tango, productos });
    assert.strictEqual((tango.consultas[0].condicion.match(/'BT250'/g) || []).length, 1);
    assert.strictEqual(r.productos.get('1').tango_id_sta11, '200');
    assert.strictEqual(r.productos.get('2').tango_id_sta11, '200');
});

test('muchos codigos van en tandas', async () => {
    const articulos = Array.from({ length: 250 }, (_, i) => ({ ID_STA11: i + 1, COD_STA11: `A${i}` }));
    const tango = tangoFalso(articulos);
    const productos = new Map(articulos.map((a) => [String(a.ID_STA11), { hs_sku: a.COD_STA11 }]));
    const r = await porCodigo.completar({ tango, productos });
    assert.strictEqual(tango.consultas.length, 3);
    assert.strictEqual(r.porCodigo.length, 250);
});

test('si Tango falla, el error sube: no se arma un pedido a medias', async () => {
    const tango = { async getByFilter() { throw new Error('Tango no responde'); } };
    await assert.rejects(porCodigo.completar({ tango, productos: new Map([['1', { hs_sku: 'BT250' }]]) }), /no responde/);
});
