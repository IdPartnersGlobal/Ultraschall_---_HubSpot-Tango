'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { planificar, tipoHubSpot, opcionesDe } = require('../src/lib/propiedades');
const mapeoClientes = require('../config/mapeo.clientes.json');
const mapeoContactos = require('../config/mapeo.contactos.json');

/**
 * Estado real del portal de Ultraschall al 2026-08-20, leido de
 * GET /crm/v3/properties/companies. Son las 5 propiedades que alguien creo a
 * mano antes de que existiera la integracion.
 */
const PORTAL_REAL = [
    { name: 'codigo_tango', type: 'string', fieldType: 'text', hasUniqueValue: false, groupName: 'companyinformation' },
    { name: 'razon_social', type: 'string', fieldType: 'text', hasUniqueValue: false, groupName: 'companyinformation' },
    { name: 'cuit', type: 'number', fieldType: 'number', hasUniqueValue: false, groupName: 'companyinformation' },
    {
        name: 'condicion_iva', type: 'enumeration', fieldType: 'select', groupName: 'companyinformation',
        options: [
            { label: 'Responsable Inscripto', value: 'Responsable Inscripto' },
            { label: 'Monotributista', value: 'Monotributista' },
            { label: 'Consumidor Final', value: 'Consumidor Final' },
        ],
    },
    {
        name: 'tipo_de_documento', type: 'enumeration', fieldType: 'select', groupName: 'companyinformation',
        options: [
            { label: 'DNI', value: 'DNI' },
            { label: 'CUIT', value: 'CUIT' },
        ],
    },
];

// --------------------------------------------------------------------- tipos

test('un desplegable sin opciones se degrada a texto en vez de romper el alta', () => {
    // HubSpot rechaza crear una enumeration sin options.
    assert.deepStrictEqual(
        tipoHubSpot({ hsFieldType: 'select', tipo: 'string' }),
        { type: 'string', fieldType: 'text' }
    );
    assert.deepStrictEqual(
        tipoHubSpot({ hsFieldType: 'select', tipo: 'string', opciones: { A: 'Uno' } }),
        { type: 'enumeration', fieldType: 'select' }
    );
});

test('opcionesDe deduplica: varios codigos pueden apuntar a la misma etiqueta', () => {
    const ops = opcionesDe({ opciones: { EX: 'Exento', EXE: 'Exento', RI: 'Responsable Inscripto' } });
    assert.strictEqual(ops.length, 2);
    assert.deepStrictEqual(ops.map((o) => o.value), ['Exento', 'Responsable Inscripto']);
});

// ---------------------------------------------------------------- planificar

test('contra el portal vacio hay que crear todo y nada que rehacer', () => {
    const plan = planificar(mapeoClientes, []);
    assert.ok(plan.aCrear.length > 20);
    assert.strictEqual(plan.aRehacer.length, 0);
    assert.strictEqual(plan.aParchear.length, 0);
});

test('la clave de idempotencia se crea unica', () => {
    const plan = planificar(mapeoClientes, []);
    const clave = plan.aCrear.find((p) => p.name === mapeoClientes._meta.claveIdempotencia.hubspot);
    assert.strictEqual(clave.name, 'tango_codigo_cliente', 'la clave se mudo el 2026-08-27');
    assert.strictEqual(clave.hasUniqueValue, true);

    const claveContactos = planificar(mapeoContactos, []).aCrear.find((p) => p.name === 'tango_id_gva27');
    assert.strictEqual(claveContactos.hasUniqueValue, true);
});

test('la clave se mudo, pero codigo_tango se sigue escribiendo', () => {
    // El nombre lo define la planilla de Ultraschall (6.0) y es el que mira la
    // gente. Lo que dejo de ser es el idProperty del upsert.
    const campos = mapeoClientes.campos.filter((c) => c.tango === 'COD_GVA14');
    assert.deepStrictEqual(campos.map((c) => c.hubspot).sort(), ['codigo_tango', 'tango_codigo_cliente']);
    assert.strictEqual(campos.find((c) => c.hubspot === 'codigo_tango').unique, false);
});

test('ninguna propiedad del portal queda marcada para rehacer', () => {
    // DECISION 2026-08-27 (Matias): las propiedades mal definidas se dejan
    // existir; no se borra ninguna. `codigo_tango` sin unicidad y `cuit` como
    // number se rodean —clave nueva y valor numerico—, no se rehacen.
    const plan = planificar(mapeoClientes, PORTAL_REAL);
    assert.deepStrictEqual(plan.aRehacer.map((p) => p.name), [],
        'si algo vuelve a aparecer aca, hay que rodearlo, no borrarlo');
});

test('cuit se queda como number y el mapeo se adapta', () => {
    const plan = planificar(mapeoClientes, PORTAL_REAL);
    assert.ok(!plan.aRehacer.some((x) => x.name === 'cuit'));
    assert.ok(!plan.aCrear.some((x) => x.name === 'cuit'), 'ya existe, no se toca');

    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'cuit');
    assert.strictEqual(campo.tipo, 'number');
    assert.strictEqual(campo.transform, 'documentoSoloDigitos');
});

test('a los desplegables les faltan opciones y eso si se parchea', () => {
    const plan = planificar(mapeoClientes, PORTAL_REAL);

    const iva = plan.aParchear.find((x) => x.name === 'condicion_iva');
    assert.ok(iva, 'falta la opcion Exento');
    assert.match(iva.detalle, /Exento/);

    const doc = plan.aParchear.find((x) => x.name === 'tipo_de_documento');
    assert.ok(doc, 'faltan CUIL y C.I. Extranjera');
});

test('el PATCH manda tambien las opciones viejas: reemplaza la lista entera', () => {
    // Si se mandan solo las nuevas, HubSpot borra las que ya tenian valores
    // cargados en registros reales.
    const plan = planificar(mapeoClientes, PORTAL_REAL);
    const iva = plan.aParchear.find((x) => x.name === 'condicion_iva');
    const valores = iva.cambios.options.map((o) => o.value);
    assert.ok(valores.includes('Responsable Inscripto'), 'conserva las que ya estaban');
    assert.ok(valores.includes('Monotributista'));
    assert.ok(valores.includes('Consumidor Final'));
    assert.ok(valores.includes('Exento'), 'y agrega la que falta');
    assert.strictEqual(new Set(valores).size, valores.length, 'sin repetidos');
});

test('las propiedades estandar de HubSpot no se crean', () => {
    const plan = planificar(mapeoContactos, []);
    for (const n of ['email', 'lastname', 'firstname', 'jobtitle']) {
        assert.ok(!plan.aCrear.some((p) => p.name === n), `${n} ya existe en HubSpot`);
    }
});

test('planificar es idempotente: contra su propio resultado no queda nada por hacer', () => {
    const plan = planificar(mapeoClientes, []);
    // Simula el portal despues de correr crearPropiedades.
    const yaCreadas = plan.aCrear.map((p) => ({
        name: p.name, type: p.type, fieldType: p.fieldType,
        hasUniqueValue: !!p.hasUniqueValue, groupName: p.groupName,
        options: p.options || [],
    }));
    const segunda = planificar(mapeoClientes, yaCreadas);
    assert.strictEqual(segunda.aCrear.length, 0);
    assert.strictEqual(segunda.aParchear.length, 0);
    assert.strictEqual(segunda.aRehacer.length, 0);
});

test('una propiedad booleana lleva sus dos opciones o HubSpot la rechaza', () => {
    // Caso real del 2026-08-25: `tango_lleva_stock` fallo con "Boolean
    // properties must have exactly two options" y quedo sin crear mientras las
    // otras 13 si se creaban.
    const mapeo = {
        _meta: { claveIdempotencia: { hubspot: 'clave' } },
        campos: [{ tango: 'STOCK', hubspot: 'lleva_stock', label: 'Lleva stock', tipo: 'boolean' }],
    };
    const { aCrear } = planificar(mapeo, []);
    assert.strictEqual(aCrear[0].fieldType, 'booleancheckbox');
    assert.deepStrictEqual(aCrear[0].options.map((o) => o.value), ['true', 'false'], 'exactamente dos, y en ese orden');
});
