'use strict';

const test = require('node:test');
const assert = require('node:assert');

const precios = require('../src/lib/preciosArticulo');
const CATALOGO = require('../config/tango.processes.json');

// El array GVA17 tal como lo devuelve Api/GetById?process=87&id=187 (BAT250),
// leido del ERP el 2026-08-31.
const GVA17_BAT250 = [
    { ID_GVA17: 74, NRO_DE_LIS: 2, COD_ARTICU: 'BAT250', ID_STA11: 187, ID_GVA10: 2, PRECIO: 70, BASE: false },
];

test('la lista se configura por su numero y se resuelve al ID interno', () => {
    assert.strictEqual(precios.idDeLista(2), 2);
    assert.strictEqual(precios.nombreDeLista(2), 'SIN IVA EN U$S');
    assert.strictEqual(precios.idDeLista(99), null, 'una lista que no existe no puede resolver a nada');
});

test('el numero de lista NO se usa como ID: se traduce contra el catalogo', () => {
    // Hoy coinciden en las cinco listas, y por eso este test usa un catalogo
    // inventado donde NO coinciden. Si alguien cambia idDeLista por un cast a
    // numero, el resto sigue pasando y esto no.
    const catalogoTorcido = { filas: [{ ID_GVA10: 77, NRO_DE_LIS: 2, NOMBRE_LIS: 'OTRA' }] };
    assert.strictEqual(precios.idDeLista(2, catalogoTorcido), 77);
});

test('el precio sale de la fila de SU lista', () => {
    assert.strictEqual(precios.precioDeLista(GVA17_BAT250, 2), 70);
    assert.strictEqual(precios.precioDeLista(GVA17_BAT250, 3), null, 'no tiene precio en la lista 3');
});

test('un articulo con varias listas no mezcla precios', () => {
    const varias = [
        { NRO_DE_LIS: 1, ID_GVA10: 1, PRECIO: 2016923.08 },
        { NRO_DE_LIS: 2, ID_GVA10: 2, PRECIO: 15000 },
        { NRO_DE_LIS: 3, ID_GVA10: 3, PRECIO: 20155200 },
    ];
    assert.strictEqual(precios.precioDeLista(varias, 2), 15000);
    assert.strictEqual(precios.precioDeLista(varias, 1), 2016923.08);
    assert.strictEqual(precios.precioDeLista(varias, 3), 20155200);
});

test('sin precio devuelve null, que no es 0', () => {
    // 0 seria "vale cero" y se escribiria en HubSpot. null es "no hay precio".
    assert.strictEqual(precios.precioDeLista([], 2), null);
    assert.strictEqual(precios.precioDeLista(undefined, 2), null);
    assert.strictEqual(precios.precioDeLista([{ ID_GVA10: 2, PRECIO: 0 }], 2), null);
    assert.strictEqual(precios.precioDeLista([{ ID_GVA10: 2, PRECIO: null }], 2), null);
});

test('la subconsulta filtra por el ID interno de la lista', () => {
    const c = precios.condicionConPrecio(2);
    assert.match(c, /ID_STA11 IN \(SELECT ID_STA11 FROM GVA17 WHERE ID_GVA10 = 2/);
    assert.match(c, /PRECIO > 0/, 'un precio en cero no cuenta como precio cargado');
    assert.doesNotMatch(c, /^\s*WHERE/i, 'el WHERE lo agrega tangoClient');
});

test('la condicion no se arma con lo que llegue: solo enteros', () => {
    // El filtroSql es SQL concatenado del lado del ERP (10.0). El unico dato
    // que entra aca es un ID de una lista, y tiene que ser un entero.
    assert.throws(() => precios.condicionConPrecio('2 OR 1=1'), /invalido/);
    assert.throws(() => precios.condicionConPrecio(null), /invalido/);
});

test('cargar pide primero QUIENES y despues cuanto: no consulta 826 articulos', async () => {
    const getByIdLlamados = [];
    const tangoFalso = {
        async getByFilter(process, condicion) {
            assert.strictEqual(process, 87);
            assert.match(condicion, /GVA17/);
            return [{ ID_STA11: 187, COD_STA11: 'BAT250' }, { ID_STA11: 999, COD_STA11: 'OTRO' }];
        },
        async getById(process, id) {
            getByIdLlamados.push(id);
            return id === 187 ? { GVA17: GVA17_BAT250 } : { GVA17: [{ ID_GVA10: 2, PRECIO: 500 }] };
        },
    };

    const r = await precios.cargar({ tango: tangoFalso, nroDeLista: 2, concurrencia: 1 });

    assert.deepStrictEqual(getByIdLlamados.sort(), [187, 999], 'solo los que el filtro dijo que tienen precio');
    assert.strictEqual(r.precios.get('187'), 70);
    assert.strictEqual(r.precios.get('999'), 500);
    assert.strictEqual(r.nombreLista, 'SIN IVA EN U$S');
    assert.strictEqual(r.conPrecioEnLaLista, 2);
});

test('soloIds acota la consulta: la corrida de prueba paga por un articulo', async () => {
    const consultados = [];
    const tangoFalso = {
        async getByFilter() { return [{ ID_STA11: 187 }, { ID_STA11: 999 }, { ID_STA11: 1000 }]; },
        async getById(_p, id) { consultados.push(id); return { GVA17: GVA17_BAT250 }; },
    };
    await precios.cargar({ tango: tangoFalso, nroDeLista: 2, soloIds: [187], concurrencia: 1 });
    assert.deepStrictEqual(consultados, [187]);
});

test('un articulo que falla no voltea la corrida entera', async () => {
    const tangoFalso = {
        async getByFilter() { return [{ ID_STA11: 1 }, { ID_STA11: 2 }]; },
        async getById(_p, id) {
            if (id === 1) throw new Error('Tango respondio 500');
            return { GVA17: [{ ID_GVA10: 2, PRECIO: 42 }] };
        },
    };
    const r = await precios.cargar({ tango: tangoFalso, nroDeLista: 2, concurrencia: 1 });
    assert.strictEqual(r.precios.get('2'), 42);
    assert.strictEqual(r.fallidos.length, 1);
    assert.match(r.fallidos[0].motivo, /500/);
});

test('una lista que no existe falla temprano y con nombre', async () => {
    await assert.rejects(
        () => precios.cargar({ tango: {}, nroDeLista: 42 }),
        /la lista '42' no existe/,
    );
});

test('el catalogo de listas sigue teniendo la lista que usa el sync', () => {
    // Si alguien recalcula GVA10 y desaparece la lista configurada, el sync
    // dejaria de escribir precios en silencio. Que se rompa un test.
    const defaults = require('../config/defaults.tango.json');
    const nro = defaults.productos?.listaPrecios;
    assert.ok(nro, 'defaults.tango.json tiene que decir de que lista salen los precios');
    assert.ok(precios.idDeLista(nro), `la lista ${nro} no esta en el catalogo de GVA10`);
    assert.ok(CATALOGO.auxiliares.listasPrecios.filas.length >= 5);
});
