'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { Lookups, clave } = require('../src/lib/lookups');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

// Datos reales del ERP de Ultraschall, bajados el 2026-08-14.
const lk = Lookups.desdeRegistros({
    condicionesVenta: fixture('condicionesVenta'),
    vendedores: fixture('vendedores'),
    transportes: fixture('transportes'),
    provincias: fixture('provincias'),
    zonas: fixture('zonas'),
    alicuotasIva: fixture('alicuotasIva'),
});

test('clave() normaliza ceros a la izquierda y espacios', () => {
    assert.strictEqual(clave('05'), clave(5));
    assert.strictEqual(clave(' 5 '), clave('5'));
    assert.strictEqual(clave(''), null);
    assert.strictEqual(clave(null), null);
    assert.strictEqual(clave('RI'), 'RI');
});

test('resuelve el codigo al ID interno, que NO es el mismo numero', () => {
    // Casos verificados contra el ERP. Si estos pasan a coincidir, alguien
    // toco datos en Tango y hay que revisar el relevamiento.
    assert.strictEqual(lk.vendedor(24), 26);   // Juan Butorac
    assert.strictEqual(lk.vendedor(11), 12);   // MELINA
    assert.strictEqual(lk.provincia(1), 2);    // Buenos Aires
    assert.strictEqual(lk.provincia(0), 1);    // Capital Federal
    assert.strictEqual(lk.transporte(10), 1009); // A CONVENIR
    assert.strictEqual(lk.condicionVenta(15), 1014); // CHEQUE 0, 30 DIAS FF
});

test('la descripcion que devuelve corresponde al codigo, no al ID', () => {
    assert.strictEqual(lk.tabla('vendedores').descripcion(24), 'Juan Butorac');
    assert.strictEqual(lk.tabla('provincias').descripcion(1), 'Buenos Aires');
    assert.strictEqual(lk.tabla('transportes').descripcion(10), 'A CONVENIR');
});

test('mandar el codigo como ID grabaria OTRO registro (corrupcion silenciosa)', () => {
    // Este test documenta el bug que el modulo previene. Si alguna vez falla
    // porque ya no hay divergencia, se puede borrar; mientras falle, no.
    const vendedores = lk.tabla('vendedores');
    const provincias = lk.tabla('provincias');

    // El cliente tiene codigo 24 = Juan Butorac.
    // Si mandaramos 24 como ID_GVA23, Tango grabaria el vendedor con ID 24:
    const equivocado = vendedores.porId.get(24);
    assert.ok(equivocado, 'existe un vendedor con ID=24, por eso el error es silencioso');
    assert.notStrictEqual(equivocado.NOMBRE_VEN, 'Juan Butorac');

    // Idem provincias: codigo 1 es Buenos Aires, pero ID 1 es Capital Federal.
    assert.strictEqual(provincias.porId.get(1).NOMBRE_PRO, 'Capital Federal');
    assert.strictEqual(provincias.descripcion(1), 'Buenos Aires');
});

test('las seis tablas divergen: ninguna permite usar el codigo como ID', () => {
    for (const nombre of ['condicionesVenta', 'vendedores', 'transportes', 'provincias', 'zonas', 'alicuotasIva']) {
        const d = lk.tabla(nombre).divergencia();
        assert.ok(d.distintos > 0, `${nombre} deberia divergir (si dejo de hacerlo, revisar el relevamiento)`);
    }
});

test('resolver() explica el motivo en vez de devolver un valor mentiroso', () => {
    const ok = lk.resolver('vendedores', 24);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.id, 26);

    const vacio = lk.resolver('vendedores', '', 'cliente 000123');
    assert.strictEqual(vacio.ok, false);
    assert.match(vacio.motivo, /no tiene codigo/);
    assert.match(vacio.motivo, /cliente 000123/);

    const inexistente = lk.resolver('vendedores', 9999);
    assert.strictEqual(inexistente.ok, false);
    assert.match(inexistente.motivo, /no existe/);
    assert.strictEqual(inexistente.id, null, 'nunca devolver un ID cuando no se pudo resolver');
});

test('un codigo inexistente devuelve null, no undefined ni el codigo', () => {
    assert.strictEqual(lk.vendedor(9999), null);
    assert.strictEqual(lk.provincia('ZZ'), null);
});

test('todos los clientes de la muestra resuelven o fallan explicitamente', () => {
    const clientes = fixture('clientes-muestra');
    const campos = [
        ['vendedores', 'GVA23_CODIGO'],
        ['provincias', 'GVA18_CODIGO'],
        ['transportes', 'GVA24_CODIGO'],
        ['zonas', 'GVA05_CODIGO'],
        ['condicionesVenta', 'GVA01_COND_VTA'],
    ];

    for (const c of clientes) {
        for (const [tabla, campo] of campos) {
            const r = lk.resolver(tabla, c[campo], `cliente ${c.COD_GVA14}`);
            // O resuelve a un ID valido, o dice por que no. Nunca un valor a medias.
            if (r.ok) {
                assert.strictEqual(typeof r.id, 'number');
                assert.ok(Number.isFinite(r.id));
            } else {
                assert.strictEqual(r.id, null);
                assert.ok(r.motivo.length > 0);
            }
        }
    }
});
