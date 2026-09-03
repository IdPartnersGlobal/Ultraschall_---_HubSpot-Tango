'use strict';

const mapeoClientes = require('../../config/mapeo.clientes.json');
const mapeoPedidos = require('../../config/mapeo.pedidos.json');
const defaults = require('../../config/defaults.tango.json');

/**
 * Traduce los nombres internos a algo que un comercial entienda.
 *
 * POR QUE (pedido de Matias, 2026-09-03)
 * --------------------------------------
 * Las notas del negocio de prueba decian cosas asi:
 *
 *     RAZON_SOCI: falta -> cargar razon_social en la company
 *     ID_CATEGORIA_IVA: falta -> cargar condicion_iva en la company
 *     Tango: ... No hay existencias para RENGLON_DTO[1].
 *
 * `RENGLON_DTO` es el nombre del campo en el DTO de la API de Tango. `RAZON_SOCI`
 * es una columna de GVA14. `condicion_iva` es el nombre interno de la propiedad
 * de HubSpot. **Nada de eso existe para la persona que tiene que arreglarlo**, y
 * la nota entera es para esa persona: si no la entiende, no sirve de nada tener
 * el circuito.
 *
 * DE DONDE SALEN LAS ETIQUETAS
 * ----------------------------
 * Del mapeo, no de una lista escrita a mano — la leccion de siempre: una tabla
 * paralela se desfasa el dia que alguien agrega un campo, y lo que se ve es una
 * nota que vuelve a mostrar el nombre interno.
 *
 *   1. Si el problema trae `propiedad` (el nombre de HubSpot), su etiqueta sale
 *      de `mapeo.clientes` / `mapeo.pedidos`.
 *   2. Si no, se busca el campo de Tango en el catalogo del alta y se usa la
 *      propiedad de HubSpot a la que apunta.
 *   3. Los que no son un campo de nadie —`RENGLON_DTO` es el DTO del pedido,
 *      `ID_GVA14` es el vinculo con el cliente— van en OVERRIDES, que es corta
 *      a proposito: si crece, es que algo dejo de derivarse.
 *
 * Lo que NO se traduce: los logs de Azure. Ahi el nombre interno es lo util, y
 * el que los lee sabe lo que es un `ID_GVA23`.
 */

/** Lo que no es campo de nadie, o cuya etiqueta del mapeo no se entiende sola. */
const OVERRIDES = {
    RENGLON_DTO: 'Productos del negocio',
    ID_GVA14: 'Empresa del negocio',
    COD_GVA14: 'Código de cliente en Tango',
    ID_GVA23: 'Vendedor',
    ID_GVA01: 'Condición de pago',
    ID_GVA10: 'Lista de precios',
    ID_GVA24: 'Transporte',
    ID_GVA05: 'Zona',
    ID_GVA18: 'Provincia',
    ID_STA22: 'Depósito',
    ID_CATEGORIA_IVA: 'Condición de IVA',
    ID_TIPO_DOCUMENTO_GV: 'Tipo de documento',
    FECHA_PEDIDO: 'Fecha del pedido',
    COD_STA11: 'Código de artículo',
    ID_STA11: 'Artículo de Tango',
    Tango: 'Tango',
};

/** `Fecha de entrega (Tango)` -> `Fecha de entrega`. El sufijo es ruido aca. */
function limpiar(etiqueta) {
    return String(etiqueta || '').replace(/\s*\(Tango\)\s*$/i, '').trim();
}

/** nombre de propiedad de HubSpot -> etiqueta legible, de los dos mapeos. */
function construirPorPropiedad() {
    const tabla = new Map();
    for (const c of mapeoClientes.campos || []) {
        const et = limpiar(c.etiqueta || c.label);
        // `codigo_tango` tiene de etiqueta su propio nombre: no sirve de nada.
        if (c.hubspot && et && et !== c.hubspot && !tabla.has(c.hubspot)) tabla.set(c.hubspot, et);
    }
    for (const c of mapeoPedidos.campos || []) {
        const et = limpiar(c.label);
        if (c.hubspot && et && et !== c.hubspot && !tabla.has(c.hubspot)) tabla.set(c.hubspot, et);
    }
    return tabla;
}

/** campo de Tango -> la propiedad de HubSpot que lo lleva. */
function construirPorCampo() {
    const tabla = new Map();
    for (const c of defaults.clientes.alta.campos || []) {
        if (c.tango && c.hubspot && !tabla.has(c.tango)) tabla.set(c.tango, c.hubspot);
    }
    for (const c of mapeoPedidos.campos || []) {
        if (c.tango && c.hubspot && !tabla.has(c.tango)) tabla.set(c.tango, c.hubspot);
    }
    for (const c of mapeoClientes.campos || []) {
        if (c.tango && c.hubspot && !tabla.has(c.tango)) tabla.set(c.tango, c.hubspot);
    }
    return tabla;
}

const POR_PROPIEDAD = construirPorPropiedad();
const POR_CAMPO = construirPorCampo();

/**
 * La etiqueta de un problema, para mostrarsela a comercial.
 *
 * @param {string} campo      nombre del campo de Tango (`RAZON_SOCI`)
 * @param {string} [propiedad] nombre de la propiedad de HubSpot, si se sabe
 * @returns {string} algo legible; en el peor caso, el nombre que entro
 */
function etiqueta(campo, propiedad = null) {
    // OVERRIDES primero: son los que se curaron a mano justamente porque la
    // etiqueta del mapeo no se entiende sola. `tango_id_gva23` se llama "ID
    // vendedor" en la planilla, y a comercial hay que decirle "Vendedor".
    if (campo && OVERRIDES[campo]) return OVERRIDES[campo];
    if (propiedad && POR_PROPIEDAD.has(propiedad)) return POR_PROPIEDAD.get(propiedad);

    const prop = campo ? POR_CAMPO.get(campo) : null;
    if (prop && POR_PROPIEDAD.has(prop)) return POR_PROPIEDAD.get(prop);

    return String(campo || '').trim();
}

/**
 * Los nombres internos que pueden aparecer DENTRO de un texto libre.
 *
 * Hay dos fuentes que no se pueden arreglar en el origen: el mensaje que manda
 * el propio ERP (`No hay existencias para RENGLON_DTO[1]`) y cualquier texto
 * que se escriba mas adelante sin acordarse de esto. Por eso ademas de arreglar
 * las cadenas del codigo hay una pasada final.
 */
const EN_TEXTO = [
    // `RENGLON_DTO[1]` es el renglon 1 del pedido, contando desde 1.
    [/RENGLON_DTO\s*\[\s*(\d+)\s*\]/gi, (_m, n) => `el producto ${n} del negocio`],
    [/\bRENGLON_DTO\b/g, 'los productos del negocio'],
    [/\bla company\b/gi, 'la empresa'],
    [/\bcompany\b/gi, 'empresa'],
];

/**
 * Saca los nombres internos de un texto que va a leer una persona.
 *
 * Primero los patrones de arriba, despues cualquier nombre de propiedad de
 * HubSpot que haya quedado suelto (`condicion_iva` -> `Condición IVA`).
 */
function humanizar(texto) {
    let t = String(texto ?? '');
    for (const [patron, reemplazo] of EN_TEXTO) t = t.replace(patron, reemplazo);

    // Los nombres de columnas que nombra el PROPIO ERP en sus rechazos:
    // "El campo FECHA_ORDEN_COMPRA debe ser menor o igual a FECHA_PEDIDO".
    //
    // Se traduce SOLO el token que el catalogo conoce. Traducir a ciegas todo
    // lo que este en mayusculas se llevaria puesto ERP, CUIT o UNI; y
    // parafrasear un mensaje del ERP que no entendemos seria peor que
    // mostrarlo tal cual (§9.17), asi que lo desconocido queda como vino.
    t = t.replace(/[A-Z][A-Z0-9_]{2,}/g, (token) => {
        const et = etiqueta(token);
        return et && et !== token ? `'${et}'` : token;
    });

    for (const [prop, et] of POR_PROPIEDAD) {
        // Solo los que tienen pinta de nombre interno: con guion bajo. Reemplazar
        // `name` o `phone` sueltos destrozaria cualquier frase.
        if (!prop.includes('_')) continue;
        t = t.replace(new RegExp(`(?<![\\w'])${prop}(?![\\w'])`, 'g'), `'${et}'`);
    }

    // El ERP a veces ya manda el campo entrecomillado ("El campo 'LOCALIDAD'
    // debe..."), y al reemplazarlo quedan comillas dobles.
    return t.replace(/''/g, "'");
}

module.exports = { etiqueta, humanizar, limpiar, OVERRIDES };
