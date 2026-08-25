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
    const clave = plan.aCrear.find((p) => p.name === 'codigo_tango');
    assert.strictEqual(clave.hasUniqueValue, true);

    const claveContactos = planificar(mapeoContactos, []).aCrear.find((p) => p.name === 'tango_id_gva27');
    assert.strictEqual(claveContactos.hasUniqueValue, true);
});

test('codigo_tango existente sin unicidad hay que rehacerla, no parchearla', () => {
    // hasUniqueValue es inmutable en HubSpot. Sin unicidad el batch upsert por
    // idProperty no puede funcionar.
    const plan = planificar(mapeoClientes, PORTAL_REAL);
    const p = plan.aRehacer.find((x) => x.name === 'codigo_tango');
    assert.ok(p, 'tiene que aparecer como REHACER');
    assert.match(p.motivo, /unica/);
    assert.strictEqual(p.definicion.hasUniqueValue, true);
    assert.ok(!plan.aParchear.some((x) => x.name === 'codigo_tango'), 'un PATCH no lo arregla');
});

test('cuit esta como number y el mapeo lo quiere texto: rehacer', () => {
    const plan = planificar(mapeoClientes, PORTAL_REAL);
    const p = plan.aRehacer.find((x) => x.name === 'cuit');
    assert.ok(p);
    assert.match(p.motivo, /number/);
    assert.strictEqual(p.definicion.type, 'string');
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
