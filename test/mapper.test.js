'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { crear, transforms, castear } = require('../src/lib/mapper');
const { Lookups } = require('../src/lib/lookups');
const mapeoClientes = require('../config/mapeo.clientes.json');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

const lk = Lookups.desdeRegistros({
    condicionesVenta: fixture('condicionesVenta'),
    vendedores: fixture('vendedores'),
    transportes: fixture('transportes'),
    provincias: fixture('provincias'),
    zonas: fixture('zonas'),
    alicuotasIva: fixture('alicuotasIva'),
});

const clientes = fixture('clientes-muestra');
const mapper = crear(mapeoClientes, lk);

// ------------------------------------------------------------------ transforms

test('normalizarCuit deja solo digitos', () => {
    assert.strictEqual(transforms.normalizarCuit('30-70985931-1'), '30709859311');
    assert.strictEqual(transforms.normalizarCuit(''), null);
    assert.strictEqual(transforms.normalizarCuit(null), null);
});

test('normalizarTelefono conserva el + internacional', () => {
    assert.strictEqual(transforms.normalizarTelefono('(0376)4434782'), '03764434782');
    assert.strictEqual(transforms.normalizarTelefono('+54 11 4444-5555'), '+541144445555');
    assert.strictEqual(transforms.normalizarTelefono('   '), null);
});

test('normalizarUrl agrega esquema y descarta basura', () => {
    assert.strictEqual(transforms.normalizarUrl('www.ejemplo.com'), 'http://www.ejemplo.com/');
    assert.strictEqual(transforms.normalizarUrl('https://a.com/x'), 'https://a.com/x');
    assert.strictEqual(transforms.normalizarUrl('sin punto'), null);
    assert.strictEqual(transforms.normalizarUrl(''), null);
});

test('fechaTangoAEpoch da medianoche UTC', () => {
    const e = transforms.fechaTangoAEpoch('2018-08-29T00:00:00');
    assert.strictEqual(e, Date.UTC(2018, 7, 29));
    assert.strictEqual(new Date(e).toISOString(), '2018-08-29T00:00:00.000Z');
    assert.strictEqual(transforms.fechaTangoAEpoch(null), null);
});

test('castear no convierte string vacio en 0 ni en ""', () => {
    assert.strictEqual(castear('', 'string'), null);
    assert.strictEqual(castear('', 'number'), null);
    assert.strictEqual(castear('abc', 'number'), null);
    assert.strictEqual(castear('5', 'number'), 5);
    assert.strictEqual(castear('S', 'bool'), true);
    assert.strictEqual(castear('N', 'bool'), false);
});

// --------------------------------------------------------------------- mapeo

test('los campos con lookup guardan el ID interno, no el codigo', () => {
    // Cliente real con vendedor codigo 24 (Juan Butorac -> ID 26).
    const c = clientes.find((x) => Number(x.GVA23_CODIGO) === 24);
    assert.ok(c, 'la muestra tiene algun cliente con vendedor 24');

    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_id_gva23, 26, 'debe guardar el ID interno');
    assert.notStrictEqual(propiedades.tango_id_gva23, 24, 'nunca el codigo');
});

test('la provincia se resuelve al ID correcto (el bug de los 4022 clientes)', () => {
    const c = clientes.find((x) => Number(x.GVA18_CODIGO) === 1);
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    // codigo 1 = Buenos Aires, ID interno 2. Sin lookup se grabaria 1 = Capital Federal.
    assert.strictEqual(propiedades.tango_id_gva18, 2);
    assert.strictEqual(propiedades.state, 'Buenos Aires');
});

test('GVA05 mapea a zona y GVA23 a vendedor (no al reves)', () => {
    const c = clientes.find((x) => x.GVA05_DESCRIPCION && x.GVA23_DESCRIPCION);
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_zona, c.GVA05_DESCRIPCION);
    assert.strictEqual(propiedades.tango_vendedor, c.GVA23_DESCRIPCION);
});

test('un codigo que no resuelve se omite y se reporta, no se inventa', () => {
    const c = { ...clientes[0], GVA23_CODIGO: 9999 };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_id_gva23, undefined, 'no debe escribir un valor incorrecto');
    assert.ok(problemas.some((p) => /vendedores.*9999.*no existe/.test(p)));
});

test('un codigo vacio no genera problema: es ausencia de dato, no un error', () => {
    const c = { ...clientes[0], GVA23_CODIGO: '' };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_id_gva23, undefined);
    assert.ok(!problemas.some((p) => /vendedores/.test(p)));
});

test('la clave de idempotencia es COD_GVA14', () => {
    assert.strictEqual(mapper.clave(clientes[0]), String(clientes[0].COD_GVA14).trim());
});

test('el mapper exige lookups si el mapeo los usa', () => {
    assert.throws(() => crear(mapeoClientes, null), /no se paso la instancia de lookups/);
});

// ---------------------------------------------------------------------- hash

test('el hash es estable ante el orden de las claves', () => {
    const a = mapper.hash({ x: 1, y: 2 });
    const b = mapper.hash({ y: 2, x: 1 });
    assert.strictEqual(a, b);
});

test('el hash cambia si cambia un valor', () => {
    assert.notStrictEqual(mapper.hash({ x: 1 }), mapper.hash({ x: 2 }));
});

// ----------------------------------------------------------- corrida completa

test('mapea los 300 clientes de la muestra sin excepciones', () => {
    let conProblemas = 0;
    const hashes = new Set();

    for (const c of clientes) {
        const { propiedades, problemas } = mapper.aHubSpot(c);
        assert.ok(propiedades.tango_cod_cliente, 'todo cliente debe tener la clave');
        assert.strictEqual(typeof propiedades.tango_id_gva14, 'number');
        if (problemas.length) conProblemas++;
        hashes.add(mapper.hash(propiedades));
    }

    // Los hashes deben ser mayormente distintos: si colapsaran, el sync
    // diferencial no detectaria cambios.
    assert.ok(hashes.size > clientes.length * 0.95, `hashes distintos: ${hashes.size}/${clientes.length}`);
    assert.ok(conProblemas < clientes.length, 'no todos los clientes pueden tener problemas');
});
