'use strict';

const test = require('node:test');
const assert = require('node:assert');

const enCastellano = require('../src/lib/enCastellano');
const notaProblema = require('../src/lib/notaProblema');
const rechazoTango = require('../src/lib/rechazoTango');
const mapeoClientes = require('../config/mapeo.clientes.json');
const mapeoPedidos = require('../config/mapeo.pedidos.json');
const defaults = require('../config/defaults.tango.json');

/**
 * Las notas las lee comercial (pedido de Matias, 2026-09-03).
 *
 * Los textos de abajo son los que quedaron REALMENTE en el negocio de prueba
 * 64576262053 entre el 2 y el 3 de septiembre. Sirven de fixture porque no son
 * hipotesis: es lo que la gente vio.
 */

test('la etiqueta sale del mapeo, no de una lista escrita a mano', () => {
    assert.strictEqual(enCastellano.etiqueta('RAZON_SOCI', 'razon_social'), 'Razon Social');
    assert.strictEqual(enCastellano.etiqueta('FECHA_ENTREGA', 'tango_fecha_entrega'), 'Fecha de entrega',
        'y sin el "(Tango)" del final, que aca es ruido');
});

test('los OVERRIDES ganan: son los que se curaron porque el mapeo no alcanza', () => {
    // `tango_id_gva23` se llama "ID vendedor" en la planilla de Ultraschall.
    assert.strictEqual(enCastellano.etiqueta('ID_GVA23', 'tango_id_gva23'), 'Vendedor');
    // Y estos no son campo de nadie: no hay mapeo del que salgan.
    assert.strictEqual(enCastellano.etiqueta('RENGLON_DTO'), 'Productos del negocio');
    assert.strictEqual(enCastellano.etiqueta('ID_GVA14'), 'Empresa del negocio');
});

test('un campo que nadie conoce sale como vino, no vacio', () => {
    // Preferible mostrar el nombre raro a mostrar una linea sin sujeto.
    assert.strictEqual(enCastellano.etiqueta('CAMPO_QUE_NO_EXISTE'), 'CAMPO_QUE_NO_EXISTE');
});

test('el renglon del DTO se traduce a algo que existe para comercial', () => {
    // Textual del ERP, negocio de prueba, 2026-09-03 18:18.
    const r = enCastellano.humanizar('No hay existencias para RENGLON_DTO[1]. Solo hay 0 UNI en stock y 0 UNI comprometidas.');
    assert.match(r, /el producto 1 del negocio/);
    assert.ok(!/RENGLON_DTO/.test(r));
});

test('se traducen tambien las columnas que nombra el propio ERP', () => {
    // Textual del ERP, negocio de prueba, 2026-09-03 18:06.
    const r = enCastellano.humanizar('El campo FECHA_ORDEN_COMPRA debe ser menor o igual a FECHA_PEDIDO.');
    assert.match(r, /'Fecha de orden de compra'/);
    assert.match(r, /'Fecha del pedido'/);
});

test('una columna del ERP que no conocemos se deja tal cual', () => {
    // No se le inventa un nombre: parafrasear un mensaje del ERP que no
    // entendemos es peor que citarlo (§9.17).
    const r = enCastellano.humanizar('El campo COLUMNA_RARA_GV no cumple la regla.');
    assert.match(r, /COLUMNA_RARA_GV/);
});

test('lo que el ERP ya entrecomilla no queda con comillas dobles', () => {
    const r = enCastellano.humanizar("El campo 'LOCALIDAD' debe ser menor o igual a 20 caracteres.");
    assert.match(r, /'Localidad'/);
    assert.ok(!/''/.test(r), r);
});

test('no se traducen palabras en mayuscula que no son campos', () => {
    const t = 'el ERP rechazo el alta y el CUIT no es valido: 0 UNI';
    assert.strictEqual(enCastellano.humanizar(t), t);
});

// ── La red: ninguna nota puede mostrar un nombre interno ────────────────────

/**
 * Todo nombre interno que exista en los catalogos. Si alguno aparece en el
 * texto de una nota, es que se escapo de la traduccion.
 *
 * Se DERIVA, no se escribe: el dia que alguien agregue un campo, esta lista lo
 * incluye sola y el test lo agarra.
 */
function nombresInternos() {
    const nombres = new Set();
    for (const c of [...(mapeoClientes.campos || []), ...(mapeoPedidos.campos || [])]) {
        if (c.hubspot && c.hubspot.includes('_')) nombres.add(c.hubspot);
        if (c.tango && /^[A-Z][A-Z0-9_]*$/.test(c.tango) && c.tango.includes('_')) nombres.add(c.tango);
    }
    for (const c of defaults.clientes.alta.campos || []) {
        if (c.hubspot && c.hubspot.includes('_')) nombres.add(c.hubspot);
    }
    nombres.add('RENGLON_DTO');
    return [...nombres];
}

/** Lo que puede aparecer aunque parezca interno: en la planilla se llama asi. */
const PERMITIDOS = new Set(['codigo_tango']);

function sinNombresInternos(texto, contexto) {
    for (const n of nombresInternos()) {
        if (PERMITIDOS.has(n)) continue;
        assert.ok(!new RegExp(`\\b${n}\\b`).test(texto),
            `${contexto} muestra el nombre interno '${n}':\n${texto}`);
    }
}

test('la nota de datos faltantes no muestra un solo nombre interno', () => {
    // Los problemas que produjo el circuito de verdad.
    const html = notaProblema.cuerpo({
        problemas: [
            { campo: 'RAZON_SOCI', propiedad: 'razon_social', motivo: 'falta', comoSeArregla: "cargar 'Razon Social' en la empresa" },
            { campo: 'ID_CATEGORIA_IVA', propiedad: 'condicion_iva', motivo: 'falta', comoSeArregla: "cargar 'Condicion IVA' en la empresa" },
            { campo: 'RENGLON_DTO', motivo: "'Ecografo' no sale del catalogo de productos", comoSeArregla: 'elegir un producto de la biblioteca' },
        ],
        retroceso: { label: 'Negociación' },
    });
    sinNombresInternos(html, 'la nota');
    assert.match(html, /Razon Social/);
    assert.match(html, /Productos del negocio/);
});

test('la nota de un rechazo del ERP tampoco', () => {
    const e = Object.assign(
        new Error('Tango rechazo la consulta: No hay existencias para RENGLON_DTO[1]. Solo hay 0 UNI en stock.'),
        { name: 'TangoError' },
    );
    const p = rechazoTango.comoProblema(e, {}, 'pedido');
    sinNombresInternos(notaProblema.cuerpo({ problemas: [p] }), 'la nota del rechazo');
});

test('la propiedad del negocio que ve comercial tampoco', () => {
    // `tango_pedido_problema` se ve en la ficha, no solo en la nota.
    const texto = notaProblema.resumen({
        problemas: [{ campo: 'RAZON_SOCI', propiedad: 'razon_social', motivo: 'falta', comoSeArregla: 'x' }],
    });
    sinNombresInternos(texto, 'la propiedad del negocio');
    assert.match(texto, /Razon Social/);
});

// ── El rechazo dice CUAL de las dos operaciones fallo ───────────────────────

test('un rechazo del pedido no se reporta como si fuera el alta de la empresa', () => {
    // Lo que se vio en el negocio de prueba: el ERP decia "No hay existencias
    // para RENGLON_DTO[1]" —un problema de las lineas— y la nota lo llamaba
    // "el alta de la empresa", mandando a corregir la ficha del cliente.
    const e = Object.assign(new Error('Tango rechazo la consulta: No hay existencias.'), { name: 'TangoError' });

    const pedido = rechazoTango.comoProblema(e, {}, 'pedido');
    assert.match(pedido.motivo, /no aceptó el pedido/);
    assert.ok(!/alta de la empresa/.test(pedido.motivo), pedido.motivo);
    assert.match(pedido.comoSeArregla, /en el negocio/);

    const alta = rechazoTango.comoProblema(e, {}, 'alta');
    assert.match(alta.motivo, /alta de la empresa/);
    assert.match(alta.comoSeArregla, /en la empresa/);
});

test('la nota del pedido creado tampoco muestra nombres internos', () => {
    // Es la nota que MAS se va a leer: sale en todos los pedidos que salen bien.
    const html = notaProblema.cuerpoPedidoCreado({
        nroPedido: '00001-00013602',
        resumen: {
            cliente: '007611', fechaEntrega: '2026-09-12', condicionVenta: 'MERCADOPAGO',
            moneda: 'Pesos', vendedor: 'FACUNDO', deposito: 'PRODUCTO TERMINADO',
            total: 97998, productos: ['Estimulador de Piso Pelvico'],
        },
        avisos: [{ campo: 'RENGLON_DTO', motivo: "'Ecografo' va con el articulo de prueba ZZZ (Varios)" }],
    });
    sinNombresInternos(html, 'la nota del pedido creado');
    assert.match(html, /00001-00013602/);
    assert.match(html, /Productos del negocio/, 'RENGLON_DTO traducido');
});
