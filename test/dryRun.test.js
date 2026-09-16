'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dryRun = require('../src/lib/dryRun');
const syncClientes = require('../src/lib/syncClientes');
const syncProductos = require('../src/lib/syncProductos');
const dealToTango = require('../src/lib/dealToTango');

const CIRCUITOS = ['clientes', 'productos', 'negocios'];

// Lo que hay hoy en las Application Settings de Azure (ARQUITECTURA.md 11.3):
// la global en 'false' desde el 2026-09-02, porque asi se emitio el primer
// pedido real. Todo lo de abajo se juzga contra esto.
const AZURE = { SYNC_DRY_RUN: 'false' };

// Lo minimo para que cada leerConfig no se queje por variables que no vienen al caso.
const ENTORNO = {
    TANGO_API_URL: 'http://x', TANGO_API_KEY: 'k', TANGO_COMPANY: '3',
    HUBSPOT_TOKEN: 't', HUBSPOT_CLIENT_SECRET: 's',
};

// ── El default es no escribir ───────────────────────────────────────────────

test('sin ninguna variable, los tres circuitos estan en dry-run', () => {
    for (const c of CIRCUITOS) assert.strictEqual(dryRun.leer(c, {}), true, c);
});

test('solo un false explicito escribe: cualquier otro valor deja el dry-run', () => {
    for (const v of ['', '   ', 'true', 'no', 'falso', '0', 'False!', 'null', 'undefined']) {
        for (const c of CIRCUITOS) {
            assert.strictEqual(dryRun.leer(c, { [dryRun.CIRCUITOS[c].variable]: v }), true, `${c} con ${JSON.stringify(v)}`);
            assert.strictEqual(dryRun.leer(c, { SYNC_DRY_RUN: v }), true, `${c} heredando ${JSON.stringify(v)}`);
        }
    }
});

test('un false con espacios o mayusculas si escribe: es el mismo criterio de antes', () => {
    assert.strictEqual(dryRun.leer('productos', { SYNC_DRY_RUN_PRODUCTOS: ' FALSE ' }), false);
});

// ── Lo que este cambio vino a arreglar ──────────────────────────────────────

test('con el Azure de hoy, prender el sync de empresas NO lo pone a escribir', () => {
    // Era el agujero: `SYNC_DRY_RUN=false` la puso el circuito de negocios dos
    // semanas antes, y alcanzaba para que el sync de empresas escribiera 5.742
    // companies del portal real sin que nadie tomara ESA decision.
    assert.strictEqual(dryRun.leer('clientes', AZURE), true);
    assert.strictEqual(syncClientes.leerConfig({ ...ENTORNO, ...AZURE }).DRY_RUN, true);
});

test('y el circuito de negocios, que hoy funciona, sigue escribiendo igual que antes', () => {
    // El otro lado del mismo error: apagar la global para ensayar empresas
    // dejaria los negocios ganados sin pedido y sin que falle nada.
    assert.strictEqual(dryRun.leer('negocios', AZURE), false);
    assert.strictEqual(dealToTango.leerConfig({ ...ENTORNO, ...AZURE }).DRY_RUN, false);
    assert.strictEqual(syncProductos.leerConfig({ ...ENTORNO, ...AZURE }).DRY_RUN, false);
});

test('cada circuito se enciende solo: escribir en empresas no toca a los otros dos', () => {
    const env = { ...ENTORNO, SYNC_DRY_RUN: 'true', SYNC_DRY_RUN_CLIENTES: 'false' };
    assert.strictEqual(syncClientes.leerConfig(env).DRY_RUN, false);
    assert.strictEqual(syncProductos.leerConfig(env).DRY_RUN, true);
    assert.strictEqual(dealToTango.leerConfig(env).DRY_RUN, true);
});

test('y al reves: se puede frenar uno sin frenar los otros', () => {
    const env = { ...ENTORNO, SYNC_DRY_RUN: 'false', SYNC_DRY_RUN_NEGOCIOS: 'true' };
    assert.strictEqual(dealToTango.leerConfig(env).DRY_RUN, true, 'la propia le gana a la global');
    assert.strictEqual(syncProductos.leerConfig(env).DRY_RUN, false);
});

// ── Heredar, y el que no hereda ─────────────────────────────────────────────

test('productos y negocios heredan la global cuando no tienen la suya', () => {
    for (const c of ['productos', 'negocios']) {
        const r = dryRun.resolver(c, { SYNC_DRY_RUN: 'false' });
        assert.strictEqual(r.dryRun, false, c);
        assert.strictEqual(r.heredado, true, c);
        assert.strictEqual(r.variable, 'SYNC_DRY_RUN', c);
    }
});

test('clientes no hereda: sin SYNC_DRY_RUN_CLIENTES no escribe, y el log dice que falta', () => {
    const r = dryRun.resolver('clientes', { SYNC_DRY_RUN: 'false' });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.heredado, false);
    assert.strictEqual(r.faltaPropia, true);
    assert.match(dryRun.descripcion('clientes', { SYNC_DRY_RUN: 'false' }), /SYNC_DRY_RUN_CLIENTES sin definir/);
});

test('la propia le gana a la global en los dos sentidos', () => {
    for (const c of CIRCUITOS) {
        const v = dryRun.CIRCUITOS[c].variable;
        assert.strictEqual(dryRun.leer(c, { SYNC_DRY_RUN: 'true', [v]: 'false' }), false, `${c} escribe`);
        assert.strictEqual(dryRun.leer(c, { SYNC_DRY_RUN: 'false', [v]: 'true' }), true, `${c} frena`);
    }
});

test('una propia vacia no cuenta como definida: se cae a la global', () => {
    assert.strictEqual(dryRun.leer('productos', { SYNC_DRY_RUN: 'false', SYNC_DRY_RUN_PRODUCTOS: '  ' }), false);
});

// ── El log de arranque ──────────────────────────────────────────────────────

test('una escritura heredada se ve como heredada, no como decidida aca', () => {
    // Si el log dijera solo "ESCRITURA REAL", el modo mas peligroso —el que
    // nadie eligio para este circuito— seria el que menos se nota.
    const d = dryRun.descripcion('productos', { SYNC_DRY_RUN: 'false' });
    assert.match(d, /ESCRITURA REAL/);
    assert.match(d, /heredado de SYNC_DRY_RUN=false/);
    assert.match(d, /SYNC_DRY_RUN_PRODUCTOS/, 'dice como decidirlo en este circuito');
});

test('una escritura pedida por el circuito nombra su variable y no habla de herencia', () => {
    const d = dryRun.descripcion('clientes', { SYNC_DRY_RUN_CLIENTES: 'false' });
    assert.match(d, /ESCRITURA REAL/);
    assert.match(d, /SYNC_DRY_RUN_CLIENTES=false/);
    assert.doesNotMatch(d, /heredado/);
});

test('el dry-run heredado dice de donde salio', () => {
    assert.match(dryRun.descripcion('negocios', { SYNC_DRY_RUN: 'true' }), /heredado de SYNC_DRY_RUN=true/);
});

// ── Que no se pueda pedir un circuito que no existe ─────────────────────────

test('un circuito con otro nombre falla fuerte, no devuelve un dry-run silencioso', () => {
    // Devolver `true` seria peor: el circuito quedaria sin escribir para
    // siempre por un typo, y el log diria que esta todo bien.
    assert.throws(() => dryRun.leer('empresas', {}), /Circuito de dry-run desconocido/);
    assert.throws(() => dryRun.resolver(undefined, {}), /Circuito de dry-run desconocido/);
});

test('cada circuito tiene su variable y son todas distintas', () => {
    const vars = CIRCUITOS.map((c) => dryRun.CIRCUITOS[c].variable);
    assert.deepStrictEqual(vars, ['SYNC_DRY_RUN_CLIENTES', 'SYNC_DRY_RUN_PRODUCTOS', 'SYNC_DRY_RUN_NEGOCIOS']);
    assert.strictEqual(new Set(vars).size, 3);
    assert.strictEqual(Object.keys(dryRun.CIRCUITOS).length, 3, 'si aparece un cuarto circuito, hay que testearlo');
});
