'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const d2t = require('../src/lib/dealToTango');
const etapas = require('../src/lib/etapas');
const notaProblema = require('../src/lib/notaProblema');
const verificarPedido = require('../src/lib/verificarPedido');
const firma = require('../src/lib/firmaHubSpot');
const { TangoError } = require('../src/lib/tangoClient');
const { Lookups } = require('../src/lib/lookups');
const defaults = require('../config/defaults.tango.json');
const MAPEO_PEDIDOS = require('../config/mapeo.pedidos.json');
const CATALOGO = require('../config/tango.processes.json');
const propiedades = require('../src/lib/propiedades');

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


// ── Retroceder una etapa (§9.9) ─────────────────────────────────────────

test('la etapa anterior sale de los embudos REALES del portal', () => {
    // Fija el orden de hoy. Si alguien reordena el embudo, se rompe este test
    // y no un pedido: hoy 'Cierre perdido' va DESPUES de 'Cierre ganado'
    // (displayOrder 6 contra 5) en los dos embudos, y por eso retroceder por
    // displayOrder es seguro. Si eso cambiara, dejaria de serlo.
    const ps = require('./fixtures/pipelines-deals.json').pipelines;

    const ventas = etapas.anterior('closedwon', ps);
    assert.strictEqual(ventas.id, 'decisionmakerboughtin');
    assert.strictEqual(ventas.label, 'Negociación');
    assert.strictEqual(ventas.pipelineLabel, 'Embudo de Ventas Ultraschall');

    const licitaciones = etapas.anterior('1376134021', ps);
    assert.strictEqual(licitaciones.id, '1376134020');
    assert.strictEqual(licitaciones.label, 'Pendiente OC/Contrato');

    for (const p of ps) {
        const orden = Object.fromEntries(p.stages.map((s) => [s.label, Number(s.displayOrder)]));
        assert.ok(orden['Cierre perdido'] > orden['Cierre ganado'],
            `en '${p.label}' Cierre perdido dejo de ir despues de Cierre ganado: revisar etapas.anterior`);
    }
});

test('retroceder NUNCA cae en otra etapa ganada', () => {
    // Mover la etapa dispara el webhook otra vez: caer en una ganada seria un bucle.
    const pipelines = [{
        id: 'p', label: 'Raro',
        stages: [
            { id: 'primera', label: 'Primera', displayOrder: 0 },
            { id: 'ganado-viejo', label: 'Ganado viejo', displayOrder: 1 },
            { id: 'closedwon', label: 'Cierre ganado', displayOrder: 2 },
        ],
    }];
    const ganadas = new Set(['closedwon', 'ganado-viejo']);
    assert.strictEqual(etapas.anterior('closedwon', pipelines, ganadas).id, 'primera');
});

test('sin etapa anterior no se inventa ninguna', () => {
    const pipelines = [{ id: 'p', label: 'X', stages: [{ id: 'unica', label: 'Unica', displayOrder: 0 }] }];
    assert.strictEqual(etapas.anterior('unica', pipelines), null, 'ya estaba en la primera');
    assert.strictEqual(etapas.anterior('fantasma', pipelines), null, 'no pertenece a ningun embudo');
    assert.strictEqual(etapas.anterior(null, pipelines), null);
    assert.strictEqual(etapas.anterior('closedwon', []), null, 'sin embudos no se mueve nada');
});

test('anterior se ordena por displayOrder, no por como vengan', () => {
    const pipelines = [{
        id: 'p', label: 'X',
        stages: [
            { id: 'c', label: 'C', displayOrder: 2 },
            { id: 'a', label: 'A', displayOrder: 0 },
            { id: 'b', label: 'B', displayOrder: 1 },
        ],
    }];
    assert.strictEqual(etapas.anterior('c', pipelines).id, 'b');
});

// ── El texto de la nota ─────────────────────────────────────────────────

test('la nota dice que falta, como se arregla y que hacer despues', () => {
    const html = notaProblema.cuerpo({
        problemas: [{ campo: 'RAZON_SOCI', propiedad: 'razon_social', motivo: 'esta vacio', comoSeArregla: 'cargarlo en la empresa' }],
        retroceso: { label: 'Negociación' },
        etapaGanada: 'Cierre ganado',
    });
    assert.match(html, /Razon Social/, 'la etiqueta, no RAZON_SOCI ni razon_social');
    assert.ok(!/RAZON_SOCI|razon_social/.test(html), `la nota muestra el nombre interno: ${html}`);
    assert.match(html, /esta vacio/);
    assert.match(html, /cargarlo en la empresa/, 'decir que falta sin decir como no alcanza');
    assert.match(html, /Negociación/, 'donde quedo el negocio');
    assert.match(html, /Cierre ganado/, 'como se reintenta');
});

test('la nota escapa lo que venga de datos', () => {
    // El cuerpo se interpreta como HTML: un nombre con < o & romperia la nota.
    const html = notaProblema.cuerpo({ problemas: [{ campo: 'name', motivo: '<script>x</script> & cia' }] });
    assert.ok(!html.includes('<script>'), 'no puede entrar markup desde los datos');
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp; cia/);
});

test('sin retroceso la nota no dice que se movio, pero si como reintentar', () => {
    const html = notaProblema.cuerpo({ problemas: [{ campo: 'x', motivo: 'y' }], retroceso: null });
    assert.ok(!html.includes('se movió a'), 'no puede decir que se movio si no se movio');
    assert.ok(html.includes('movelo de nuevo a <b>Cierre ganado</b>'));
});

test('la nota NUNCA dice "volvé a guardar el negocio"', () => {
    // Guardar el negocio no dispara nada: el webhook escucha el cambio de
    // ETAPA. La cola de veneno decia eso y mandaba a hacer algo inutil.
    for (const html of [
        notaProblema.cuerpo({ problemas: [{ campo: 'x', motivo: 'y' }] }),
        notaProblema.cuerpo({ problemas: [{ campo: 'x', motivo: 'y' }], tipo: 'tecnico' }),
        notaProblema.cuerpo({ problemas: [{ campo: 'x', motivo: 'y' }], retroceso: { label: 'Negociación' } }),
    ]) {
        assert.ok(!/guardar el negocio/i.test(html), html);
    }
});

test('una falla tecnica NO le pide a comercial que cargue nada', () => {
    // Es el caso de la cola de veneno: el ERP se cayo. Decirle "faltan datos"
    // lo manda a buscar lo que no existe.
    const html = notaProblema.cuerpo({
        problemas: [{ campo: 'Tango', motivo: 'el ERP no respondio', comoSeArregla: 'avisar a sistemas' }],
        retroceso: { label: 'Negociación' },
        tipo: 'tecnico',
    });
    assert.match(html, /No falta ningún dato del negocio/);
    assert.ok(!/Faltan? d* ?dato/.test(html.replace('No falta ningún dato del negocio', '')));
    assert.match(html, /cuando Tango vuelva a estar disponible/i);
});

test('la nota cuenta los problemas en singular y en plural', () => {
    assert.match(notaProblema.cuerpo({ problemas: [{ campo: 'a', motivo: 'b' }] }), /Falta este dato/);
    assert.match(notaProblema.cuerpo({ problemas: [{ campo: 'a', motivo: 'b' }, { campo: 'c', motivo: 'd' }] }), /Faltan 2 datos/);
});


// ── "Se creo con lo minimo, completá esto" (§9.10) ───────────────────────

test('la nota de datos a completar dice que YA salio, no que fallo', () => {
    const html = notaProblema.cuerpoACompletar({
        avisos: [{ campo: 'CUIT', motivo: 'esta vacio: el cliente se crea sin ese dato', comoSeArregla: 'cargar cuit en la empresa' }],
        cliente: { codigo: '007611' },
    });
    assert.match(html, /se creó en Tango/);
    assert.match(html, /007611/, 'con que codigo quedo, para poder buscarlo en el ERP');
    assert.match(html, /CUIT/);
    assert.match(html, /Queda un dato/);
    assert.ok(!/no se pudo/i.test(html), 'no puede leerse como un error: el pedido salio');
});

test('anotarACompletar deja SOLO una nota: ni propiedad ni etapa', async () => {
    // El negocio se gano y el pedido existe. Moverlo seria mentirle al embudo.
    const hs = hsFalso();
    await d2t.anotarACompletar({
        hs, dealId: '111',
        avisos: [{ campo: 'DOMICILIO', motivo: 'esta vacio', comoSeArregla: 'cargarlo' }],
        cliente: { codigo: '007611' },
    });
    assert.strictEqual(hs.notas.length, 1);
    assert.strictEqual(hs.escrituras.length, 0, 'no toca ninguna propiedad');
    assert.strictEqual(hs.etapaFinal, null, 'y no mueve la etapa');
});

test('que falle la nota de completar no tumba el pedido, que ya salio', async () => {
    const hs = hsFalso();
    hs.crearNota = async () => { throw new Error('HubSpot rechazo la nota'); };
    await d2t.anotarACompletar({ hs, dealId: '111', avisos: [{ campo: 'CUIT', motivo: 'x' }], cliente: {} });
});

test('exigiendo la empresa completa, lo que antes era aviso ahora frena', () => {
    // Da vuelta la politica del 2026-08-28 vista desde el pedido (§9.22): el
    // CUIT y el domicilio ya no viajan como aviso despues de crear el pedido,
    // porque no habia forma de que ese dato llegara nunca a Tango.
    const verificarEmpresa = require('../src/lib/verificarEmpresa');
    const mapper = require('../src/lib/mapper');
    const mapeoClientes = require('../config/mapeo.clientes.json');
    const r = verificarEmpresa.verificar({
        propiedades: { razon_social: 'ACME SA', condicion_iva: 'Responsable Inscripto' },
        mapper: mapper.crear(mapeoClientes, lk),
        lookups: lk,
        ownerId: 'farancibia@ultraschall.com.ar',
    });
    assert.strictEqual(r.ok, false, 'con la empresa a medias no se crea nada');
    const campos = r.problemas.map((p) => p.campo).sort();
    assert.deepStrictEqual(campos, ['CUIT', 'DOMICILIO'], JSON.stringify(r.problemas));
    for (const p of r.problemas) assert.ok(p.comoSeArregla, `el problema de ${p.campo} no dice que hacer`);
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

/** El estado REAL del portal hoy: el producto existe pero no esta atado a Tango. */
const SIN_ATAR = new Map([['77', { name: 'Ecografo' }]]);

const PRUEBA = require('../config/defaults.tango.json').pedidos.productoDePrueba;

/** Un Deal completo. `tango_fecha_entrega` es obligatoria desde §9.18. */
const DEAL_BASE = { hs_object_id: '111', dealname: 'Venta demo', closedate: '2026-08-25T00:00:00Z', tango_fecha_entrega: '2026-09-07' };

// El `deal` se MEZCLA en vez de reemplazarse: si no, cada override tendria que
// acordarse de repetir los campos obligatorios, y el test fallaria por lo que
// no esta probando.
const verificar = ({ deal = {}, ...over } = {}) => verificarPedido.verificar({
    deal: { ...DEAL_BASE, ...deal },
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
    // Los tres primeros dejaron de ser provisorios el 2026-08-28: se leyeron de
    // los pedidos que el ERP ya tiene cargados. Evidencia y metodo en
    // config/defaults.tango.json -> pedidos._comoSeVerifico.
    assert.strictEqual(r.payload.ID_GVA43_TALON_PED, 1, 'talonario 2 PEDIDOS, el unico en uso');
    assert.strictEqual(r.payload.ID_STA22, 1, 'deposito 01 PRODUCTO TERMINADO, 66% de los pedidos');
    assert.strictEqual(r.payload.ID_MONEDA, 1, 'PES');
    assert.strictEqual(r.payload.VALIDA_STOCK, true, 'decision de Matias 2026-08-25');
});

test('los defaults del pedido apuntan a filas que existen en el ERP', () => {
    // Que el numero sea 1 no dice nada: el codigo no es el ID (5.4). Lo que
    // importa es que ese ID este en la tabla que se relevo. Si alguien cambia
    // un default a ojo, esto se cae.
    const catalogo = require('../config/tango.processes.json');
    const d = defaults.pedidos.defaults;

    const talonario = catalogo.auxiliares.talonariosPedido.filas
        .find((f) => f.ID_GVA43_TALON_PED === d.ID_GVA43_TALON_PED);
    assert.ok(talonario, `ID_GVA43_TALON_PED ${d.ID_GVA43_TALON_PED} no esta en GVA43`);
    assert.strictEqual(talonario.DESCRIPCION_TALONARIO_PEDIDO, 'PEDIDOS');

    const deposito = catalogo.auxiliares.depositos.filas
        .find((f) => f.ID_STA22 === d.ID_STA22);
    assert.ok(deposito, `ID_STA22 ${d.ID_STA22} no esta en STA22`);
    assert.strictEqual(deposito.NOMBRE_SUC, 'PRODUCTO TERMINADO');

    // Y el default de lista de precios del cliente tiene que existir tambien.
    const gva10 = defaults.clientes.alta.campos.find((c) => c.tango === 'ID_GVA10');
    assert.ok(catalogo.auxiliares.listasPrecios.filas
        .some((f) => String(f.NRO_DE_LIS) === gva10.codigoPorDefecto));
});


// --------------------------------------------- el deposito que elige comercial

const conDeposito = (valor) => verificar({
    deal: { ...{ hs_object_id: '111', dealname: 'Venta demo', closedate: '2026-08-25T00:00:00Z' }, tango_deposito: valor },
});

test('sin elegir deposito va el default, y el pedido no marca nada', () => {
    const r = verificar();
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.deepStrictEqual(r.elegido, {}, 'no eligio nada: no hay que inventar que si');
    assert.strictEqual(r.payload.ID_STA22, 1, 'PRODUCTO TERMINADO');
});

test('el deposito elegido en el Deal le gana al default', () => {
    const r = conDeposito('36');
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_STA22, 16, 'SERVICIO TECNICO');
    assert.strictEqual(r.elegido.ID_STA22.descripcion, 'SERVICIO TECNICO');
});

test('el renglon sale del mismo deposito que la cabecera', () => {
    // Si no, el pedido diria una cosa y la mercaderia saldria de otro lado.
    const r = conDeposito('36');
    assert.strictEqual(r.payload.RENGLON_DTO[0].ID_STA22, r.payload.ID_STA22);
});

test('el desplegable guarda el CODIGO, no el ID interno', () => {
    // Es 5.4 otra vez, y aca el modo de falla es mudo: el codigo 36 tambien es
    // un ID_STA22 valido (SERVICE US es 2, pero 36 existe en otras auxiliares).
    // Mandar el codigo como ID despacharia de otro deposito sin ningun error.
    const r = conDeposito('36');
    assert.notStrictEqual(r.payload.ID_STA22, 36, 'mando el codigo en vez del ID');
    assert.strictEqual(r.elegido.ID_STA22.codigo, '36');
});

test('cada deposito del desplegable resuelve a un ID que existe', () => {
    for (const cod of Object.values(MAPEO_PEDIDOS.campos.find((c) => c.hubspot === 'tango_deposito').opciones)) {
        const r = conDeposito(cod);
        assert.strictEqual(r.ok, true, `el deposito '${cod}' no resolvio: ${JSON.stringify(r.problemas)}`);
        assert.ok(Number.isInteger(r.payload.ID_STA22), `'${cod}' no dio un ID`);
    }
});

test('un deposito que no esta en la lista FRENA el pedido, no cae al default', () => {
    // Caer al default seria despachar desde otro deposito, valido, sin que nada
    // falle. Es el peor error posible de este circuito, y por eso no es un
    // aviso: con ok=false dealToTango escribe el motivo en tango_pedido_problema
    // y NO llama a Api/Create.
    const r = conDeposito('99');
    assert.strictEqual(r.ok, false);
    const p = r.problemas.find((x) => x.campo === 'ID_STA22');
    assert.ok(p, JSON.stringify(r.problemas));
    assert.match(p.motivo, /99/, 'el problema tiene que decir QUE se eligio');
    assert.ok(p.comoSeArregla, 'comercial tiene que poder leer que hacer');
});

test('el talonario tambien se puede elegir, aunque hoy haya uno solo', () => {
    const r = verificar({ deal: { ...{ hs_object_id: '111', dealname: 'Venta demo', closedate: '2026-08-25T00:00:00Z' }, tango_talonario: '2' } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_GVA43_TALON_PED, 1, 'el codigo es 2 y el ID es 1');
});

test('el desplegable muestra texto y guarda el codigo', () => {
    // Lo que ve comercial no puede ser '36'. Y lo que se guarda no puede ser
    // 'SERVICIO TECNICO', porque el ERP puede renombrar el deposito.
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.hubspot === 'tango_deposito');
    const opciones = propiedades.opcionesDe(campo);
    const habilitados = CATALOGO.auxiliares.depositos.filas.filter((f) => !f.deBaja);
    assert.strictEqual(opciones.length, habilitados.length,
        'el desplegable ofrece exactamente los depositos habilitados de STA22');
    assert.deepStrictEqual(opciones[0], { label: 'PRODUCTO TERMINADO', value: '01', displayOrder: 0, hidden: false },
        'PRODUCTO TERMINADO va primero: es el 66% de los pedidos');
    for (const o of opciones) assert.notStrictEqual(o.label, o.value, `'${o.value}' quedo sin etiqueta legible`);
});

test('cada opcion del desplegable existe en la tabla del catalogo', () => {
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.hubspot === 'tango_deposito');
    const delCatalogo = new Set(CATALOGO.auxiliares.depositos.filas.map((f) => String(f.COD_STA22)));
    for (const cod of Object.values(campo.opciones)) {
        assert.ok(delCatalogo.has(cod), `la opcion '${cod}' no esta en STA22`);
    }
    assert.strictEqual(campo.opcionesOrden.length, Object.keys(campo.opciones).length,
        'el orden tiene que nombrar a todas las opciones');
});

test('un deposito INHABILITADO en Tango no se le ofrece a comercial', () => {
    // Los 9 inhabilitados aparecieron recien con el process 2941 (9.11). Uno de
    // ellos, ABREGU CBA PRUEBA-DEVOLUCION (cod 38), ya estaba en el desplegable
    // de las 16: entro por la puerta de atras, porque el metodo viejo miraba los
    // pedidos y ese deposito tenia uno viejo. Ofrecerlo es ofrecer un despacho
    // que el ERP no acepta.
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.hubspot === 'tango_deposito');
    const ofrecidos = new Set(Object.keys(campo.opciones));
    const deBaja = CATALOGO.auxiliares.depositos.filas.filter((f) => f.deBaja);

    assert.ok(deBaja.length > 0, 'si STA22 dejo de traer inhabilitados, este test perdio sentido');
    for (const f of deBaja) {
        assert.ok(!ofrecidos.has(String(f.COD_STA22)),
            `'${f.COD_STA22}' (${f.NOMBRE_SUC}) esta inhabilitado en Tango y sigue en el desplegable`);
    }
});

test('los defaults del pedido no llevan metadata al ERP', () => {
    // `defaults` se derrama tal cual en el payload: una clave de documentacion
    // ahi adentro viaja a Tango. Paso el 2026-08-28 con _evidencia.
    for (const bloque of [defaults.pedidos.defaults, defaults.clientes.defaults]) {
        for (const k of Object.keys(bloque)) {
            assert.ok(!k.startsWith('_'), `'${k}' es documentacion y esta adentro de defaults`);
        }
    }
    for (const k of Object.keys(verificar().payload)) {
        assert.ok(!k.startsWith('_'), `'${k}' llego al payload de Tango`);
    }
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

test('un producto que no esta atado a Tango frena el renglon, si no hay articulo de prueba', () => {
    // Era el bloqueo esperado hasta que corriera el sync de productos. Desde el
    // 2026-08-27 lo tapa el articulo de prueba (§9.6); apagado, vuelve a frenar.
    const r = verificar({ productos: SIN_ATAR, productoDePrueba: null });
    assert.strictEqual(r.ok, false);
    assert.match(r.problemas[0].motivo, /no está vinculado/);
    assert.ok(!/tango_id_sta11/.test(r.problemas[0].motivo), 'sin nombres internos: lo lee comercial');
});

// ── El articulo de prueba (§9.6) ─────────────────────────────────────────

test('un producto sin ID de Tango sale igual, con el articulo de prueba', () => {
    // Sin esto el circuito no se puede probar punta a punta: HOY ningun product
    // del portal tiene tango_id_sta11, asi que TODOS los pedidos se frenaban.
    const r = verificar({ productos: SIN_ATAR });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.problemas.length, 0);
    assert.strictEqual(r.payload.RENGLON_DTO[0].ID_STA11, PRUEBA.idSta11);
    assert.strictEqual(r.payload.RENGLON_DTO[0].CANTIDAD_PEDIDA, 2, 'la cantidad es la de la linea real');
    assert.strictEqual(r.payload.RENGLON_DTO[0].PRECIO, 48999, 'y el precio tambien');
});

test('el reemplazo no pasa en silencio: queda avisado y marcado en el ERP', () => {
    // Un pedido de prueba tiene que ser reconocible DESDE Tango: si no, el dia
    // que se apague este modo no hay forma de saber cuales dar de baja.
    const r = verificar({ productos: SIN_ATAR });

    assert.strictEqual(r.avisos.length, 1);
    // Del catalogo, no escrito a mano: el articulo de prueba cambia (BAT250 ->
    // ZZZ el 2026-09-03, porque se quedo sin stock) y el test no tiene por que
    // romperse ni, peor, seguir verde mirando el articulo viejo.
    assert.ok(r.avisos[0].motivo.includes(PRUEBA.codigo), `el aviso no nombra a ${PRUEBA.codigo}: ${r.avisos[0].motivo}`);
    assert.strictEqual(r.payload.LEYENDA_3, verificarPedido.LEYENDA_PRUEBA);
    assert.match(r.payload.RENGLON_DTO[0].OBSERVACIONES, /Ecografo/, 'el articulo que correspondia viaja al ERP');
});

test('un producto que SI esta atado no usa el de prueba', () => {
    // El dia que corra el sync de productos esto se apaga solo, sin tocar nada.
    const r = verificar();
    assert.strictEqual(r.payload.RENGLON_DTO[0].ID_STA11, 394);
    assert.deepStrictEqual(r.avisos, []);
    assert.strictEqual(r.payload.LEYENDA_3, undefined, 'un pedido real no se marca como prueba');
});

test('una linea escrita a mano NO la cubre el articulo de prueba', () => {
    // No es la integracion que falta: es una linea mal cargada, y reemplazarla
    // por el articulo de prueba taparia el error.
    const r = verificar({ lineItems: [linea({ hs_product_id: undefined })], productos: SIN_ATAR });
    assert.strictEqual(r.ok, false);
    assert.match(r.problemas[0].motivo, /catalogo/);
});

test('el articulo de prueba se puede apagar y cambiar por entorno', () => {
    const resolver = verificarPedido.resolverProductoDePrueba;
    assert.strictEqual(resolver({}).idSta11, PRUEBA.idSta11, 'sin variable, manda el catalogo');

    for (const off of ['off', 'false', 'no', '0', 'OFF']) {
        assert.strictEqual(resolver({ TANGO_PRODUCTO_PRUEBA: off }), null, `${off} lo apaga`);
    }

    // Cambiar el articulo de prueba no puede exigir un despliegue.
    assert.strictEqual(resolver({ TANGO_PRODUCTO_PRUEBA: '512' }).idSta11, 512);
    assert.strictEqual(resolver({ TANGO_PRODUCTO_PRUEBA: 'cualquier cosa' }).idSta11, PRUEBA.idSta11, 'un valor sin sentido no apaga nada ni inventa un ID');
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

/** Los dos embudos REALES del portal (test/fixtures/pipelines-deals.json). */
const PIPELINES = require('./fixtures/pipelines-deals.json').pipelines;

/**
 * HubSpot devuelve SOLO las propiedades que se le piden. El doble tiene que
 * hacer lo mismo o esconde toda una clase de bug: la de no pedir una propiedad
 * que despues se lee.
 *
 * ⚠️ Sin esto, el 2026-09-02 `PROPS_COMPANY` no pedia `razon_social` ni
 * `condicion_iva` —el alta las veia `undefined` y NINGUN negocio podia crear su
 * empresa— y la suite entera pasaba en verde. Es la misma leccion que el arnes
 * del sync de productos aprendio el 31 con `price` (§9.12).
 *
 * Una lista vacia significa "todas", como en la API.
 */
function soloLasPedidas(props, propiedades = []) {
    if (!propiedades.length) return { ...props };
    const salida = {};
    for (const k of propiedades) if (props[k] !== undefined) salida[k] = props[k];
    // HubSpot siempre devuelve el id, se pida o no.
    if (props.hs_object_id !== undefined) salida.hs_object_id = props.hs_object_id;
    return salida;
}

/** Un HubSpot de mentira que registra lo que se le pide y lo que se le escribe. */
function hsFalso({ deal = {}, company = COMPANY, lineItems = [linea()], productos = [{ id: '77', properties: { tango_id_sta11: '394' } }], pipelines = PIPELINES } = {}) {
    const escrituras = [];
    const notas = [];
    return {
        escrituras,
        notas,
        /** El PATCH de la etapa, que es lo que hay que poder mirar aparte. */
        get etapaFinal() {
            return escrituras.filter((e) => e.props.dealstage).at(-1)?.props.dealstage ?? null;
        },
        problemaEscrito() {
            return escrituras.filter((e) => e.props.tango_pedido_problema !== undefined).at(-1)?.props.tango_pedido_problema;
        },
        async pipelines() {
            if (!pipelines) throw new Error('HubSpot no contesta los embudos');
            return pipelines;
        },
        async crearNota(objetoTipo, id, cuerpo) { notas.push({ objetoTipo, id, cuerpo }); return { id: 'n1' }; },
        async objeto(objetoTipo, id, propiedades = []) {
            // dealstage va por defecto: el webhook SOLO llega por un ganado.
            if (objetoTipo === 'deals') {
                return { id, properties: soloLasPedidas({ hs_object_id: id, dealname: 'Venta demo', closedate: '2026-08-25T00:00:00Z', dealstage: 'closedwon', tango_fecha_entrega: '2026-09-07', ...deal }, propiedades) };
            }
            // El alta relee la company antes de escribirle de vuelta, para no
            // pisar lo que se cargo a mano (lib/altaCliente).
            if (objetoTipo === 'companies') {
                return company ? { id, properties: soloLasPedidas({ hs_object_id: id, ...company }, propiedades) } : null;
            }
            return null;
        },
        async asociaciones(_o, _id, destino) {
            if (destino === 'companies') return company ? ['555'] : [];
            return lineItems.map((l) => l.id);
        },
        async objetos(objetoTipo, ids, propiedades = []) {
            if (objetoTipo === 'companies') return company ? [{ id: '555', properties: soloLasPedidas(company, propiedades) }] : [];
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
    // La linea escrita a mano es lo que sigue frenando el pedido desde que existe
    // el articulo de prueba (§9.6).
    const hs = hsFalso({ lineItems: [linea({ hs_product_id: undefined })] });
    const tango = tangoFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(tango.creados.length, 0);
    assert.match(hs.problemaEscrito(), /catalogo/);
});

// ── Un negocio incompleto: nota y vuelta atras (§9.9) ────────────────────

test('un negocio incompleto deja una nota que dice QUE falta', async () => {
    const hs = hsFalso({ lineItems: [linea({ hs_product_id: undefined })] });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(hs.notas.length, 1, 'una nota, no una por problema');
    assert.strictEqual(hs.notas[0].objetoTipo, 'deals');
    assert.strictEqual(hs.notas[0].id, '111');
    assert.match(hs.notas[0].cuerpo, /catalogo/, 'la nota dice que falta');
    assert.match(hs.notas[0].cuerpo, /Negociación/, 'y a que etapa se movio');
});

test('un negocio incompleto vuelve UNA etapa atras', async () => {
    const hs = hsFalso({ lineItems: [linea({ hs_product_id: undefined })] });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    assert.strictEqual(hs.etapaFinal, 'decisionmakerboughtin', 'Negociación, la anterior a Cierre ganado');
    assert.strictEqual(r.retroceso.label, 'Negociación');
});

test('la nota se escribe ANTES de mover la etapa', async () => {
    // Si se moviera primero, un fallo al anotar dejaria el negocio en otra
    // etapa sin ninguna explicacion.
    const orden = [];
    const hs = hsFalso({ lineItems: [linea({ hs_product_id: undefined })] });
    const notaOriginal = hs.crearNota, patchOriginal = hs.actualizarObjeto;
    hs.crearNota = async (...a) => { orden.push('nota'); return notaOriginal(...a); };
    hs.actualizarObjeto = async (o, i, props) => { if (props.dealstage) orden.push('etapa'); return patchOriginal(o, i, props); };

    await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });
    assert.deepStrictEqual(orden, ['nota', 'etapa']);
});

test('si la nota falla, el negocio se mueve igual', async () => {
    // El motivo ya quedo en tango_pedido_problema, y dejarlo en "Cierre ganado"
    // sin pedido es peor: parece cerrado y no lo esta.
    const hs = hsFalso({ lineItems: [linea({ hs_product_id: undefined })] });
    hs.crearNota = async () => { throw new Error('HubSpot rechazo la nota'); };

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });
    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(hs.etapaFinal, 'decisionmakerboughtin');
    assert.ok(hs.problemaEscrito(), 'la explicacion quedo en la propiedad');
});

test('un negocio de Licitaciones vuelve a la etapa de SU embudo', async () => {
    // Filtrar por 'closedwon' perderia los de licitaciones en silencio, y
    // retroceder con la tabla del otro embudo lo mandaria a cualquier lado.
    const hs = hsFalso({ deal: { dealstage: '1376134021' }, lineItems: [linea({ hs_product_id: undefined })] });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    assert.strictEqual(hs.etapaFinal, '1376134020');
    assert.strictEqual(r.retroceso.label, 'Pendiente OC/Contrato');
    assert.strictEqual(r.retroceso.pipelineLabel, 'Embudo de Licitaciones');
});

test('una re-entrega de la cola no duplica la nota ni retrocede dos etapas', async () => {
    // La cola es at-least-once (§9.5). La guarda no es un flag propio: es que
    // el negocio ya NO esta en una etapa ganada cuando vuelve el mensaje.
    const hs = hsFalso({ deal: { dealstage: 'decisionmakerboughtin' }, lineItems: [linea({ hs_product_id: undefined })] });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(hs.notas.length, 0, 'ya se habia anotado');
    assert.strictEqual(hs.etapaFinal, null, 'y no se retrocede otra etapa');
    assert.ok(hs.problemaEscrito(), 'la propiedad si se refresca: es idempotente');
});

test('si no se pueden leer los embudos, se anota igual y no se mueve nada', async () => {
    const hs = hsFalso({ pipelines: null, lineItems: [linea({ hs_product_id: undefined })] });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    assert.strictEqual(hs.notas.length, 1, 'reportar no depende de poder mover');
    assert.strictEqual(hs.etapaFinal, null);
    assert.strictEqual(r.retroceso, null);
});

test('en dry-run un negocio incompleto no deja nota ni se mueve', async () => {
    const hs = hsFalso({ lineItems: [linea({ hs_product_id: undefined })] });
    await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: true });

    assert.strictEqual(hs.notas.length, 0);
    assert.strictEqual(hs.escrituras.length, 0);
});

test('a una empresa incompleta se la reporta igual que a un negocio', async () => {
    // Es el caso REAL de hoy: 65 de 66 companies no se pueden dar de alta en
    // Tango. Quien tiene que cargar el dato es la misma persona, y no tiene por
    // que saber de que lado del circuito falto.
    const hs = hsFalso({ company: { name: 'Sin datos' } });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false, estrategiaNumeracion: 'correlativo' });

    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(hs.notas.length, 1);
    assert.strictEqual(hs.etapaFinal, 'decisionmakerboughtin');
});

test('el circuito entero sale con el articulo de prueba y crea el pedido', async () => {
    // Es el estado de HOY: el producto existe en el portal pero no esta atado.
    // Antes esto no llegaba nunca al ERP.
    const hs = hsFalso({ productos: [{ id: '77', properties: { name: 'Ecografo' } }] });
    const tango = tangoFalso();
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'creado');
    assert.strictEqual(r.avisos.length, 1, 'el reemplazo se informa');

    const payload = tango.creados[0].payload;
    assert.strictEqual(payload.RENGLON_DTO[0].ID_STA11, PRUEBA.idSta11);
    assert.strictEqual(payload.LEYENDA_3, verificarPedido.LEYENDA_PRUEBA);
    assert.strictEqual(payload.LEYENDA_4, 'HubSpot deal 111', 'sigue viajando el ID del negocio');
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

// ── El freno de las pruebas: solo los negocios de ciertos owners (§9.15) ─────

const MI_OWNER = '83855505';       // matias.tari@idpartners.ar
const OWNER_COMERCIAL = '90573354'; // farancibia@ultraschall.com.ar

const filtroMio = () => d2t.soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: MI_OWNER });
const filtroDe = (id) => d2t.soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: id });

/** Un comercial de los 23 que todavia no tienen vendedor equivalente. */
const OWNER_SIN_VENDEDOR = '90573361'; // pthaler@ultraschall.com.ar

/**
 * La tabla que devuelve `hs.owners()`. Desde el 2026-09-03 no es opcional: el
 * vendedor sale del owner del negocio y sin ella el alta frena.
 *
 * `matias.tari@` esta mapeado a FACUNDO a mano para poder probar (no es
 * vendedor); `pthaler@` es de los 23 que faltan y por eso frena.
 */
const OWNERS = new Map([
    [MI_OWNER, 'matias.tari@idpartners.ar'],
    [OWNER_COMERCIAL, 'farancibia@ultraschall.com.ar'],
    [OWNER_SIN_VENDEDOR, 'pthaler@ultraschall.com.ar'],
]);

test('un negocio de comercial NO se toca: ni pedido, ni propiedad, ni nota, ni etapa', async () => {
    // Es la razon de ser del freno. El caso peligroso no es el negocio ajeno
    // completo —ese saldria bien— sino el ajeno INCOMPLETO: sin filtro recibe
    // una nota y vuelve una etapa atras (§9.9), o sea que la prueba le mueve el
    // embudo a alguien que no sabe que hay una prueba corriendo.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL }, company: null });
    const tango = tangoFalso();

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false, filtroOwner: filtroMio() });

    assert.strictEqual(r.estado, 'ajeno');
    assert.strictEqual(hs.escrituras.length, 0, 'no se le escribio NADA al negocio');
    assert.strictEqual(hs.notas.length, 0, 'no se le dejo ninguna nota a comercial');
    assert.strictEqual(hs.etapaFinal, null, 'no se le movio la etapa');
    assert.strictEqual(tango.creados.length, 0, 'no se toco el ERP');
});

test('un negocio propio pasa el freno y sigue el circuito de siempre', async () => {
    const hs = hsFalso({ deal: { hubspot_owner_id: MI_OWNER } });
    const tango = tangoFalso();

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false, filtroOwner: filtroMio() });

    assert.strictEqual(r.estado, 'creado');
    assert.strictEqual(r.nroPedido, '00012345');
});

test('sin filtro, el circuito toma cualquier negocio: el freno no cambia el comportamiento final', async () => {
    // El estado al que se vuelve cuando la prueba termina. Si esto se rompiera,
    // el "freno de pruebas" se habria convertido en una regla permanente.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL } });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });
    assert.strictEqual(r.estado, 'creado');
});

test('el freno corre ANTES de la idempotencia y de las lecturas caras', async () => {
    // El orden importa: un negocio ajeno no puede costar ni una asociacion.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL, tango_nro_pedido: '00099' } });
    let leyoAsociaciones = false;
    const original = hs.asociaciones;
    hs.asociaciones = async (...a) => { leyoAsociaciones = true; return original(...a); };

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false, filtroOwner: filtroMio() });

    assert.strictEqual(r.estado, 'ajeno', 'gana el freno, no el "ya-tenia"');
    assert.strictEqual(leyoAsociaciones, false);
});

test('un negocio sin owner tampoco entra mientras el filtro este puesto', async () => {
    const hs = hsFalso({ deal: {}, company: null });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false, filtroOwner: filtroMio() });

    assert.strictEqual(r.estado, 'ajeno');
    assert.strictEqual(hs.notas.length, 0);
});

test('el filtro sale del entorno y llega por leerConfig', async () => {
    const env = {
        TANGO_API_URL: 'http://x', TANGO_API_KEY: 'k', HUBSPOT_TOKEN: 't', HUBSPOT_CLIENT_SECRET: 's',
        DEAL_TO_TANGO_SOLO_OWNER: MI_OWNER,
    };
    const cfg = d2t.leerConfig(env);
    assert.strictEqual(cfg.SOLO_OWNER.activo, true);
    assert.ok(cfg.SOLO_OWNER.ids.has(MI_OWNER));

    // Y sin la variable, apagado: el default no puede ser "filtrar".
    assert.strictEqual(d2t.leerConfig({ ...env, DEAL_TO_TANGO_SOLO_OWNER: undefined }).SOLO_OWNER.activo, false);
});

test('el Deal se lee pidiendo el owner: sin eso el freno no podria decidir', () => {
    // Falla si alguien saca la propiedad de PROPS_DEAL. Sin ella el owner
    // llega undefined y, con el filtro puesto, NADA entraria: la prueba punta a
    // punta se caeria sin decir por que.
    assert.ok(d2t.PROPS_DEAL.includes('hubspot_owner_id'));
});

// ── La cola de veneno, ahora testeable (antes vivia en functions/) ───────────

test('veneno: un negocio ajeno no recibe la nota tecnica ni retrocede', async () => {
    // Era la puerta de atras del freno: `dealVeneno` anota y mueve la etapa por
    // su cuenta, sin pasar por `procesarDeal`. Si el ERP se cae durante la
    // prueba, esto le movia el embudo a todos los negocios ganados del portal.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL } });

    const r = await d2t.procesarVeneno({ hs, dealId: '111', dryRun: false, filtroOwner: filtroMio() });

    assert.strictEqual(r.estado, 'ajeno');
    assert.strictEqual(hs.escrituras.length, 0);
    assert.strictEqual(hs.notas.length, 0);
    assert.strictEqual(hs.etapaFinal, null);
});

test('veneno: un negocio propio si recibe la nota y vuelve una etapa', async () => {
    const hs = hsFalso({ deal: { hubspot_owner_id: MI_OWNER } });

    const r = await d2t.procesarVeneno({ hs, dealId: '111', dryRun: false, filtroOwner: filtroMio() });

    assert.strictEqual(r.estado, 'reportado');
    assert.strictEqual(hs.notas.length, 1);
    assert.strictEqual(hs.etapaFinal, 'decisionmakerboughtin', 'vuelve a Negociacion, no a otra cosa');
    // El texto es el tecnico: aca no falta ningun dato que comercial pueda cargar.
    assert.match(hs.notas[0].cuerpo, /ERP no respondio|no se pudo crear/i);
});

test('veneno: sin filtro se comporta como siempre', async () => {
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL } });
    const r = await d2t.procesarVeneno({ hs, dealId: '111', dryRun: false });
    assert.strictEqual(r.estado, 'reportado');
    assert.strictEqual(hs.notas.length, 1);
});

test('veneno: en dry-run no toca el negocio', async () => {
    const hs = hsFalso({ deal: { hubspot_owner_id: MI_OWNER } });
    await d2t.procesarVeneno({ hs, dealId: '111', dryRun: true, filtroOwner: filtroMio() });
    assert.strictEqual(hs.escrituras.length, 0);
    assert.strictEqual(hs.notas.length, 0);
});

// ── El alta DESDE un negocio: el circuito entero, no cada pieza (§9.16) ──────

/** Una company completa y SIN código de Tango: la que dispara el alta al vuelo. */
const COMPANY_A_CREAR = {
    name: 'CLINICA DEMO',
    razon_social: 'CLINICA DEMO SA',
    cuit: 30999999995,
    condicion_iva: 'Responsable Inscripto',
    domicilio_del_consultorio: 'Av. Corrientes 1234',
    localidad: 'CABA',
    zip: '1043',
    provincia: 'caba',
    country: 'ARGENTINA',
    codigo_tango: '',
    tango_id_gva14: '',
};

test('un negocio con una company completa pero sin codigo de Tango LA DA DE ALTA', async () => {
    // El circuito entero, que es lo que ninguna prueba cubria: cada pieza tenia
    // su test y el conjunto estaba roto.
    //
    // ⚠️ Esto es lo que fallo en produccion el 2026-09-02. `PROPS_COMPANY` no
    // pedia `razon_social` ni `condicion_iva`, asi que llegaban `undefined`
    // aunque estuvieran cargadas y el alta las reportaba como faltantes:
    // NINGUN negocio podia crear su empresa, el 100% de las veces, y el mensaje
    // mandaba a cargar un dato que ya estaba.
    //
    // Falla si alguien vuelve a escribir PROPS_COMPANY a mano y se queda corto.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL }, company: COMPANY_A_CREAR });
    const tango = tangoFalso();
    // El alta pregunta por el ultimo codigo y despues crea. Le alcanza con esto.
    tango.get = async () => ({ registros: [{ COD_GVA14: '007610' }] });
    // El alta confirma contra el ERP que el cliente quedo creado antes de
    // seguir con el pedido, asi que el doble tiene que "recordarlo".
    const creadosEnTango = [];
    tango.getByFilter = async (_p, filtro) => creadosEnTango.filter((c) => filtro.includes(c.COD_GVA14));
    tango.create = async (process, payload) => {
        tango.creados.push({ process, payload });
        if (payload.COD_GVA14) creadosEnTango.push({ COD_GVA14: payload.COD_GVA14, ID_GVA14: 9001 });
        return { ID_GVA14: 9001, NRO_PEDIDO: '00012345' };
    };

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.notStrictEqual(r.estado, 'incompleto',
        `el alta no deberia frenar; freno con: ${r.motivo}`);
    assert.ok(tango.creados.length >= 1, 'se tiene que haber creado algo en Tango');

    const alta = tango.creados[0];
    assert.strictEqual(alta.payload.RAZON_SOCI, 'CLINICA DEMO SA',
        'la razon social tiene que LLEGAR al ERP, no perderse por no haberla pedido');
    assert.ok(alta.payload.ID_CATEGORIA_IVA, 'y la categoria de IVA tambien');
});

test('PROPS_COMPANY pide todo lo que el alta va a leer', () => {
    // La red de arriba prueba el comportamiento; esta dice POR QUE fallaba, y
    // falla en cuanto alguien agregue un campo al catalogo sin pedirlo.
    const necesita = require('../src/lib/verificarEmpresa').propiedadesQueNecesita();
    const faltan = necesita.filter((p) => !d2t.PROPS_COMPANY.includes(p));
    assert.deepStrictEqual(faltan, [],
        `el alta lee estas propiedades y PROPS_COMPANY no las pide: ${faltan.join(', ')}`);
});

// ── Un rechazo de datos del ERP no es una caida del ERP (§9.17) ──────────────

const RECHAZO_LOCALIDAD = "Tango rechazo la consulta: El campo 'LOCALIDAD' debe ser menor o igual a 20 caracteres.";

test('si Tango rechaza el DATO del alta, se anota y retrocede: NO se propaga', async () => {
    // Lo que paso el 2026-09-02 en la primera alta real. La excepcion salia de
    // procesarDeal, la COLA la reintentaba —~113 s por vuelta, porque relee el
    // padron— y terminaba en veneno con "avisar a sistemas". Es un dato que
    // comercial arregla en diez segundos.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL }, company: { ...COMPANY_A_CREAR, localidad: 'Ciudad Autonoma de Buenos Aires' } });
    const tango = tangoFalso();
    tango.get = async () => ({ registros: [{ COD_GVA14: '007610' }] });
    tango.getByFilter = async () => [];
    tango.create = async () => { throw new TangoError(RECHAZO_LOCALIDAD); };

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.strictEqual(r.estado, 'incompleto', 'sale por el camino de los datos, no por el de las fallas');
    assert.strictEqual(hs.notas.length, 1, 'comercial se entera en el negocio');
    assert.strictEqual(hs.etapaFinal, 'decisionmakerboughtin', 'y el negocio vuelve una etapa');
    assert.match(hs.notas[0].cuerpo, /20 caracteres/, 'la nota dice el limite que puso el ERP');
    assert.doesNotMatch(hs.notas[0].cuerpo, /avisar a sistemas/i, 'y NO manda a sistemas: no hay nada roto');
});

test('si el ERP se CAE durante el alta, si se propaga para que la cola reintente', async () => {
    // La otra mitad. Tratar una caida como dato la dejaria sin reintento y el
    // negocio se quedaria con una nota que culpa a comercial.
    const hs = hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL }, company: COMPANY_A_CREAR });
    const tango = tangoFalso();
    tango.get = async () => ({ registros: [{ COD_GVA14: '007610' }] });
    tango.getByFilter = async () => [];
    tango.create = async () => { throw new TangoError('fetch failed'); };

    await assert.rejects(
        () => d2t.procesarDeal({
            dealId: '111', hs, tango, lookups: lk, dryRun: false,
            filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
            estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
        }),
        /fetch failed/);
    assert.strictEqual(hs.notas.length, 0, 'no se anota nada: el reintento puede salir bien');
});

// ── Lo que le faltaba al pedido al lado de uno de comercial (§9.18) ──────────

test('el pedido lleva fecha de entrega, nro y fecha de OC', () => {
    const r = verificar({ deal: {
        tango_fecha_entrega: '2026-09-07',
        tango_nro_orden_compra: 'OC-4471',
        tango_fecha_orden_compra: '2026-09-01',
    } });

    assert.strictEqual(r.ok, true);
    // Sin zona horaria: el ERP no interpreta el offset y la guardaria corrida.
    assert.strictEqual(r.payload.FECHA_ENTREGA, '2026-09-07T00:00:00');
    assert.strictEqual(r.payload.FECHA_ORDEN_COMPRA, '2026-09-01T00:00:00');
    assert.strictEqual(r.payload.NRO_ORDEN_COMPRA, 'OC-4471');
});

test('sin fecha de entrega el pedido FRENA (decision de Matias 2026-09-02)', () => {
    const r = verificar({ deal: { tango_fecha_entrega: '' } });
    assert.strictEqual(r.ok, false);
    const p = r.problemas.find((x) => x.campo === 'FECHA_ENTREGA');
    assert.ok(p, 'tiene que reportarse como problema, no pasar en silencio');
    assert.match(p.comoSeArregla, /Cierre ganado/, 'dice como reintentar: mover la etapa ES el disparador');
});

test('el nro y la fecha de OC son OPCIONALES: sin ellos el pedido sale igual', () => {
    // Es dato del cliente y no siempre existe. Frenar por eso seria pedirle a
    // comercial que invente una orden de compra.
    const r = verificar({ deal: { tango_nro_orden_compra: '', tango_fecha_orden_compra: '' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.payload.NRO_ORDEN_COMPRA, undefined);
    assert.strictEqual(r.payload.FECHA_ORDEN_COMPRA, undefined);
});

test('el asiento modelo va siempre, por unanimidad de los 6.000 pedidos', () => {
    assert.strictEqual(verificar().payload.ID_ASIENTO_MODELO_GV, 1);
});

test('el talonario de FACTURA lo elige comercial y guarda el codigo, no el ID', () => {
    // La trampa mas cara de esta tabla: el codigo 10 es FACTURA A pero su ID es
    // 7, y el ID 10 es el de FACTURA B. Mandar el codigo emitiria una factura
    // del tipo equivocado sin que nada falle.
    const r = verificar({ deal: { tango_talonario_factura: '10' } });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.payload.ID_GVA43_TALONARIO_FACTURA, 7, 'FACTURA A es el ID 7, no el 10');

    assert.strictEqual(verificar({ deal: { tango_talonario_factura: '20' } }).payload.ID_GVA43_TALONARIO_FACTURA, 10);
    assert.strictEqual(verificar({ deal: { tango_talonario_factura: '30' } }).payload.ID_GVA43_TALONARIO_FACTURA, 13);
});

test('el talonario de factura NO tiene default: sin elegir, el pedido va sin el', () => {
    // NO se elige por mayoria como el talonario de PEDIDO. Sobre 6.000 pedidos,
    // monotributista sale FACTURA A 634 veces y B 508: la categoria de IVA
    // correlaciona pero no determina. Un default se equivocaria en ~1 de cada 4
    // y no se notaria hasta que sale mal una factura.
    const r = verificar();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.payload.ID_GVA43_TALONARIO_FACTURA, undefined);
});

test('un talonario de factura que no existe FRENA el pedido, no cae al default', () => {
    const r = verificar({ deal: { tango_talonario_factura: '99' } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'ID_GVA43_TALONARIO_FACTURA'));
});

test('cada opcion del talonario de factura resuelve a un ID que existe en el ERP', () => {
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.tango === 'ID_GVA43_TALONARIO_FACTURA');
    for (const codigo of Object.keys(campo.opciones)) {
        const r = verificar({ deal: { tango_talonario_factura: codigo } });
        assert.strictEqual(r.ok, true, `el talonario '${codigo}' no resolvio: ${JSON.stringify(r.problemas)}`);
    }
});

test('PROPS_DEAL pide todo lo que el pedido va a leer del negocio', () => {
    // La misma red que PROPS_COMPANY (§9.16), y por la misma razon: al agregar
    // estos cuatro campos la lista escrita a mano se quedo corta al instante.
    const necesita = MAPEO_PEDIDOS.campos.filter((c) => c.direccion === 'hubspot->tango').map((c) => c.hubspot);
    const faltan = necesita.filter((p) => !d2t.PROPS_DEAL.includes(p));
    assert.deepStrictEqual(faltan, [], `el pedido lee estas propiedades y PROPS_DEAL no las pide: ${faltan.join(', ')}`);
});

// ── El numero de pedido tiene que ser el de TANGO (§9.19) ───────────────

/**
 * El primer pedido real (2026-09-02) salio bien y quedo inencontrable: Api/Create
 * no devolvio numero, `tango_nro_pedido` se lleno con el ID del negocio y desde
 * HubSpot no habia con que buscarlo en el ERP.
 */
const GVA21 = (filas) => async () => filas;

test('si Api/Create no devuelve numero, se relee GVA21 y se anota el de Tango', async () => {
    const hs = hsFalso();
    const tango = tangoFalso({});          // la respuesta que dio Tango de verdad
    tango.getByFilter = GVA21([{ ID_GVA21: 17635, NRO_PEDIDO: '00001-00013597', LEYENDA_4: 'HubSpot deal 111' }]);

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.nroPedido, '00001-00013597');
    assert.strictEqual(hs.escrituras.at(-1).props.tango_nro_pedido, '00001-00013597');
});

test('entre varios pedidos del cliente se elige el del negocio, no el ultimo', async () => {
    // Dos pedidos el mismo dia y "el ultimo" es el ajeno. LEYENDA_4 lleva el ID
    // del Deal justamente para esto.
    const hs = hsFalso();
    const tango = tangoFalso({});
    tango.getByFilter = GVA21([
        { ID_GVA21: 17635, NRO_PEDIDO: '00001-00013597', LEYENDA_4: 'HubSpot deal 111' },
        { ID_GVA21: 17640, NRO_PEDIDO: '00001-00013601', LEYENDA_4: 'HubSpot deal 999' },
    ]);

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });
    assert.strictEqual(r.nroPedido, '00001-00013597');
});

test('sin LEYENDA_4 se cae al ultimo ID_GVA21 del cliente', async () => {
    const tango = tangoFalso({});
    tango.getByFilter = GVA21([
        { ID_GVA21: 17635, NRO_PEDIDO: '00001-00013597' },
        { ID_GVA21: 17640, NRO_PEDIDO: '00001-00013601' },
    ]);

    const nro = await d2t.releerNroPedido({ tango, codigoCliente: '000123', dealId: '111' });
    assert.strictEqual(nro, '00001-00013601');
});

test('si la relectura falla, el Deal queda marcado igual con el fallback', async () => {
    // `tango_nro_pedido` es ADEMAS la guarda de idempotencia (9.3): quedarse sin
    // escribirla mandaria el pedido dos veces. El pedido YA esta en el ERP.
    const hs = hsFalso();
    const tango = tangoFalso({});
    tango.getByFilter = async () => { throw new Error('el ERP no contesta'); };

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'creado');
    assert.strictEqual(r.nroPedido, '111');
    assert.strictEqual(hs.escrituras.at(-1).props.tango_nro_pedido, '111');
});

test('un codigo de cliente que no es seguro no se interpola en el filtroSql', async () => {
    let consultado = false;
    const tango = { async getByFilter() { consultado = true; return []; } };

    const nro = await d2t.releerNroPedido({ tango, codigoCliente: "007611' OR '1'='1", dealId: '111' });

    assert.strictEqual(nro, null);
    assert.strictEqual(consultado, false, 'ni se llega a consultar');
});

// ── El vendedor lo decide el owner del NEGOCIO (§9.19) ──────────────────────

/**
 * El primer pedido real salio con FACUNDO, el default, y nada lo dijo. No era la
 * tabla `porOwner` incompleta: `procesarDeal` recibia `owners` y NO se lo pasaba
 * al alta, asi que `emailDelOwner` devolvia null siempre. Ni los 4 owners que si
 * tienen vendedor funcionaban.
 *
 * Desde el 2026-09-03 son dos reglas de Matias: el vendedor sale del owner del
 * NEGOCIO (quien cerro la venta), y sin equivalencia el alta FRENA.
 */

/** El alta contra un Tango de mentira: pregunta el ultimo codigo, crea, confirma. */
function tangoQueDaDeAlta() {
    const tango = tangoFalso();
    tango.get = async () => ({ registros: [{ COD_GVA14: '007610' }] });
    const creados = [];
    tango.getByFilter = async (_p, filtro) => creados.filter((c) => filtro.includes(c.COD_GVA14));
    tango.create = async (process, payload) => {
        tango.creados.push({ process, payload });
        if (payload.COD_GVA14) creados.push({ COD_GVA14: payload.COD_GVA14, ID_GVA14: 9001 });
        return { ID_GVA14: 9001, NRO_PEDIDO: '00012345' };
    };
    return tango;
}

const conAlta = (over = {}) => ({
    hs: hsFalso({ deal: { hubspot_owner_id: OWNER_COMERCIAL }, company: COMPANY_A_CREAR, ...over }),
    tango: tangoQueDaDeAlta(),
});

test('la tabla de owners LLEGA al alta: el vendedor sale del negocio', async () => {
    const { hs, tango } = conAlta();

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.notStrictEqual(r.estado, 'incompleto', `no deberia frenar: ${r.motivo}`);
    // 10 es FACUNDO, y aca SI corresponde: farancibia@ es su owner. Que
    // coincida con el viejo default es casualidad de la cartera, no la regla.
    assert.strictEqual(tango.creados[0].payload.ID_GVA23, 10);
});

test('sin la tabla de owners el alta FRENA: no se puede resolver el vendedor', async () => {
    // El estado real del worker hasta el 2026-09-03: `owners` llegaba null
    // porque la tabla solo se leia cuando el filtro traia mails.
    const { hs, tango } = conAlta();

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: null,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.strictEqual(r.estado, 'incompleto');
    assert.ok(r.problemas.some((p) => p.campo === 'ID_GVA23'), JSON.stringify(r.problemas));
    assert.strictEqual(tango.creados.length, 0, 'no se crea nada en el ERP');
});

test('un negocio de un owner sin vendedor frena y dice como se arregla', async () => {
    // 23 de 27 estan asi. Antes el cliente se creaba con FACUNDO y el pedido
    // salia igual, sin un solo aviso.
    const { hs, tango } = conAlta({ deal: { hubspot_owner_id: OWNER_SIN_VENDEDOR } });

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_SIN_VENDEDOR), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.strictEqual(r.estado, 'incompleto');
    const p = r.problemas.find((x) => x.campo === 'ID_GVA23');
    assert.match(p.motivo, /pthaler@ultraschall\.com\.ar/);
    assert.match(p.comoSeArregla, /avisar a sistemas/);
    assert.ok(!/porOwner|defaults\.tango/.test(p.comoSeArregla), 'eso es para sistemas, no para comercial');
});

test('un negocio de Matias SI da de alta: esta mapeado a FACUNDO para probar', async () => {
    // El renglon de prueba de `porOwner` (2026-09-03). Falla el dia que se saque,
    // que es lo que se quiere: que no se saque sin darse cuenta.
    const { hs, tango } = conAlta({ deal: { hubspot_owner_id: MI_OWNER } });

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroMio(), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.notStrictEqual(r.estado, 'incompleto', `no deberia frenar: ${r.motivo}`);
    assert.strictEqual(tango.creados[0].payload.ID_GVA23, 10, 'FACUNDO');
});

// ── Nada se crea en el ERP hasta que TODO esta bien (§9.22) ─────────────────

/**
 * Pedido de Matias, 2026-09-03: "el negocio tiene que retroceder ANTES de que
 * se cree el pedido si cualquier cosa esta mal".
 *
 * Antes el orden era: verificar el pedido -> CREAR EL CLIENTE -> recien ahi
 * mirar si el pedido estaba completo. Un negocio sin fecha de entrega dejaba un
 * cliente creado en Tango y volvia de etapa igual. Y con la empresa a medias el
 * pedido salia lo mismo, dejando el negocio en Cierre ganado con un cliente sin
 * CUIT que nadie iba a completar nunca.
 */

test('con la empresa incompleta no se crea NI el cliente NI el pedido', async () => {
    const { hs, tango } = conAlta({ company: { ...COMPANY_A_CREAR, cuit: '', domicilio_del_consultorio: '' } });

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.strictEqual(r.estado, 'incompleto');
    assert.strictEqual(tango.creados.length, 0, 'no se toca el ERP: ni alta ni pedido');
    assert.strictEqual(hs.etapaFinal, 'decisionmakerboughtin', 'y el negocio retrocede una etapa');
    assert.deepStrictEqual(r.problemas.map((p) => p.campo).sort(), ['CUIT', 'DOMICILIO']);
});

test('si al PEDIDO le falta algo, tampoco se crea el cliente', async () => {
    // El orden viejo creaba el cliente primero y despues frenaba por el pedido:
    // quedaba un cliente en Tango para un negocio que nunca fue pedido.
    const { hs, tango } = conAlta({ deal: { hubspot_owner_id: OWNER_COMERCIAL, tango_fecha_entrega: '' } });

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    assert.strictEqual(r.estado, 'incompleto');
    assert.ok(r.problemas.some((p) => p.campo === 'FECHA_ENTREGA'), JSON.stringify(r.problemas));
    assert.strictEqual(tango.creados.length, 0, 'el cliente NO se crea para un pedido que no va a salir');
});

test('los problemas del pedido y los de la empresa llegan juntos en una nota', async () => {
    // Si vinieran en dos vueltas, comercial cargaria un dato, lo movería a
    // ganado, y recien ahi se enteraria del segundo.
    const { hs, tango } = conAlta({
        deal: { hubspot_owner_id: OWNER_COMERCIAL, tango_fecha_entrega: '' },
        company: { ...COMPANY_A_CREAR, cuit: '' },
    });

    const r = await d2t.procesarDeal({
        dealId: '111', hs, tango, lookups: lk, dryRun: false,
        filtroOwner: filtroDe(OWNER_COMERCIAL), owners: OWNERS,
        estrategiaNumeracion: defaults.clientes.numeracion.estrategia,
    });

    const campos = r.problemas.map((p) => p.campo);
    assert.ok(campos.includes('FECHA_ENTREGA'), campos.join(','));
    assert.ok(campos.includes('CUIT'), campos.join(','));
    assert.strictEqual(hs.notas.length, 1, 'una sola nota, con las dos cosas');
});

// ── Un mismo negocio puede tener varios pedidos (2026-09-03) ────────────────

/**
 * Los cinco pedidos que el negocio de prueba 64576262053 dejo REALMENTE en
 * Tango, leidos del ERP. Todos con el mismo LEYENDA_4, porque `LEYENDA_4` lleva
 * el ID del Deal y el Deal es el mismo: alcanza con borrarle `tango_nro_pedido`
 * y volver a moverlo a ganado para que salga otro.
 */
const CINCO_PEDIDOS = [
    { ID_GVA21: 17635, NRO_PEDIDO: '00001-00013597', LEYENDA_4: 'HubSpot deal 64576262053' },
    { ID_GVA21: 17636, NRO_PEDIDO: '00001-00013598', LEYENDA_4: 'HubSpot deal 64576262053' },
    { ID_GVA21: 17637, NRO_PEDIDO: '00001-00013599', LEYENDA_4: 'HubSpot deal 64576262053' },
    { ID_GVA21: 17638, NRO_PEDIDO: '00001-00013600', LEYENDA_4: 'HubSpot deal 64576262053' },
    { ID_GVA21: 17639, NRO_PEDIDO: '00001-00013601', LEYENDA_4: 'HubSpot deal 64576262053' },
];

test('con varios pedidos del MISMO negocio se anota el ultimo, no el primero', async () => {
    // El bug del 2026-09-03: `find` devolvia la primera coincidencia, o sea la
    // mas vieja. HubSpot anotaba siempre 00001-00013597 y parecia que el
    // circuito estaba reusando un pedido viejo, cuando en realidad acababa de
    // crear el quinto. El test anterior no lo veia porque usaba dos negocios
    // distintos, y ahi la primera coincidencia era la correcta por casualidad.
    const tango = tangoFalso({});
    tango.getByFilter = async () => CINCO_PEDIDOS;

    const nro = await d2t.releerNroPedido({ tango, codigoCliente: '007611', dealId: '64576262053' });
    assert.strictEqual(nro, '00001-00013601');
});

test('si ninguno es de este negocio, se cae al ultimo del cliente', async () => {
    const tango = tangoFalso({});
    tango.getByFilter = async () => CINCO_PEDIDOS;

    const nro = await d2t.releerNroPedido({ tango, codigoCliente: '007611', dealId: '999' });
    assert.strictEqual(nro, '00001-00013601');
});

test('un pedido de OTRO negocio mas nuevo no le gana al nuestro', async () => {
    // El filtro es por cliente, asi que en la lista entran pedidos de otros
    // negocios del mismo cliente. El ID mas alto se elige SOLO entre los
    // nuestros.
    const tango = tangoFalso({});
    tango.getByFilter = async () => [
        ...CINCO_PEDIDOS,
        { ID_GVA21: 17700, NRO_PEDIDO: '00001-00013650', LEYENDA_4: 'HubSpot deal 99999999' },
    ];

    const nro = await d2t.releerNroPedido({ tango, codigoCliente: '007611', dealId: '64576262053' });
    assert.strictEqual(nro, '00001-00013601', 'el ultimo NUESTRO, no el ultimo de la lista');
});

// ── La condicion de venta la elige comercial en el negocio (2026-09-04) ─────

/**
 * `condiciones_de_pago` ya existia en el portal, en "Informacion del negocio",
 * con 83 opciones que guardaban la DESCRIPCION. No servia: `CHEQUE 45 DIAS FF`
 * esta DOS veces en GVA01 (cod 13 / id 13 y cod 68 / id 1069), asi que la
 * descripcion no identifica la fila; y le faltaba CONTADO —el 54% de la
 * cartera— porque decia "Contado" y en Tango es "CONTADO".
 */

test('la condicion de venta que elige comercial llega al ERP como ID', () => {
    // El codigo 5 es MERCADOPAGO. Se manda el ID, no el codigo.
    const r = verificar({ deal: { condiciones_de_pago: '5' } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_GVA01, lk.resolver('condicionesVenta', '5').id);
});

test('lo que elige comercial GANA sobre la condicion del cliente', () => {
    // La condicion se negocia por venta; no es un atributo fijo de la empresa.
    const r = verificar({
        company: { ...COMPANY, tango_id_gva01: '1' },
        deal: { condiciones_de_pago: '5' },
    });
    assert.strictEqual(r.payload.ID_GVA01, lk.resolver('condicionesVenta', '5').id);
});

test('sin elegir nada se sigue heredando la del cliente', () => {
    const r = verificar({ company: { ...COMPANY, tango_id_gva01: '7' } });
    assert.strictEqual(r.payload.ID_GVA01, 7, 'el ID que ya trae la company');
});

test('una condicion de venta que no existe FRENA el pedido, no cae al default', () => {
    const r = verificar({ deal: { condiciones_de_pago: '9999' } });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'ID_GVA01'), JSON.stringify(r.problemas));
});

test('cada opcion de la condicion de venta resuelve a un ID que existe', () => {
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.tango === 'ID_GVA01');
    assert.strictEqual(Object.keys(campo.opciones).length, 86, 'la tabla GVA01 entera');
    for (const codigo of Object.keys(campo.opciones)) {
        const r = verificar({ deal: { condiciones_de_pago: codigo } });
        assert.strictEqual(r.ok, true, `la condicion '${codigo}' no resolvio: ${JSON.stringify(r.problemas)}`);
    }
});

test('las etiquetas del desplegable son unicas: HubSpot lo exige', () => {
    // `CHEQUE 45 DIAS FF` esta dos veces en GVA01. Sin desempatar, el PATCH de
    // la propiedad falla entero con "Property option labels must be unique".
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.tango === 'ID_GVA01');
    const etiquetas = Object.values(campo.opcionesEtiquetas);
    assert.strictEqual(etiquetas.length, new Set(etiquetas).size,
        'hay etiquetas repetidas: HubSpot rechaza el PATCH entero');
    assert.match(campo.opcionesEtiquetas['13'], /\(13\)$/, 'el duplicado se desempata con el codigo');
});

test('el duplicado sin uso queda oculto, no borrado', () => {
    // cod 68 lo usan 0 clientes contra 3 del cod 13 (medido sobre los 5.671).
    // Ocultar y no borrar es la regla: si alguien lo tuviera asignado, sacarlo
    // de las opciones rompe la escritura.
    const campo = MAPEO_PEDIDOS.campos.find((c) => c.tango === 'ID_GVA01');
    assert.deepStrictEqual(campo.opcionesOcultas, ['68']);
    assert.ok(campo.opciones['68'], 'sigue existiendo como opcion');
});

// ── La moneda sale del negocio (2026-09-04) ────────────────────────────────

/**
 * `ID_MONEDA` era un valor fijo en 1 (Pesos) y `deal_currency_code` ni se leia.
 * Un negocio en USD entraba a Tango como pesos CON LOS IMPORTES EN DOLARES: un
 * equipo de USD 3.000 quedaba como 3.000 pesos y no fallaba nada. El dia que se
 * implemento habia 4 negocios asi en el portal.
 */
const MONEDAS = require('../config/defaults.tango.json').pedidos.monedas;

test('un negocio en pesos manda el ID de PES', () => {
    const r = verificar({ deal: { deal_currency_code: 'ARS' } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_MONEDA, 1);
});

test('un negocio en dolares manda el ID de DOL, no el default', () => {
    const r = verificar({ deal: { deal_currency_code: 'USD' } });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_MONEDA, 2, 'antes mandaba 1 y el importe quedaba en pesos');
});

test('sin moneda en el negocio sigue yendo el default', () => {
    // Es lo que hacia hasta el 2026-09-04. No frena: todo Deal de HubSpot trae
    // moneda, asi que esto es el caso raro, no el normal.
    const r = verificar({ deal: {} });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.payload.ID_MONEDA, 1);
});

test('una moneda que no esta configurada FRENA el pedido', () => {
    // Caer al default seria el mismo modo de falla que esto cierra, y encima
    // silencioso: el ERP acepta el pedido y el importe queda por mil.
    const r = verificar({ deal: { deal_currency_code: 'EUR' } });
    assert.strictEqual(r.ok, false);
    const p = r.problemas.find((x) => x.campo === 'ID_MONEDA');
    assert.ok(p, JSON.stringify(r.problemas));
    assert.match(p.motivo, /EUR/);
    assert.match(p.comoSeArregla, /ARS/, 'dice cuales SI se pueden');
});

test("'ARG' no es el peso argentino: el codigo es ARS", () => {
    // Vale como test porque es un error facil de cometer —y se cometio— y el
    // sintoma seria un pedido frenado sin motivo aparente.
    const r = verificar({ deal: { deal_currency_code: 'ARG' } });
    assert.strictEqual(r.ok, false, 'ARG no existe: HubSpot manda ARS');
    assert.strictEqual(MONEDAS.porCodigoDeHubSpot.ARG, undefined);
    assert.strictEqual(MONEDAS.porCodigoDeHubSpot.ARS.idMoneda, 1);
});

test('la moneda no distingue mayusculas ni espacios', () => {
    const r = verificar({ deal: { deal_currency_code: ' usd ' } });
    assert.strictEqual(r.payload.ID_MONEDA, 2);
});

test('cada moneda de la tabla apunta a un ID que el ERP ya uso', () => {
    // 1 = PES y 2 = DOL son los unicos ID_MONEDA en uso en el padron de pedidos
    // (verificado 2026-08-28, §9.7). Si alguien agrega una tercera hay que
    // verificarla contra GVA21 antes.
    for (const [codigo, fila] of Object.entries(MONEDAS.porCodigoDeHubSpot)) {
        assert.ok([1, 2].includes(fila.idMoneda), `${codigo} apunta al ID ${fila.idMoneda}, que no esta verificado contra GVA21`);
        assert.ok(MONEDAS.descripciones[String(fila.idMoneda)], `el ID ${fila.idMoneda} no tiene descripcion`);
        // La lista tiene que existir en la tabla de GVA10 del catalogo.
        const listas = CATALOGO.auxiliares.listasPrecios.filas.map((f) => f.ID_GVA10);
        assert.ok(listas.includes(fila.idListaPrecios), `${codigo} apunta a la lista ${fila.idListaPrecios}, que no existe en GVA10`);
    }
});

// ── La lista de precios va con la moneda (2026-09-04) ───────────────────────

/**
 * Un pedido en dolares con una lista en pesos es plata mal calculada, y era lo
 * que pasaba: `ID_GVA10` se heredaba del cliente y `ID_MONEDA` era fijo en
 * pesos, asi que los dos campos no se miraban nunca entre si. Se vio al
 * previsualizar la nota del pedido creado: "Moneda: Dolares · Lista: CON IVA EN $".
 */

test('un negocio en pesos usa la lista 1 (SIN IVA EN $)', () => {
    const r = verificar({ deal: { deal_currency_code: 'ARS' } });
    assert.strictEqual(r.payload.ID_MONEDA, 1);
    assert.strictEqual(r.payload.ID_GVA10, 1);
});

test('un negocio en dolares usa la lista 2 (SIN IVA EN U$S)', () => {
    const r = verificar({ deal: { deal_currency_code: 'USD' } });
    assert.strictEqual(r.payload.ID_MONEDA, 2);
    assert.strictEqual(r.payload.ID_GVA10, 2);
});

test('la lista de la moneda PISA la que tiene cargada el cliente', () => {
    // Hay 7 clientes con CON IVA EN U$S (lista 5). Un negocio suyo en dolares
    // sale con la 2, no con la 5. Es lo que se pidio.
    const r = verificar({
        company: { ...COMPANY, tango_id_gva10: '5' },
        deal: { deal_currency_code: 'USD' },
    });
    assert.strictEqual(r.payload.ID_GVA10, 2, 'gana la de la moneda');
});

test('sin moneda en el negocio la lista se sigue heredando del cliente', () => {
    // El camino de antes queda intacto para el negocio que no trae moneda.
    const r = verificar({ company: { ...COMPANY, tango_id_gva10: '5' }, deal: {} });
    assert.strictEqual(r.payload.ID_GVA10, 5);
});

test('moneda y lista nunca salen desparejas', () => {
    // La red: cualquier moneda configurada tiene que dar un par consistente.
    for (const codigo of Object.keys(MONEDAS.porCodigoDeHubSpot)) {
        const r = verificar({ company: { ...COMPANY, tango_id_gva10: '3' }, deal: { deal_currency_code: codigo } });
        const esperado = MONEDAS.porCodigoDeHubSpot[codigo];
        assert.strictEqual(r.payload.ID_MONEDA, esperado.idMoneda, codigo);
        assert.strictEqual(r.payload.ID_GVA10, esperado.idListaPrecios, codigo);
    }
});

test('PROPS_DEAL pide la moneda: sin eso llega undefined y va el default', () => {
    // La misma red de §9.16: si el pedido lee una propiedad, alguna lista tiene
    // que pedirla. Aca el sintoma seria mudo — todo en pesos, como antes.
    assert.ok(d2t.PROPS_DEAL.includes('deal_currency_code'));
});

// ── La nota de que el pedido SALIO BIEN (§9.26) ─────────────────────────────

/**
 * Pedido de Matias, 2026-09-04. Hasta ahora un pedido exitoso no dejaba nada en
 * la linea de tiempo: solo cuatro propiedades. Comercial veia el negocio en
 * Cierre ganado y para saber si el pedido existia tenia que mirar campos, o
 * entrar a Tango — que es justo lo que no hace.
 */

test('un pedido que sale bien deja una nota con el numero de Tango', async () => {
    const hs = hsFalso();
    const tango = tangoFalso({ NRO_PEDIDO: '00001-00013602' });

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango, lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'creado');
    assert.strictEqual(hs.notas.length, 1, 'tiene que quedar constancia en el negocio');
    assert.match(hs.notas[0].cuerpo, /00001-00013602/, 'el numero con el que se busca en el ERP');
});

test('la nota lleva los datos que le sirven a comercial', async () => {
    const hs = hsFalso({ deal: { tango_fecha_entrega: '2026-09-12' } });
    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    const nota = hs.notas[0].cuerpo;
    assert.match(nota, /Fecha de entrega/);
    assert.match(nota, /2026-09-12/);
    assert.match(nota, /Cliente en Tango/);
    assert.match(nota, /Vendedor/);
    assert.match(nota, /Total según el negocio/);
    assert.strictEqual(r.estado, 'creado');
});

test('un dato que no esta no deja un renglon vacio en la nota', async () => {
    // Sin talonario de factura elegido no tiene que aparecer "Talonario: —".
    const hs = hsFalso();
    await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });
    assert.ok(!/Talonario de factura/.test(hs.notas[0].cuerpo), hs.notas[0].cuerpo);
    assert.ok(!/Orden de compra/.test(hs.notas[0].cuerpo));
});

test('el articulo de prueba se avisa TAMBIEN en la nota del pedido creado', async () => {
    // Un pedido que salio con un articulo que no es el que se vendio no puede
    // pasar en silencio, y el log de Azure no lo lee comercial.
    // El doble de HubSpot devuelve products, no el Map que arma procesarDeal.
    const hs = hsFalso({ productos: [{ id: '77', properties: { name: 'Ecografo' } }] });
    await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });
    assert.match(hs.notas[0].cuerpo, /articulo de prueba/);
});

test('si la nota falla, el pedido NO se pierde', async () => {
    // El pedido ya esta en el ERP y el Deal ya quedo marcado: que no se pueda
    // anotar no puede convertirse en un problema mayor (mismo criterio que 9.9).
    const hs = hsFalso();
    hs.crearNota = async () => { throw new Error('HubSpot no contesta'); };

    const r = await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: false });

    assert.strictEqual(r.estado, 'creado');
    assert.strictEqual(r.nroPedido, '00012345');
    assert.ok(hs.escrituras.some((e) => e.props.tango_nro_pedido), 'la marca de idempotencia igual se escribio');
});

test('en dry-run no se anota nada', async () => {
    const hs = hsFalso();
    await d2t.procesarDeal({ dealId: '111', hs, tango: tangoFalso(), lookups: lk, dryRun: true });
    assert.strictEqual(hs.notas.length, 0);
});
