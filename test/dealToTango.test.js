'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const d2t = require('../src/lib/dealToTango');
const etapas = require('../src/lib/etapas');
const verificarPedido = require('../src/lib/verificarPedido');
const firma = require('../src/lib/firmaHubSpot');
const { Lookups } = require('../src/lib/lookups');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

const lk = Lookups.desdeRegistros({
    condicionesVenta: fixture('condicionesVenta'),
    vendedores: fixture('vendedores'),
    transportes: fixture('transportes'),
    provincias: fixture('provincias'),
    zonas: fixture('zonas'),
    alicuotasIva: fixture('alicuotasIva'),
});

const SECRETO = 'client-secret-de-prueba';
const URI = 'https://ultraschall.azurewebsites.net/api/dealToTango';

/** Una peticion firmada como la manda HubSpot. */
function peticion(cuerpo, { ahora = Date.now(), secreto = SECRETO, uri = URI } = {}) {
    const cuerpoCrudo = JSON.stringify(cuerpo);
    const timestamp = String(ahora);
    return {
        metodo: 'POST', uri, cuerpoCrudo, secreto: SECRETO, ahora,
        headers: {
            'x-hubspot-signature-v3': firma.firmar({ metodo: 'POST', uri, cuerpo: cuerpoCrudo, timestamp, secreto }),
            'x-hubspot-request-timestamp': timestamp,
        },
    };
}

const eventoGanado = (objectId = 111, propertyValue = 'closedwon') => ([{ objectId, propertyName: 'dealstage', propertyValue, subscriptionType: 'object.propertyChange' }]);

// ── Etapas ganadas ───────────────────────────────────────────────────────

test('los dos embudos cuentan como ganado', () => {
    // El portal tiene dos: Ventas Ultraschall (closedwon) y Licitaciones
    // (1376134021). Comparar contra el string 'closedwon' perderia en SILENCIO
    // todos los ganados de licitaciones.
    assert.strictEqual(etapas.esGanada('closedwon'), true);
    assert.strictEqual(etapas.esGanada('1376134021'), true, 'Embudo de Licitaciones');
    assert.strictEqual(etapas.esGanada('closedlost'), false);
    assert.strictEqual(etapas.esGanada('decisionmakerboughtin'), false);
    assert.strictEqual(etapas.esGanada(null), false);
});

test('las etapas ganadas se sacan de los pipelines reales', () => {
    const pipelines = [{
        label: 'Nuevo embudo',
        stages: [
            { id: 'algo', metadata: { isClosed: 'false', probability: '0.5' } },
            { id: 'ganado-nuevo', metadata: { isClosed: 'true', probability: '1.0' } },
            { id: 'perdido-nuevo', metadata: { isClosed: 'true', probability: '0.0' } },
        ],
    }];
    const g = etapas.desdePipelines(pipelines);
    assert.deepStrictEqual([...g], ['ganado-nuevo'], 'cerrada Y probabilidad 1');
});

test('isClosed llega como string: tratarlo como booleano daria todas ganadas', () => {
    const pipelines = [{ stages: [{ id: 'x', metadata: { isClosed: 'false', probability: '1.0' } }] }];
    // 'false' es un string truthy. Si se leyera mal, 'x' entraria.
    assert.deepStrictEqual([...etapas.desdePipelines(pipelines)], [...etapas.GANADAS], 'cae al fallback, no inventa');
});

// ── Admision ─────────────────────────────────────────────────────────────

test('una peticion legitima con un negocio ganado se admite', () => {
    const r = d2t.admitir(peticion(eventoGanado()));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.eventos.length, 1);
});

test('una firma que no cierra es 401 y no se lee nada', () => {
    const p = peticion(eventoGanado());
    p.headers['x-hubspot-signature-v3'] = 'firma-falsa';
    assert.strictEqual(d2t.admitir(p).status, 401);
});

test('un cambio de etapa que no es ganado se descarta con 204', () => {
    // Es el caso mayoritario: llegan peticiones por TODO cambio de etapa.
    const r = d2t.admitir(peticion(eventoGanado(111, 'decisionmakerboughtin')));
    assert.strictEqual(r.status, 204);
});

test('un cambio de otra propiedad se descarta', () => {
    const r = d2t.admitir(peticion([{ objectId: 1, propertyName: 'amount', propertyValue: '100' }]));
    assert.strictEqual(r.status, 204);
});

test('de una tanda mixta se quedan solo los ganados', () => {
    const cuerpo = [
        { objectId: 1, propertyName: 'dealstage', propertyValue: 'closedwon' },
        { objectId: 2, propertyName: 'dealstage', propertyValue: 'closedlost' },
        { objectId: 3, propertyName: 'dealstage', propertyValue: '1376134021' },
        { objectId: 4, propertyName: 'amount', propertyValue: '5' },
    ];
    const r = d2t.admitir(peticion(cuerpo));
    assert.deepStrictEqual(r.eventos.map((e) => e.objectId), [1, 3]);
});

test('un cuerpo que no es JSON no explota: 204', () => {
    const cuerpoCrudo = 'esto no es json';
    const timestamp = String(Date.now());
    const headers = {
        'x-hubspot-signature-v3': firma.firmar({ metodo: 'POST', uri: URI, cuerpo: cuerpoCrudo, timestamp, secreto: SECRETO }),
        'x-hubspot-request-timestamp': timestamp,
    };
    const r = d2t.admitir({ metodo: 'POST', uri: URI, cuerpoCrudo, headers, secreto: SECRETO });
    assert.strictEqual(r.status, 204);
});

// ── Verificacion del pedido ──────────────────────────────────────────────

const COMPANY = {
    codigo_tango: '000123',
    tango_id_gva14: '2590',
    tango_id_gva01: '5',
    tango_id_gva10: '3',
    tango_id_gva23: '10',
    tango_id_gva24: '5',
};

const linea = (over = {}) => ({
    id: '900',
    properties: { name: 'Ecografo', quantity: '2', price: '48999', hs_product_id: '77', hs_discount_percentage: '0', ...over },
});

const PRODUCTOS = new Map([['77', { name: 'Ecografo', tango_id_sta11: '394' }]]);

const verificar = (over = {}) => verificarPedido.verificar({
    deal: { hs_object_id: '111', dealname: 'Venta demo', closedate: '2026-08-25T00:00:00Z' },
    company: COMPANY,
    lineItems: [linea()],
    productos: PRODUCTOS,
    lookups: lk,
    ...over,
});

test('un negocio ganado completo arma el payload del pedido', () => {
    const r = verificar();
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_GVA14, 2590);
    assert.strictEqual(r.payload.RENGLON_DTO.length, 1);
    assert.deepStrictEqual(r.payload.RENGLON_DTO[0], {
        ID_STA11: 394, CANTIDAD_PEDIDA: 2, PRECIO: 48999, PORCENTAJE_BONIFICACION: 0, ID_STA22: 1, OBSERVACIONES: '',
    });
});

test('la parametria del pedido la hereda del cliente', () => {
    const r = verificar();
    assert.strictEqual(r.payload.ID_GVA01, 5);
    assert.strictEqual(r.payload.ID_GVA10, 3);
    assert.strictEqual(r.payload.ID_GVA23, 10);
    assert.strictEqual(r.payload.ID_GVA24, 5);
    assert.ok(r.heredado.ID_GVA01.deLaCompany, 'salio de la company, no del default');
});

test('si la company no trae la parametria, va el default del catalogo', () => {
    const r = verificar({ company: { codigo_tango: '000123', tango_id_gva14: '2590' } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_GVA01, 1, 'CONTADO');
    assert.strictEqual(r.heredado.ID_GVA01.deLaCompany, false);
});

test('el talonario, el deposito, la moneda y el stock salen de los defaults', () => {
    const r = verificar();
    assert.strictEqual(r.payload.ID_GVA43_TALON_PED, 1, 'PROVISORIO: falta el process de GVA43');
    assert.strictEqual(r.payload.ID_STA22, 1, 'PROVISORIO: falta el process de STA22');
    assert.strictEqual(r.payload.ID_MONEDA, 1);
    assert.strictEqual(r.payload.VALIDA_STOCK, true, 'decision de Matias 2026-08-25');
});

test('el ID del Deal viaja al ERP para poder rastrear el pedido', () => {
    // Es el numero que genera HubSpot solo: no se inventa una numeracion.
    const r = verificar();
    assert.match(r.payload.LEYENDA_4, /111/);
});

test('un negocio sin empresa asociada es un problema', () => {
    const r = verificar({ company: null });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'ID_GVA14'));
});

test('un negocio sin renglones es un problema', () => {
    const r = verificar({ lineItems: [] });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'RENGLON_DTO'));
});

test('un producto que no esta atado a Tango frena el renglon y lo dice', () => {
    // Es el bloqueo esperado hasta que corra el sync de productos.
    const r = verificar({ productos: new Map([['77', { name: 'Ecografo' }]]) });
    assert.strictEqual(r.ok, false);
    assert.match(r.problemas[0].motivo, /tango_id_sta11/);
});

test('una linea escrita a mano, sin producto del catalogo, se rechaza', () => {
    const r = verificar({ lineItems: [linea({ hs_product_id: undefined })] });
    assert.strictEqual(r.ok, false);
    assert.match(r.problemas[0].motivo, /catalogo/);
});

test('cantidad o precio sin sentido frenan el renglon', () => {
    for (const over of [{ quantity: '0' }, { quantity: '' }, { price: '' }, { price: '-5' }]) {
        const r = verificar({ lineItems: [linea(over)] });
        assert.strictEqual(r.ok, false, `deberia rechazar ${JSON.stringify(over)}`);
    }
});

test('una company sin tango_id_gva14 NO es un problema: es un cliente a crear', () => {
    // La distincion importa: es lo que dispara el alta en vez de un rechazo.
    const r = verificar({ company: { codigo_tango: '', tango_id_gva14: '' } });
    assert.strictEqual(r.cliente.faltaAlta, true);
    assert.ok(!r.problemas.some((p) => p.campo === 'ID_GVA14'), 'no se reporta como problema');
    assert.strictEqual(r.payload.ID_GVA14, undefined, 'y el payload queda sin cliente hasta crearlo');
});

test('la fecha va sin zona horaria: Tango no interpreta el offset', () => {
    assert.strictEqual(verificarPedido.fechaTango('2026-08-25T00:00:00Z'), '2026-08-25T00:00:00');
    assert.match(verificarPedido.fechaTango(''), /^\d{4}-\d{2}-\d{2}T00:00:00$/, 'sin fecha usa hoy');
    assert.match(verificarPedido.fechaTango('cualquier cosa'), /^\d{4}-\d{2}-\d{2}T00:00:00$/);
});

// ── El circuito, con dobles ──────────────────────────────────────────────

/** Un HubSpot de mentira que registra lo que se le pide y lo que se le escribe. */
function hsFalso({ deal = {}, company = COMPANY, lineItems = [linea()], productos = [{ id: '77', properties: { tango_id_sta11: '394' } }] } = {}) {
    const escrituras = [];
    return {
        escrituras,
        async objeto(objetoTipo, id) {
            if (objetoTipo === 'deals') return { id, properties: { hs_object_id: id, dealname: 'Venta demo', closedate: '2026-08-25T00:00:00Z', ...deal } };
            return null;
        },
        async asociaciones(_o, _id, destino) {
            if (destino === 'companies') return company ? ['555'] : [];
            return lineItems.map((l) => l.id);
        },
        async objetos(objetoTipo, ids) {
            if (objetoTipo === 'companies') return company ? [{ id: '555', properties: company }] : [];
            if (objetoTipo === 'line_items') return lineItems;
            return productos.filter((p) => ids.includes(p.id));
        },
        async actualizarObjeto(objetoTipo, id, props) { escrituras.push({ objetoTipo, id, props }); return {}; },
    };
}

const tangoFalso = (respuesta = { NRO_PEDIDO: '00012345' }) => ({
    creados: [],
    async create(process, payload) { this.creados.push({ process, payload }); return respuesta; },
});

test('un negocio ganado completo crea el pedido y lo anota en el Deal', async () => {
    const hs = hsFalso();
    const tango = tangoFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'creado');
    assert.strictEqual(r.nroPedido, '00012345');
    assert.strictEqual(tango.creados.length, 1);
    assert.strictEqual(tango.creados[0].process, 19845);

    const esc = hs.escrituras.at(-1);
    assert.strictEqual(esc.objetoTipo, 'deals');
    assert.strictEqual(esc.props.tango_nro_pedido, '00012345');
    assert.strictEqual(esc.props.tango_pedido_cliente, '000123');
    assert.strictEqual(esc.props.tango_pedido_problema, '', 'se limpia el problema anterior');
});

test('un Deal que ya tiene pedido no se manda de nuevo, y no lee nada mas', async () => {
    // Es la guarda de 9.3. Tambien es lo que salva del reintento de HubSpot
    // cuando la respuesta tarda (riesgo 5).
    const hs = hsFalso({ deal: { tango_nro_pedido: '00099' } });
    const tango = tangoFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'ya-tenia');
    assert.strictEqual(tango.creados.length, 0, 'no se toca el ERP');
    assert.strictEqual(hs.escrituras.length, 0, 'ni se escribe nada');
});

test('si falta algo, el problema queda escrito en el Deal y no se crea el pedido', async () => {
    // Sin esto el unico rastro queda en los logs de Azure, donde comercial no entra.
    const hs = hsFalso({ productos: [{ id: '77', properties: {} }] });
    const tango = tangoFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(tango.creados.length, 0);
    assert.match(hs.escrituras.at(-1).props.tango_pedido_problema, /tango_id_sta11/);
});

test('en dry-run no se crea nada ni se escribe nada', async () => {
    const hs = hsFalso();
    const tango = tangoFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: true });

    assert.strictEqual(r.estado, 'dry-run');
    assert.strictEqual(tango.creados.length, 0);
    assert.strictEqual(hs.escrituras.length, 0);
    assert.ok(r.payload.RENGLON_DTO.length, 'pero deja ver el payload que habria mandado');
});

test('si Tango no devuelve numero de pedido se usa el ID del Deal', async () => {
    const hs = hsFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso({ succeeded: true }), lookups: lk, dryRun: false });
    assert.strictEqual(r.nroPedido, '111');
});

test('numeroDePedido reconoce las formas que devuelve Tango', () => {
    assert.strictEqual(d2t.numeroDePedido({ NRO_PEDIDO: '123' }), '123');
    assert.strictEqual(d2t.numeroDePedido({ value: { ID_GVA21: 77 } }), '77');
    assert.strictEqual(d2t.numeroDePedido({ succeeded: true }), null);
    assert.strictEqual(d2t.numeroDePedido(null), null);
});

test('un negocio que no existe en HubSpot no rompe el circuito', async () => {
    const hs = { ...hsFalso(), async objeto() { return null; } };
    const r = await d2t.procesarDeal({ dealId: '999', hs, tango: tangoFalso(), lookups: lk, dryRun: false });
    assert.strictEqual(r.estado, 'incompleto');
});

test('leerConfig exige el client secret, que no es el token', () => {
    assert.throws(
        () => d2t.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'x', HUBSPOT_TOKEN: 'x' }),
        /HUBSPOT_CLIENT_SECRET/
    );
    const cfg = d2t.leerConfig({ TANGO_API_URL: 'x', TANGO_API_KEY: 'x', HUBSPOT_TOKEN: 'x', HUBSPOT_CLIENT_SECRET: 'y' });
    assert.strictEqual(cfg.DRY_RUN, true, 'el dry-run es el default');
});
