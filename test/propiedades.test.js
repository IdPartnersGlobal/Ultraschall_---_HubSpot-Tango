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

// ------------------------------------------------- desplegables (2026-09-01)

const mapeoProductos = require('../config/mapeo.productos.json');
const mapeoPedidos = require('../config/mapeo.pedidos.json');
const TODOS_LOS_MAPEOS = {
    clientes: mapeoClientes,
    productos: mapeoProductos,
    pedidos: mapeoPedidos,
    contactos: mapeoContactos,
};

test('ningun campo pide un desplegable sin declarar sus opciones', () => {
    // ESTA es la red, no el `if` que degrada a texto en tipoHubSpot(). Once
    // campos —tango_vendedor, tango_zona, tango_perfil y ocho mas— pidieron
    // `select` sin `opciones` desde el 2026-08-14 y quedaron de texto libre en
    // el portal sin que nada fallara: la degradacion es silenciosa, y
    // planificar() los comparaba contra la spec ya degradada, o sea que
    // informaba `0 a rehacer`. Se descubrio el 2026-09-01 mirando una ficha.
    //
    // Si este test falla, correr: node scripts/opcionesDesplegables.js
    const huerfanos = [];
    for (const [nombre, mapeo] of Object.entries(TODOS_LOS_MAPEOS)) {
        for (const c of mapeo.campos) {
            const t = (c.hsFieldType || '').toLowerCase();
            if ((t === 'select' || t === 'multiselect') && !c.opciones) huerfanos.push(`${nombre}.${c.hubspot}`);
        }
    }
    assert.deepStrictEqual(huerfanos, [], 'piden desplegable y no tienen opciones: quedarian de texto libre');
});

test('cada opcion de los desplegables de Tango sale de su tabla, no de la muestra', () => {
    // La lista tiene que ser la tabla COMPLETA. Derivarla de los valores en
    // uso deja afuera lo que todavia no uso nadie, y el dia que aparece el
    // sync se cae con 400 INVALID_OPTION. Es el mismo error que con los
    // depositos, donde ademas habia entrado uno dado de baja por la puerta de
    // atras (ARQUITECTURA.md 9.11).
    // La columna es la que el desplegable GUARDA: el CODIGO en los de
    // entrada (§9.14), la descripcion en los que son espejo de Tango.
    const casos = [
        ['clientes', 'tango_zona', require('./fixtures/zonas.json'), 'COD_GVA05'],
        ['clientes', 'tango_transporte', require('./fixtures/transportes.json'), 'COD_GVA24'],
        ['clientes', 'tango_condicion_venta', require('./fixtures/condicionesVenta.json'), 'COND_VTA'],
        ['clientes', 'tango_vendedor', require('./fixtures/vendedores.json'), 'NOMBRE_VEN'],
        ['productos', 'tango_alicuota_iva', require('./fixtures/alicuotasIva.json'), 'DESCRIPCIO'],
    ];
    for (const [mapeo, nombre, filas, columna] of casos) {
        const campo = TODOS_LOS_MAPEOS[mapeo].campos.find((c) => c.hubspot === nombre);
        const enLaTabla = new Set(filas.map((f) => `${f[columna] ?? ''}`.trim()).filter(Boolean));
        const enElMapeo = new Set(Object.values(campo.opciones));
        for (const v of enLaTabla) assert.ok(enElMapeo.has(v), `${nombre}: falta la opcion ${v}, que si esta en la tabla`);
        for (const v of enElMapeo) assert.ok(enLaTabla.has(v), `${nombre}: la opcion ${v} no existe en la tabla de Tango`);
    }
});

test('un vendedor inhabilitado se oculta, pero sigue siendo una opcion', () => {
    // No se saca de la lista: hay clientes en el padron que lo tienen
    // asignado, y sin la opcion su escritura se cae con 400 y voltea la tanda
    // de 100. `hidden: true` no lo ofrece en el desplegable y deja escribirlo
    // por API — verificado contra el portal real el 2026-09-01.
    const vendedores = require('./fixtures/vendedores.json');
    const deBaja = vendedores.filter((v) => v.INHABILITA === true).map((v) => v.NOMBRE_VEN.trim());
    assert.ok(deBaja.length, 'el fixture ya no tiene inhabilitados: el test dejo de probar lo que dice');

    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'tango_vendedor');
    const opciones = opcionesDe(campo);
    for (const nombre of deBaja) {
        const o = opciones.find((x) => x.value === nombre);
        assert.ok(o, `${nombre} tiene que seguir siendo una opcion`);
        assert.strictEqual(o.hidden, true, `${nombre} esta de baja: no se ofrece`);
    }
    assert.ok(opciones.some((o) => !o.hidden), 'no se ocultaron todas');
});

test('la clasificacion es multivalor, asi que va como casillas y no como desplegable', () => {
    // Tango manda hasta tres clasificaciones en un mismo campo, separadas por
    // ';'. Con `select`, los 43 articulos que tienen mas de una se caen.
    const campo = mapeoProductos.campos.find((c) => c.hubspot === 'tango_clasificacion');
    assert.strictEqual(tipoHubSpot(campo).fieldType, 'checkbox');
    assert.strictEqual(tipoHubSpot(campo).type, 'enumeration');
});

test('pasar de texto libre a desplegable se PARCHEA, no se rehace', () => {
    // Verificado contra el portal el 2026-09-01: HubSpot acepta el PATCH de
    // string a enumeration y los valores cargados sobreviven. Antes cualquier
    // diferencia de `type` caia en aRehacer —o sea borrar la propiedad— y por
    // eso tango_perfil se habia dejado de texto libre a proposito.
    const enElPortalComoTexto = mapeoClientes.campos
        .filter((c) => c.opciones && c.hsFieldType === 'select')
        .map((c) => ({ name: c.hubspot, type: 'string', fieldType: 'text', groupName: 'tango_erp', options: [] }));
    assert.ok(enElPortalComoTexto.length >= 6, 'el mapeo dejo de tener desplegables de cliente');

    const plan = planificar(mapeoClientes, enElPortalComoTexto);
    const convertidos = new Set(plan.aConvertir.map((p) => p.name));
    for (const p of enElPortalComoTexto) {
        assert.ok(convertidos.has(p.name), `${p.name} deberia convertirse con un PATCH`);
        assert.ok(!plan.aRehacer.some((r) => r.name === p.name), `${p.name} no se rehace: rehacer borra los valores`);
    }
    for (const c of plan.aConvertir) {
        assert.strictEqual(c.cambios.type, 'enumeration');
        assert.ok(c.cambios.options.length, 'la conversion tiene que mandar las opciones');
    }
});

test('el PATCH de opciones no des-oculta lo que estaba oculto', () => {
    // Bug encontrado el 2026-09-01: aParchear reconstruia las opciones viejas
    // con `hidden: false` fijo. Como el sync es idempotente, bastaba con que
    // apareciera una opcion nueva para que volvieran a la lista todos los
    // dados de baja, sin que nada fallara.
    const mapeo = {
        _meta: { claveIdempotencia: { hubspot: 'clave' } },
        campos: [{
            tango: 'X', hubspot: 'vendedor', label: 'Vendedor', hsFieldType: 'select',
            opciones: { ANA: 'ANA', BETO: 'BETO', CELIA: 'CELIA' },
            opcionesOcultas: ['BETO'],
        }],
    };
    const enElPortal = [{
        name: 'vendedor', type: 'enumeration', fieldType: 'select', groupName: 'tango_erp',
        options: [
            { label: 'ANA', value: 'ANA', hidden: false },
            { label: 'BETO', value: 'BETO', hidden: true },
        ],
    }];

    const { aParchear } = planificar(mapeo, enElPortal);
    assert.strictEqual(aParchear.length, 1, 'falta CELIA: hay que parchear');
    const porValor = new Map(aParchear[0].cambios.options.map((o) => [o.value, o]));
    assert.strictEqual(porValor.get('BETO').hidden, true, 'BETO estaba oculto y tiene que quedar oculto');
    assert.strictEqual(porValor.get('ANA').hidden, false);
    assert.strictEqual(porValor.get('CELIA').hidden, false);
});

test('una opcion que el mapeo manda ocultar y en el portal esta visible se parchea', () => {
    const mapeo = {
        _meta: { claveIdempotencia: { hubspot: 'clave' } },
        campos: [{
            tango: 'X', hubspot: 'vendedor', label: 'Vendedor', hsFieldType: 'select',
            opciones: { ANA: 'ANA', BETO: 'BETO' },
            opcionesOcultas: ['BETO'],
        }],
    };
    const enElPortal = [{
        name: 'vendedor', type: 'enumeration', fieldType: 'select', groupName: 'tango_erp',
        options: [
            { label: 'ANA', value: 'ANA', hidden: false },
            { label: 'BETO', value: 'BETO', hidden: false },
        ],
    }];
    const { aParchear } = planificar(mapeo, enElPortal);
    assert.strictEqual(aParchear.length, 1);
    assert.match(aParchear[0].detalle, /visibilidad distinta/);
    const beto = aParchear[0].cambios.options.find((o) => o.value === 'BETO');
    assert.strictEqual(beto.hidden, true);
});

test('las opciones que el mapeo ya no declara se informan, pero el parche NO las saca', () => {
    // Cuando un desplegable cambia de valores —tango_zona paso de guardar 'NOA'
    // a guardar '04' el 2026-09-01— el portal queda con las viejas y las nuevas
    // conviviendo, porque aParchear nunca saca nada, a proposito: no sabe
    // cuantos registros usan cada opcion. Se informan aparte, y quitarlas es un
    // paso explicito que primero cuenta el uso real.
    const mapeo = {
        _meta: { claveIdempotencia: { hubspot: 'clave' } },
        campos: [{
            tango: 'X', hubspot: 'zona', label: 'Zona', hsFieldType: 'select',
            opciones: { '01': '01', '04': '04' },
            opcionesEtiquetas: { '01': 'CABA', '04': 'NOA' },
        }],
    };
    const enElPortal = [{
        name: 'zona', type: 'enumeration', fieldType: 'select', groupName: 'tango_erp',
        options: [
            { label: 'CABA', value: 'CABA', hidden: false },
            { label: 'NOA', value: 'NOA', hidden: false },
        ],
    }];

    const plan = planificar(mapeo, enElPortal);
    assert.deepStrictEqual(plan.sobrantes.map((s) => s.name), ['zona']);
    assert.deepStrictEqual(plan.sobrantes[0].valores, ['CABA', 'NOA']);

    // El parche agrega las nuevas y conserva las viejas.
    const delParche = plan.aParchear[0].cambios.options.map((o) => o.value);
    assert.ok(delParche.includes('CABA'), 'el parche no puede tirar una opcion por su cuenta');
    assert.ok(delParche.includes('04'));

    // La lista limpia que propone `sobrantes` es solo lo que el mapeo declara.
    assert.deepStrictEqual(plan.sobrantes[0].cambios.options.map((o) => o.value), ['01', '04']);
});

test('sin sobrantes no se informa nada', () => {
    const plan = planificar(mapeoClientes, []);
    assert.deepStrictEqual(plan.sobrantes, [], 'contra un portal vacio no sobra nada');
});

test('el parche no manda dos opciones con la misma etiqueta: HubSpot lo rechaza', () => {
    // Caso real del 2026-09-01. tango_zona guardaba 'CABA' y paso a guardar
    // '01', las dos con etiqueta CABA. El parche mandaba las viejas junto con
    // las nuevas —para no perder datos— y HubSpot contesto 400 "Property
    // option labels must be unique" en las CUATRO propiedades a la vez.
    const mapeo = {
        _meta: { claveIdempotencia: { hubspot: 'clave' } },
        campos: [{
            tango: 'X', hubspot: 'zona', label: 'Zona', hsFieldType: 'select',
            opciones: { '01': '01', '04': '04' },
            opcionesEtiquetas: { '01': 'CABA', '04': 'NOA' },
        }],
    };
    const enElPortal = [{
        name: 'zona', type: 'enumeration', fieldType: 'select', groupName: 'tango_erp',
        options: [{ label: 'CABA', value: 'CABA', hidden: false }],
    }];

    const { aParchear } = planificar(mapeo, enElPortal);
    const opciones = aParchear[0].cambios.options;

    const etiquetas = opciones.map((o) => o.label);
    assert.strictEqual(new Set(etiquetas).size, etiquetas.length, `etiquetas repetidas: ${etiquetas.join(' | ')}`);
    const valores = opciones.map((o) => o.value);
    assert.strictEqual(new Set(valores).size, valores.length, 'valores repetidos');

    // La vieja sigue estando: puede tener registros cargados.
    const vieja = opciones.find((o) => o.value === 'CABA');
    assert.ok(vieja, 'no se puede tirar una opcion que quiza tiene datos');
    assert.match(vieja.label, /valor anterior/);
    // Y la nueva conserva su etiqueta limpia.
    assert.strictEqual(opciones.find((o) => o.value === '01').label, 'CABA');
});

test('una etiqueta vieja que no choca con ninguna nueva se deja como esta', () => {
    const mapeo = {
        _meta: { claveIdempotencia: { hubspot: 'clave' } },
        campos: [{
            tango: 'X', hubspot: 'zona', label: 'Zona', hsFieldType: 'select',
            opciones: { '01': '01' }, opcionesEtiquetas: { '01': 'CABA' },
        }],
    };
    const enElPortal = [{
        name: 'zona', type: 'enumeration', fieldType: 'select', groupName: 'tango_erp',
        options: [{ label: 'PATAGONIA', value: 'PATAGONIA', hidden: false }],
    }];
    const { aParchear } = planificar(mapeo, enElPortal);
    assert.strictEqual(aParchear[0].cambios.options.find((o) => o.value === 'PATAGONIA').label, 'PATAGONIA');
});
