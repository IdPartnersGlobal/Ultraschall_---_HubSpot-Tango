'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sync = require('../src/lib/syncProductos');
const { crear } = require('../src/lib/mapper');
const mapeoProductos = require('../config/mapeo.productos.json');

const CLAVE = mapeoProductos._meta.claveIdempotencia.tango; // COD_STA11

const articulo = (cod, over = {}) => ({
    COD_STA11: cod,
    ID_STA11: Number(cod.replace(/\D/g, '')) || 1,
    DESCRIPCIO: `Articulo ${cod}`,
    STOCK: true,
    ...over,
});

// ── El filtro de la corrida de prueba ────────────────────────────────────

test('sin codigos, pasan todos', () => {
    const r = sync.filtrar([articulo('A1'), articulo('A2')], [], CLAVE);
    assert.strictEqual(r.registros.length, 2);
    assert.deepStrictEqual(r.noEncontrados, []);
});

test('con un codigo, pasa solo ese', () => {
    // El caso real: la primera corrida contra el ERP va con UN articulo.
    const r = sync.filtrar([articulo('A1'), articulo('A2'), articulo('A3')], ['A2'], CLAVE);
    assert.deepStrictEqual(r.registros.map((x) => x.COD_STA11), ['A2']);
});

test('un codigo que no existe se reporta, no se ignora', () => {
    // Si alguien escribe mal el codigo de prueba, el sync no puede terminar
    // diciendo "0 productos" como si estuviera todo bien.
    const r = sync.filtrar([articulo('A1')], ['A1', 'NO-EXISTE'], CLAVE);
    assert.deepStrictEqual(r.registros.map((x) => x.COD_STA11), ['A1']);
    assert.deepStrictEqual(r.noEncontrados, ['NO-EXISTE']);
});

test('el filtro ignora espacios de mas', () => {
    const r = sync.filtrar([articulo('A1')], ['  A1  '], CLAVE);
    assert.strictEqual(r.registros.length, 1);
});

test('leerSoloCodigos parte la lista y limpia', () => {
    assert.deepStrictEqual(sync.leerSoloCodigos('A1, A2 ,,A3 '), ['A1', 'A2', 'A3']);
    assert.deepStrictEqual(sync.leerSoloCodigos(''), []);
    assert.deepStrictEqual(sync.leerSoloCodigos(undefined), [], 'sin la variable, van todos');
});

// ── El precio, que es lo que no viene ────────────────────────────────────

test('el articulo se mapea sin precio, y no escribe un precio vacio', () => {
    // process=87 no trae precio en ninguno de sus 141 campos. Lo que importa es
    // que `price` NO viaje: escribir vacio pisaria un precio cargado a mano.
    const m = crear(mapeoProductos);
    const { propiedades } = m.aHubSpot(articulo('001'));
    assert.strictEqual(propiedades.price, undefined);
    assert.strictEqual(propiedades.hs_sku, '001', 'pero si viaja el SKU, que es la clave');
    assert.strictEqual(propiedades.tango_id_sta11, 1, 'y el ID interno, que es lo que necesita la Fase 4');
});

test('tango_id_sta11 es lo que destraba los renglones del pedido', () => {
    // El renglon necesita ID_STA11; el precio lo pone el line item del Deal.
    const m = crear(mapeoProductos);
    const { propiedades } = m.aHubSpot(articulo('123', { ID_STA11: 394 }));
    assert.strictEqual(propiedades.tango_id_sta11, 394);
});

// ── La corrida ───────────────────────────────────────────────────────────

test('leerConfig exige lo minimo y deja el dry-run como default', () => {
    assert.throws(() => sync.leerConfig({ TANGO_API_URL: 'x' }), /TANGO_API_KEY/);

    const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't' });
    assert.strictEqual(cfg.DRY_RUN, true);
    assert.deepStrictEqual(cfg.SOLO_CODIGOS, []);
    assert.strictEqual(cfg.TANGO_COMPANY, '1');
});

test('SYNC_PRODUCTOS_SOLO limita la corrida', () => {
    const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', SYNC_PRODUCTOS_SOLO: 'ART-001' });
    assert.deepStrictEqual(cfg.SOLO_CODIGOS, ['ART-001']);
});

test('solo un escritor: el dry-run es lo que sale por default', () => {
    for (const v of [undefined, 'true', 'TRUE', 'cualquier cosa']) {
        const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', SYNC_DRY_RUN: v });
        assert.strictEqual(cfg.DRY_RUN, true, `'${v}' no deberia habilitar la escritura`);
    }
    const cfg = sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', SYNC_DRY_RUN: 'false' });
    assert.strictEqual(cfg.DRY_RUN, false, 'solo un false explicito escribe');
});

test('el hash evita reescribir un articulo que no cambio', () => {
    // Es lo mismo que hace el sync de clientes: sin el hash, cada corrida
    // reescribiria el catalogo entero.
    const m = crear(mapeoProductos);
    const a = articulo('001');
    const h1 = m.hash(m.aHubSpot(a).propiedades);
    const h2 = m.hash(m.aHubSpot(articulo('001')).propiedades);
    assert.strictEqual(h1, h2, 'el mismo articulo da el mismo hash');

    const h3 = m.hash(m.aHubSpot(articulo('001', { DESCRIPCIO: 'Otra cosa' })).propiedades);
    assert.notStrictEqual(h1, h3, 'y si cambia, cambia');
});

test('el mapper NO emite precio: viene de otra tabla y lo agrega el sync', () => {
    // Decision de Matias 2026-08-25: los precios se cargan a mano en HubSpot.
    // Desde el 2026-08-31 el precio ya tiene origen (GVA17), pero `tango` sigue
    // en null a proposito: el mapper mapea el registro de STA11 y el precio
    // vive en otra tabla, asi que lo inyecta lib/syncProductos en el paso 4b.
    // Darle un origen aca haria que el mapper buscara una columna inexistente.
    const price = mapeoProductos.campos.find((c) => c.hubspot === 'price');
    assert.strictEqual(price.tango, null, 'el precio no sale del registro de STA11');
    assert.ok(price.origenReal, 'pero tiene que estar dicho de donde sale de verdad');
    assert.strictEqual(price.autoritativoTango, false, 'no pisa lo cargado a mano');

    const m = crear(mapeoProductos);
    assert.strictEqual(m.aHubSpot(articulo('BAT250')).propiedades.price, undefined);
});

// ── La corrida entera, con precios (9.12) ────────────────────────────────

const silencioso = { paso() {}, aviso() {}, datos() {}, error() {} };

/**
 * Arnes: Tango y HubSpot de mentira.
 *
 * `preciosPorId` es lo que devuelve GVA17 por articulo; `enHubSpot` es lo que
 * ya existe en el portal.
 */
function arnes({ articulos, preciosPorId = {}, enHubSpot = [] }) {
    const escrituras = [];
    const getByIdLlamados = [];

    const tango = {
        async get() { return { registros: articulos, total: articulos.length }; },
        async getByFilter() {
            return articulos.filter((a) => preciosPorId[a.ID_STA11] !== undefined);
        },
        async getById(_p, id) {
            getByIdLlamados.push(id);
            const precio = preciosPorId[id];
            return { GVA17: precio === undefined ? [] : [{ NRO_DE_LIS: 2, ID_GVA10: 2, PRECIO: precio }] };
        },
    };

    const hs = {
        // Devuelve SOLO las propiedades que se le piden, como HubSpot de
        // verdad. Un fake que devuelve todo esconde el bug de no pedir una
        // propiedad: fue exactamente lo que paso con `price`.
        async leerTodos(_objeto, propiedades = []) {
            const pedidas = new Set(propiedades);
            return enHubSpot.map((r) => ({
                ...r,
                properties: Object.fromEntries(
                    Object.entries(r.properties || {}).filter(([k]) => pedidas.has(k)),
                ),
            }));
        },
        async batchUpsert(_o, _k, registros) {
            escrituras.push(...registros);
            return { procesados: registros.length, fallidos: [] };
        },
    };

    return { tango, hs, escrituras, getByIdLlamados };
}

const config = { TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', LISTA_PRECIOS: 2, SOLO_CODIGOS: [] };

test('el precio de la lista configurada llega al producto nuevo', async () => {
    const a = arnes({ articulos: [articulo('BAT250', { ID_STA11: 187 })], preciosPorId: { 187: 70 } });
    const r = await sync.correr({ config, log: silencioso, dryRun: false, tango: a.tango, hs: a.hs });

    assert.strictEqual(r.aCrear, 1);
    assert.strictEqual(r.preciosCompletados, 1);
    assert.strictEqual(r.nombreLista, 'SIN IVA EN U$S', 'el resumen dice de que lista salio');
    assert.strictEqual(a.escrituras[0].properties.price, 70);
    assert.strictEqual(a.escrituras[0].id, 'BAT250');
});

test('un articulo sin precio en la lista se publica igual, sin price', async () => {
    // 83% del catalogo no tiene precio cargado en Tango. Un catalogo sin
    // precios sigue sirviendo: el renglon del pedido necesita ID_STA11.
    const a = arnes({ articulos: [articulo('APY', { ID_STA11: 5 })], preciosPorId: {} });
    const r = await sync.correr({ config, log: silencioso, dryRun: false, tango: a.tango, hs: a.hs });

    assert.strictEqual(r.aCrear, 1);
    assert.strictEqual(r.preciosCompletados, 0);
    assert.strictEqual(a.escrituras[0].properties.price, undefined, 'nunca un precio vacio');
    assert.ok(a.escrituras[0].properties.tango_id_sta11, 'pero si el ID que necesita el pedido');
});

test('un articulo SIN CAMBIOS al que recien le cargaron el precio igual lo recibe', async () => {
    // El precio no esta en el hash, asi que el corte por hash lo saltearia y el
    // producto se quedaria sin precio para siempre. Es el caso que obliga a
    // decidir los candidatos ANTES del corte.
    const art = articulo('BAT250', { ID_STA11: 187 });
    const m = crear(mapeoProductos);
    const hashActual = m.hash(m.aHubSpot(art).propiedades);

    const a = arnes({
        articulos: [art],
        preciosPorId: { 187: 70 },
        enHubSpot: [{ properties: { hs_sku: 'BAT250', tango_sync_hash: hashActual, price: '' } }],
    });

    const r = await sync.correr({ config, log: silencioso, dryRun: false, tango: a.tango, hs: a.hs });

    assert.strictEqual(r.sinCambios, 0, 'dejo de estar "sin cambios" porque le falta el precio');
    assert.strictEqual(r.aActualizar, 1);
    assert.strictEqual(a.escrituras.length, 1);
    assert.strictEqual(a.escrituras[0].properties.price, 70);
    assert.strictEqual(a.escrituras[0].properties.tango_sync_hash, hashActual, 'el hash no cambia: STA11 no cambio');
});

test('si falla la lectura de precios, el catalogo se publica igual', async () => {
    // Un problema con GVA17 no puede voltear el sync entero.
    const a = arnes({ articulos: [articulo('BAT250', { ID_STA11: 187 })], preciosPorId: { 187: 70 } });
    a.tango.getByFilter = async () => { throw new Error('Tango rechazo la consulta'); };

    const r = await sync.correr({ config, log: silencioso, dryRun: false, tango: a.tango, hs: a.hs });

    assert.strictEqual(r.aCrear, 1, 'el articulo se publica');
    assert.strictEqual(a.escrituras[0].properties.price, undefined);
    assert.ok(r.problemas.some((p) => /precios/.test(p)), 'y queda dicho que fallo');
});

test('con la lista apagada no se consulta ningun precio', async () => {
    const a = arnes({ articulos: [articulo('BAT250', { ID_STA11: 187 })], preciosPorId: { 187: 70 } });
    const r = await sync.correr({ config: { ...config, LISTA_PRECIOS: null }, log: silencioso, dryRun: false, tango: a.tango, hs: a.hs });

    assert.strictEqual(r.preciosCompletados, 0);
    assert.deepStrictEqual(a.getByIdLlamados, []);
    assert.strictEqual(a.escrituras[0].properties.price, undefined);
});

test('la lista sale de defaults y el entorno solo la pisa', () => {
    const base = { TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't' };
    const defaults = require('../config/defaults.tango.json');

    assert.strictEqual(sync.leerConfig(base).LISTA_PRECIOS, defaults.productos.listaPrecios);
    assert.strictEqual(sync.leerConfig({ ...base, TANGO_LISTA_PRECIOS: '3' }).LISTA_PRECIOS, 3);
    assert.strictEqual(sync.leerConfig({ ...base, TANGO_LISTA_PRECIOS: '0' }).LISTA_PRECIOS, null, '0 apaga los precios');
});

test('un precio ya cargado en HubSpot no se toca, y ni siquiera se consulta', async () => {
    const a = arnes({
        articulos: [articulo('BAT250', { ID_STA11: 187 })],
        preciosPorId: { 187: 70 },
        enHubSpot: [{ properties: { hs_sku: 'BAT250', tango_sync_hash: 'viejo', price: '99999' } }],
    });

    const r = await sync.correr({ config, log: silencioso, dryRun: true, tango: a.tango, hs: a.hs });
    assert.strictEqual(r.preciosRespetados, 1, 'el cargado a mano se respeta');
    assert.deepStrictEqual(a.getByIdLlamados, [], 'y no se gasta un request en algo que no se va a escribir');
});

// ── Que articulos se publican: el PERFIL ─────────────────────────────────

test('los articulos de compras no van al catalogo comercial', () => {
    // C = solo compras: barra de grilon, cinta de embalaje, manija. No se venden.
    const r = sync.porPerfil([
        articulo('A1', { PERFIL: 'A' }),
        articulo('BAR', { PERFIL: 'C' }),
        articulo('SCS', { PERFIL: 'V' }),
        articulo('BAT300', { PERFIL: 'N' }),
    ], ['A', 'V']);

    assert.deepStrictEqual(r.registros.map((x) => x.COD_STA11), ['A1', 'SCS']);
    assert.deepStrictEqual(r.excluidos.map((x) => x.COD_STA11), ['BAR', 'BAT300']);
});

test('los servicios SI se publican: se venden aunque no se stockeen', () => {
    // V son Service, Reparacion, Envio a domicilio. Dejarlos afuera sacaria del
    // catalogo cosas que Ultraschall factura.
    const r = sync.porPerfil([articulo('SCS', { PERFIL: 'V' })], ['A', 'V']);
    assert.strictEqual(r.registros.length, 1);
});

test('una lista de perfiles vacia publica todo: se puede volver atras sin tocar codigo', () => {
    const todos = [articulo('A1', { PERFIL: 'A' }), articulo('BAR', { PERFIL: 'C' })];
    assert.strictEqual(sync.porPerfil(todos, []).registros.length, 2);
    assert.strictEqual(sync.porPerfil(todos, null).registros.length, 2);
});

test('el perfil se compara sin distinguir mayusculas ni espacios', () => {
    const r = sync.porPerfil([articulo('A1', { PERFIL: ' a ' })], ['A', 'V']);
    assert.strictEqual(r.registros.length, 1);
});

test('un articulo sin PERFIL no se publica: no se adivina', () => {
    const r = sync.porPerfil([articulo('A1', { PERFIL: null })], ['A', 'V']);
    assert.strictEqual(r.registros.length, 0);
});

test('pedir un articulo de compras dice POR QUE no se publico, no "no existe"', async () => {
    // El mensaje viejo habria dicho que el articulo no esta en Tango, que es
    // falso y manda a buscar el problema al lugar equivocado.
    const a = arnes({ articulos: [articulo('BAR', { ID_STA11: 9, PERFIL: 'C' })] });
    const r = await sync.correr({
        config: { ...config, SOLO_CODIGOS: ['BAR'], PERFILES: ['A', 'V'] },
        log: silencioso, dryRun: true, tango: a.tango, hs: a.hs,
    });

    assert.strictEqual(r.excluidosPorPerfil, 1);
    assert.ok(r.problemas.some((p) => /PERFIL es 'C'/.test(p)), JSON.stringify(r.problemas));
});

test('los defaults publican A y V, que son los que se venden', () => {
    const defaults = require('../config/defaults.tango.json');
    assert.deepStrictEqual(defaults.productos.perfilesQueSePublican, ['A', 'V']);
    assert.deepStrictEqual(sync.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't' }).PERFILES, ['A', 'V']);
});
