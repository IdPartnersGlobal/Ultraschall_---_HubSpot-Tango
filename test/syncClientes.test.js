'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { crear } = require('../src/lib/mapper');
const { Lookups } = require('../src/lib/lookups');
const sync = require('../src/lib/syncClientes');
const mapeoClientes = require('../config/mapeo.clientes.json');

/**
 * El sync de empresas desde el 2026-09-15 (§7.15), decisiones de Matias:
 * vincula las importadas en cada corrida, etiqueta lo que no cierra, no pisa lo
 * cargado en HubSpot, crea la basura etiquetada y solo escribe contra
 * productivo.
 *
 * Los clientes de Tango son del fixture real; las empresas de HubSpot, inventadas.
 */

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));
const lk = Lookups.desdeRegistros({
    condicionesVenta: fixture('condicionesVenta'),
    vendedores: fixture('vendedores'),
    transportes: fixture('transportes'),
    provincias: fixture('provincias'),
    zonas: fixture('zonas'),
    alicuotasIva: fixture('alicuotasIva'),
});
const m = crear(mapeoClientes, lk);
const clientes = fixture('clientes-muestra');

const A = clientes[0]; // 000003 ARCANA SRL, Responsable Inscripto
const B = clientes.find((c, i) => i > 0 && String(c.CUIT || '').length === 13 && c.COD_GVA14 !== A.COD_GVA14);
const digitos = (v) => String(v ?? '').replace(/\D/g, '');

/** Como llego una empresa con la importacion: codigo y datos, sin clave. */
const importada = (id, fila, over = {}) => ({
    id,
    properties: { codigo_tango: fila.COD_GVA14, cuit: digitos(fila.CUIT), name: `Ficha ${id}`, razon_social: 'Razon cargada a mano', ...over },
});

const plan = (registros, existentes) => sync.planificar({ registros, existentes, m, ahora: new Date('2026-09-15T12:00:00Z') });
const porId = (p, id) => p.updates.find((u) => u.id === id)?.properties;
const porClave = (p, cod) => p.upserts.find((u) => u.id === cod)?.properties;

// ── vincular las importadas ─────────────────────────────────────────────────

test('una importada que es su cliente se VINCULA por ID: no se crea otra ficha', () => {
    const p = plan([A], [importada('h1', A)]);

    assert.strictEqual(p.upserts.length, 0, 'un upsert por clave no la encontraria y crearia otra');
    const w = porId(p, 'h1');
    assert.ok(w, 'se escribe la empresa importada');
    assert.strictEqual(w.tango_codigo_cliente, A.COD_GVA14, 'la clave del sync');
    assert.strictEqual(w.tango_id_gva14, A.ID_GVA14);
    assert.ok(w.tango_sync_hash);
    assert.strictEqual(w.tango_estado, 'vinculada');
    assert.strictEqual(w.tango_estado_detalle, '');
    assert.strictEqual(p.resumen.aVincular, 1);
    assert.strictEqual(p.resumen.aCrear, 0);
});

test('lo cargado en HubSpot no se pisa, lo vacio se completa y el ID de IVA se corrige', () => {
    const p = plan([A], [importada('h1', A, { tango_id_categoria_iva: '0' })]);
    const w = porId(p, 'h1');

    for (const cargado of ['razon_social', 'cuit', 'name', 'codigo_tango']) {
        assert.strictEqual(w[cargado], undefined, `${cargado} lo cargo la importacion: no se pisa`);
    }
    assert.strictEqual(w.condicion_iva, 'Responsable Inscripto', 'estaba vacia: se completa');
    assert.strictEqual(w.tango_id_categoria_iva, 1, 'el 0 de la planilla es RI, que en Tango es el ID 1');
});

test('se busca el codigo TAL CUAL: 00003 no es 000003', () => {
    const p = plan([A], [importada('h1', A, { codigo_tango: '00003' })]);
    assert.strictEqual(porId(p, 'h1').tango_estado, 'no_existe');
    assert.strictEqual(porId(p, 'h1').tango_codigo_cliente, undefined);
});

// ── lo que no cierra se etiqueta y no se toca ───────────────────────────────

test('un codigo que Tango no tiene: se etiqueta y no se escribe nada mas', () => {
    const p = plan([A], [importada('h2', { COD_GVA14: '009999', CUIT: '' })]);
    assert.deepStrictEqual(porId(p, 'h2'), {
        tango_estado: 'no_existe',
        tango_estado_detalle: 'En Tango no existe ningún cliente con el código 009999.',
    });
});

test('un codigo de otro cliente: se etiqueta con de quien es, y ese cliente no se crea encima', () => {
    const p = plan([A], [importada('h3', A, { cuit: '30999999995', name: 'Tienda Demo', razon_social: 'Tienda Demo SA' })]);

    const w = porId(p, 'h3');
    assert.strictEqual(w.tango_estado, 'codigo_de_otro_cliente');
    assert.match(w.tango_estado_detalle, new RegExp(`En Tango el ${A.COD_GVA14} es «${A.RAZON_SOCI}», CUIT ${A.CUIT}`));
    assert.strictEqual(w.tango_codigo_cliente, undefined);
    assert.strictEqual(p.upserts.length, 0, 'dos fichas con el mismo codigo: la gente no sabria cual es');
    assert.strictEqual(p.resumen.conflictos.length, 1);
});

test('dos fichas que son el mismo cliente: ninguna se vincula', () => {
    const p = plan([A], [importada('h4', A), importada('h5', A)]);

    for (const id of ['h4', 'h5']) {
        assert.strictEqual(porId(p, id).tango_estado, 'ficha_duplicada');
        assert.strictEqual(porId(p, id).tango_codigo_cliente, undefined, 'la clave es unica: una de las dos escrituras fallaria');
    }
    assert.match(porId(p, 'h4').tango_estado_detalle, /«Ficha h5»/, 'dice cual es la otra');
    assert.strictEqual(p.upserts.length, 0);
});

// ── crear ───────────────────────────────────────────────────────────────────

test('un cliente sin ninguna ficha se crea, con su estado', () => {
    const p = plan([B], []);
    const w = porClave(p, B.COD_GVA14);
    assert.ok(w);
    assert.strictEqual(w.tango_estado, 'vinculada');
    assert.strictEqual(p.resumen.aCrear, 1);
});

test('un cliente basura se crea igual, etiquetado, y decide la gente', () => {
    const basura = { ...B, COD_GVA14: '999990', RAZON_SOCI: 'Clinica Demo - NO USAR' };
    const w = porClave(plan([basura], []), '999990');
    assert.strictEqual(w.tango_estado, 'marcada_para_borrar');
    assert.match(w.tango_estado_detalle, /figura como «Clinica Demo - NO USAR»\. Decidir si se sigue usando/);
});

test('la basura se reconoce por palabra entera, no por fragmento', () => {
    for (const nombre of ['borrar Clinica Viedma S.A.', 'MD Bios (NO USAR)', 'Vital Life S.A. - REPETIDO', 'ANULADO Hospital', 'Berchi Eduardo  DAR DE BAJA', 'Empresa de Prueba API S.A.']) {
        assert.strictEqual(sync.esBasura({ RAZON_SOCI: nombre }), true, nombre);
    }
    // Casos reales del padron que un criterio por fragmento se llevaba.
    for (const nombre of ['Testa Virginia', 'Global Testing SRL', 'Bajamich Mariano', 'Carabajal Luciana', 'Mazzuco Contestin Lucia', 'Pruebas Clinicas SA']) {
        assert.strictEqual(sync.esBasura({ RAZON_SOCI: nombre }), false, nombre);
    }
    assert.strictEqual(sync.esBasura({ RAZON_SOCI: 'Dorgan Hector', NOM_COM: 'MD Bios (NO USAR)' }), true, 'tambien el nombre de fantasia');
});

// ── las que ya estan vinculadas ─────────────────────────────────────────────

/** Una company que el sync ya dejo al dia. */
function yaSincronizada(id, fila) {
    const creada = porClave(plan([fila], []), fila.COD_GVA14);
    return { id, properties: { ...creada } };
}

test('una ya vinculada y sin cambios no se reescribe', () => {
    const p = plan([B], [yaSincronizada('h6', B)]);
    assert.strictEqual(p.updates.length, 0);
    assert.strictEqual(p.upserts.length, 0);
    assert.strictEqual(p.resumen.sinCambios, 1);
});

test('una ya vinculada sin estado recibe SOLO la etiqueta', () => {
    const c = yaSincronizada('h6', B);
    delete c.properties.tango_estado;
    delete c.properties.tango_estado_detalle;
    const p = plan([B], [c]);
    assert.deepStrictEqual(porId(p, 'h6'), { tango_estado: 'vinculada', tango_estado_detalle: '' });
    assert.strictEqual(p.resumen.etiquetasCambiadas, 1);
});

test('una vinculada a un cliente que NO es: no se le pisa nada', () => {
    // La empresa de prueba al pasar a productivo (2026-09-15): tenia la clave y
    // el ID de un cliente de la copia. Pisarla le cambiaba los IDs, y el
    // proximo pedido salia a nombre de otro.
    const prueba = { id: 'h7', properties: { tango_codigo_cliente: A.COD_GVA14, codigo_tango: A.COD_GVA14, tango_id_gva14: '6424', name: 'EMPRESA DE PRUEBA', razon_social: 'EMPRESA DE PRUEBA SA', cuit: '30999999995' } };
    const p = plan([A], [prueba]);

    assert.strictEqual(p.upserts.length, 0, 'ni se actualiza ni se crea');
    assert.deepStrictEqual(Object.keys(porId(p, 'h7')).sort(), ['tango_estado', 'tango_estado_detalle']);
    assert.strictEqual(porId(p, 'h7').tango_estado, 'codigo_de_otro_cliente');
});

test('si ya hay una vinculada, la importada que es el mismo cliente queda como duplicada', () => {
    const p = plan([B], [yaSincronizada('h6', B), importada('h9', B)]);
    assert.strictEqual(porId(p, 'h9').tango_estado, 'ficha_duplicada');
    assert.strictEqual(porId(p, 'h9').tango_codigo_cliente, undefined);
});

test('a una empresa que le borraron el codigo se le limpia la etiqueta', () => {
    const p = plan([A], [{ id: 'h8', properties: { name: 'Prospecto', tango_estado: 'no_existe', tango_estado_detalle: 'En Tango no existe...' } }]);
    assert.deepStrictEqual(porId(p, 'h8'), { tango_estado: '', tango_estado_detalle: '' });
});

test('un prospecto sin codigo ni etiqueta no se toca', () => {
    const p = plan([A], [{ id: 'h10', properties: { name: 'Prospecto' } }]);
    assert.strictEqual(porId(p, 'h10'), undefined);
});

// ── configuracion ───────────────────────────────────────────────────────────

test('el sync solo ESCRIBE contra la empresa 3 de Tango', () => {
    assert.throws(() => sync.verificarEmpresaDeTango({ TANGO_COMPANY: '11' }, false), /empresa 3/);
    assert.throws(() => sync.verificarEmpresaDeTango({ TANGO_COMPANY: '1' }, false), /empresa 3/);
    assert.doesNotThrow(() => sync.verificarEmpresaDeTango({ TANGO_COMPANY: '3' }, false));
    assert.doesNotThrow(() => sync.verificarEmpresaDeTango({ TANGO_COMPANY: '11' }, true), 'en dry-run corre contra cualquiera');
});

test('sin TANGO_COMPANY no arranca: ya no cae en la empresa 1', () => {
    assert.throws(() => sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'x', HUBSPOT_TOKEN: 'x' }), /TANGO_COMPANY/);
});

test('se lee todo lo que planificar mira', () => {
    // La leccion de §9.12 y §9.16: una propiedad que no se pide llega vacia, y
    // "vacio" aca es "no se respeta" o "no hay codigo".
    const leidas = sync.propiedadesALeer(m);
    for (const p of ['tango_codigo_cliente', 'tango_sync_hash', 'tango_estado', 'tango_estado_detalle', 'codigo_tango', 'cuit', 'razon_social', 'name', ...m.camposNoAutoritativos()]) {
        assert.ok(leidas.includes(p), `planificar lee '${p}' y no se pide`);
    }
});

test('cada estado es una opcion del desplegable: si no, HubSpot rechaza la tanda', () => {
    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'tango_estado');
    for (const estado of Object.values(sync.ESTADOS)) {
        assert.ok(campo.opciones[estado], `'${estado}' no es opcion de tango_estado`);
        assert.ok(campo.opcionesEtiquetas[estado], `'${estado}' no tiene etiqueta`);
    }
});
