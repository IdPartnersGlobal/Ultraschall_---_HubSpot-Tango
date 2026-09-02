'use strict';

const test = require('node:test');
const assert = require('node:assert');

const soloOwner = require('../src/lib/soloOwner');

// El owner real de Matias en el portal 51311915, que es con el que se hace la
// primera prueba punta a punta. Los @ultraschall.com.ar son los comerciales.
const MIO = '83855505';
const AJENO = '90573354'; // farancibia@ultraschall.com.ar

const OWNERS = new Map([
    [MIO, 'matias.tari@idpartners.ar'],
    [AJENO, 'farancibia@ultraschall.com.ar'],
]);

// ── Leer la variable ────────────────────────────────────────────────────────

test('sin la variable el filtro esta apagado: se procesan todos los negocios', () => {
    // Es el estado FINAL del sistema, no un caso raro: el freno es para la
    // etapa de pruebas y despues se saca.
    const f = soloOwner.leer({});
    assert.strictEqual(f.activo, false);
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: AJENO }).admite, true);
});

test('la variable vacia o en blanco tampoco filtra', () => {
    for (const v of ['', '   ', ',', ' , ']) {
        assert.strictEqual(soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: v }).activo, false, `con ${JSON.stringify(v)}`);
    }
});

test('separa IDs de mails y no los confunde', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: '83855505, matias.tari@idpartners.ar ,83714552' });
    assert.deepStrictEqual([...f.ids].sort(), ['83714552', '83855505']);
    assert.deepStrictEqual([...f.mails], ['matias.tari@idpartners.ar']);
});

// ── Decidir ─────────────────────────────────────────────────────────────────

test('con el filtro puesto entra el negocio propio y no el ajeno', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: MIO });
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: MIO }).admite, true);

    const no = soloOwner.admite({ filtro: f, ownerId: AJENO });
    assert.strictEqual(no.admite, false);
    assert.match(no.motivo, /90573354/, 'el motivo dice de quien era, para poder leerlo en el log');
});

test('el owner llega como numero o como string y da igual', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: MIO });
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: 83855505 }).admite, true);
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: ' 83855505 ' }).admite, true);
});

test('un negocio SIN owner no entra cuando el filtro esta puesto', () => {
    // El lado seguro. Un negocio sin dueño no es "mio": es justo el huerfano de
    // comercial que la prueba no tiene que tocar.
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: MIO });
    for (const v of [undefined, null, '', '   ']) {
        const r = soloOwner.admite({ filtro: f, ownerId: v });
        assert.strictEqual(r.admite, false, `con ownerId ${JSON.stringify(v)}`);
    }
});

test('un negocio sin owner SI entra cuando el filtro esta apagado', () => {
    // Lo de arriba no puede convertirse en una regla nueva del sistema: sin
    // filtro, el circuito se comporta exactamente como antes.
    const f = soloOwner.leer({});
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: null }).admite, true);
});

// ── Por mail ────────────────────────────────────────────────────────────────

test('el filtro por mail resuelve contra la tabla de owners', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: 'matias.tari@idpartners.ar' });
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: MIO, owners: OWNERS }).admite, true);
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: AJENO, owners: OWNERS }).admite, false);
});

test('el mail no distingue mayusculas, en la variable ni en la tabla', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: 'Matias.TARI@IdPartners.ar' });
    const owners = { [MIO]: 'MATIAS.TARI@idpartners.AR' };
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: MIO, owners }).admite, true);
});

test('la tabla de owners se acepta como Map o como objeto', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: 'matias.tari@idpartners.ar' });
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: MIO, owners: { [MIO]: 'matias.tari@idpartners.ar' } }).admite, true);
});

test('sin la tabla de owners, un filtro por mail NO deja pasar a nadie', () => {
    // Si la lectura de owners falla, la prueba no corre. Es preferible a que
    // corra sobre todo el portal por no haber podido resolver un mail.
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: 'matias.tari@idpartners.ar' });
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: MIO, owners: null }).admite, false);
});

test('con un ID en la lista no hace falta leer la tabla de owners', () => {
    // Corre en el camino caliente de cada mensaje: el caso normal no paga red.
    assert.strictEqual(soloOwner.necesitaOwners(soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: MIO })), false);
    assert.strictEqual(soloOwner.necesitaOwners(soloOwner.leer({})), false);
    assert.strictEqual(soloOwner.necesitaOwners(soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: 'a@b.c' })), true);
});

test('mezclando ID y mail alcanza con que resuelva uno', () => {
    const f = soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: `${MIO},otro@idpartners.ar` });
    assert.strictEqual(soloOwner.admite({ filtro: f, ownerId: MIO, owners: null }).admite, true, 'el ID resuelve sin tabla');
});

test('la descripcion dice con que quedo configurado', () => {
    assert.match(soloOwner.descripcion(soloOwner.leer({})), /todos/i);
    assert.match(soloOwner.descripcion(soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: MIO })), /SOLO.*83855505/);
});
