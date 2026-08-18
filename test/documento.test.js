'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const doc = require('../src/lib/documento');

const clientes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clientes-muestra.json'), 'utf8'));

// ============================================================================
// Estos tests verifican la afirmacion "el codigo 80 es CUIT" contra los datos
// reales del ERP, con tres fuentes independientes. Si alguno falla, cambio
// algo en Tango y hay que revisar el relevamiento antes de seguir.
// ============================================================================

test('PRUEBA 1 — Tango se autodescribe: cada codigo tiene una sola etiqueta', () => {
    const porCodigo = new Map();
    for (const c of clientes) {
        const cod = Number(c.COD_TIPO_DOCUMENTO_GV);
        const desc = c.DESC_TIPO_DOCUMENTO_GV;
        if (!porCodigo.has(cod)) porCodigo.set(cod, new Set());
        porCodigo.get(cod).add(desc);
    }
    for (const [cod, descs] of porCodigo) {
        assert.strictEqual(descs.size, 1, `el codigo ${cod} tiene mas de una descripcion: ${[...descs]}`);
    }
    // La correspondencia concreta que usamos en documento.js
    assert.strictEqual([...porCodigo.get(80)][0], 'C.U.I.T.');
    assert.strictEqual([...porCodigo.get(96)][0], 'D.N.I.');
});

test('PRUEBA 2 — digito verificador: los codigo 80 son CUITs de verdad', () => {
    const c80 = clientes.filter((c) => Number(c.COD_TIPO_DOCUMENTO_GV) === 80 && doc.soloDigitos(c.CUIT).length === 11);
    assert.ok(c80.length > 50, 'la muestra tiene suficientes registros codigo 80');

    const validos = c80.filter((c) => doc.digitoVerificadorOk(c.CUIT)).length;
    const ratio = validos / c80.length;
    // El DV no sabe que dice la etiqueta: si casi todos pasan, la etiqueta es correcta.
    assert.ok(ratio > 0.98, `solo ${Math.round(ratio * 100)}% de los codigo 80 pasan el DV de CUIT`);
});

test('PRUEBA 2b — los DNI NO tienen forma de CUIT', () => {
    const dni = clientes.filter((c) => Number(c.COD_TIPO_DOCUMENTO_GV) === 96);
    if (!dni.length) return; // la muestra puede no tener
    const conForma11 = dni.filter((c) => doc.soloDigitos(c.CUIT).length === 11).length;
    assert.ok(conForma11 / dni.length < 0.5, 'la mayoria de los DNI no deberia tener 11 digitos');
});

test('PRUEBA 3 — prefijos AFIP: los codigo 80 empiezan como un CUIT', () => {
    const c80 = clientes.filter((c) => Number(c.COD_TIPO_DOCUMENTO_GV) === 80 && doc.soloDigitos(c.CUIT).length === 11);
    const conPrefijo = c80.filter((c) => doc.prefijoValido(c.CUIT)).length;
    assert.ok(conPrefijo / c80.length > 0.98, 'los CUIT deben empezar con 20/23/24/27/30/33/34');
});

test('el codigo 0 son CUITs mal etiquetados, no cedulas de policia federal', () => {
    const c0 = clientes.filter((c) => Number(c.COD_TIPO_DOCUMENTO_GV) === 0 && doc.soloDigitos(c.CUIT).length === 11);
    if (!c0.length) return;
    const validos = c0.filter((c) => doc.esCuitPlausible(c.CUIT)).length;
    assert.ok(validos / c0.length > 0.9, 'el tipo 0 es en los hechos "sin definir"');
});

// ------------------------------------------------------- algoritmo aislado

test('digitoVerificadorOk detecta un CUIT alterado', () => {
    assert.strictEqual(doc.digitoVerificadorOk('30-70985931-1'), true);
    assert.strictEqual(doc.digitoVerificadorOk('30-70985931-2'), false, 'un DV cambiado debe fallar');
    assert.strictEqual(doc.digitoVerificadorOk('12345678'), false, 'un DNI no es CUIT');
    assert.strictEqual(doc.digitoVerificadorOk(''), false);
    assert.strictEqual(doc.digitoVerificadorOk(null), false);
});

test('prefijoValido rechaza prefijos que AFIP no asigna', () => {
    assert.strictEqual(doc.prefijoValido('20-12345678-9'), true);
    assert.strictEqual(doc.prefijoValido('50-12345678-9'), false, 'el 50 no es prefijo de CUIT');
});

test('formatear deja un unico formato con guiones', () => {
    assert.strictEqual(doc.formatear('30709859311'), '30-70985931-1');
    assert.strictEqual(doc.formatear('30-70985931-1'), '30-70985931-1');
    assert.strictEqual(doc.formatear('38.901.611'), '38901611', 'a un DNI no se le pone mascara de CUIT');
    assert.strictEqual(doc.formatear(''), null);
});

// ---------------------------------------------------------------- resolver

test('resolver respeta el tipo cuando Tango lo declara', () => {
    const r = doc.resolver({ COD_TIPO_DOCUMENTO_GV: 80, CUIT: '30-70985931-1' });
    assert.strictEqual(r.tipo, 'CUIT');
    assert.strictEqual(r.origen, 'tango');
    assert.strictEqual(r.revisar, false);
});

test('resolver marca para revisar si el tipo declarado no cierra con el valor', () => {
    // Tango dice CUIT pero el numero no pasa el DV.
    const r = doc.resolver({ COD_TIPO_DOCUMENTO_GV: 80, CUIT: '30-70985931-2' });
    assert.strictEqual(r.tipo, 'CUIT', 'se respeta lo que declara el ERP');
    assert.strictEqual(r.revisar, true, 'pero se marca la incoherencia');
});

test('resolver infiere cuando Tango no define, y deja constancia', () => {
    const cuit = doc.resolver({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: '30-70985931-1' });
    assert.strictEqual(cuit.tipo, 'CUIT');
    assert.strictEqual(cuit.origen, 'inferido', 'nunca hacer pasar una deduccion por dato del ERP');

    const dni = doc.resolver({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: '38.901.611' });
    assert.strictEqual(dni.tipo, 'DNI');
    assert.strictEqual(dni.origen, 'inferido');
});

test('resolver no adivina cuando no puede', () => {
    const r = doc.resolver({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: '123' });
    assert.strictEqual(r.tipo, null);
    assert.strictEqual(r.origen, 'desconocido');
    assert.strictEqual(r.revisar, true);
});

// ------------------------------------------------- equivalencia para el alta

test('la equivalencia codigo -> ID no es "codigo + 1"', () => {
    // Verificado contra el ERP el 2026-08-18. La regla vale solo para 0..8:
    // el cliente creado con ID 2 volvio con codigo 1, con ID 3 codigo 2, etc.
    // Pero CUIT (cod 80) es ID 26, no 81 — el 81 lo rechaza Tango.
    assert.strictEqual(doc.COD_A_ID[0], 1);
    assert.strictEqual(doc.COD_A_ID[80], 26, 'CUIT');
    assert.strictEqual(doc.COD_A_ID[96], 40, 'DNI');
    assert.notStrictEqual(doc.COD_A_ID[80], 81, 'la planilla y la intuicion dicen 81; es falso');
});

test('idParaAlta devuelve el ID que exige Tango, no el codigo', () => {
    const cuit = doc.idParaAlta({ COD_TIPO_DOCUMENTO_GV: 80, CUIT: '30-70985931-1' });
    assert.strictEqual(cuit.ok, true);
    assert.strictEqual(cuit.id, 26);
    assert.strictEqual(cuit.origen, 'tango');
    assert.notStrictEqual(cuit.id, 80, 'nunca mandar el codigo como ID');

    const dni = doc.idParaAlta({ COD_TIPO_DOCUMENTO_GV: 96, CUIT: '38901611' });
    assert.strictEqual(dni.id, 40);
});

test('idParaAlta aprovecha el tipo inferido y avisa que lo es', () => {
    const r = doc.idParaAlta({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: '30-70985931-1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.id, 26, 'se infiere CUIT');
    assert.strictEqual(r.origen, 'inferido', 'quien lo use tiene que saber que fue deducido');
});

test('idParaAlta falla explicitamente si no puede determinar el tipo', () => {
    const r = doc.idParaAlta({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: '123' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.id, null);
    assert.ok(r.motivo);
});

test('sobre la muestra completa, quedan pocos sin resolver', () => {
    let porTango = 0, inferido = 0, desconocido = 0, revisar = 0;
    for (const c of clientes) {
        const r = doc.resolver(c);
        if (r.origen === 'tango') porTango++;
        else if (r.origen === 'inferido') inferido++;
        else desconocido++;
        if (r.revisar) revisar++;
    }
    assert.strictEqual(porTango + inferido + desconocido, clientes.length);
    assert.ok(desconocido / clientes.length < 0.05, `${desconocido} sin resolver de ${clientes.length}`);
    assert.ok(revisar / clientes.length < 0.15, `${revisar} para revisar de ${clientes.length}`);
});
