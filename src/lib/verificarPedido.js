'use strict';

const defaults = require('../../config/defaults.tango.json');

/**
 * Verificacion previa del pedido, cuando un negocio se gana.
 *
 * Mismo criterio que lib/verificarEmpresa y por el mismo motivo: contestar QUE
 * falta antes de llamar al ERP, en vez de mandar el pedido y comerse un
 * rechazo que no dice cual de los renglones fallo.
 *
 * Pide lo minimo indispensable (decision de Matias, 2026-08-25):
 *
 *   - una company asociada al Deal
 *   - al menos un renglon, y cada renglon con su producto atado a Tango
 *   - cantidad y precio con sentido
 *
 * Todo lo demas —talonario, deposito, moneda, validacion de stock— sale de
 * `config/defaults.tango.json`, donde hoy son valores PROVISORIOS: los process
 * de GVA43 (talonarios) y STA22 (depositos) todavia no se consiguieron, asi
 * que ni siquiera se pueden leer esas tablas para elegir bien.
 *
 * ⚠️ Que la company no tenga `tango_id_gva14` NO es un problema del pedido: es
 * un cliente que todavia no existe en el ERP y hay que darlo de alta primero
 * (§7.12). Se informa aparte, en `cliente.faltaAlta`, justamente para que no
 * se confunda con un error.
 *
 * No hace red.
 */

const PEDIDOS = defaults.pedidos;
const CAMPOS_CLIENTE = defaults.clientes.alta.campos;

/** Parametria que el pedido hereda del cliente. Ver 9.2. */
const DEL_CLIENTE = ['ID_GVA01', 'ID_GVA10', 'ID_GVA23', 'ID_GVA24'];

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

function problema(campo, motivo, comoSeArregla) {
    return { campo, motivo, comoSeArregla };
}

/** Numero de HubSpot -> numero. Las propiedades llegan siempre como texto. */
function numero(v) {
    if (vacio(v)) return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) ? n : null;
}

/**
 * Un campo de parametria del cliente. Gana lo que la company tenga cargado; si
 * no tiene, el default del catalogo, que se resuelve contra la tabla viva y no
 * queda hardcodeado (§5.4).
 */
function parametria(tangoCampo, props, lookups) {
    const campo = CAMPOS_CLIENTE.find((c) => c.tango === tangoCampo);
    if (!campo) return null;

    const cargado = numero(props[campo.hubspot]);
    if (cargado !== null) return { valor: cargado, deLaCompany: true };

    if (!campo.lookup || !campo.codigoPorDefecto || !lookups) return null;
    const r = lookups.resolver(campo.lookup, campo.codigoPorDefecto, tangoCampo);
    return r.ok ? { valor: r.id, deLaCompany: false, codigo: campo.codigoPorDefecto } : null;
}

/**
 * Fecha para Tango: 'YYYY-MM-DDTHH:mm:ss', sin zona. El ERP no interpreta el
 * offset y una fecha con 'Z' se guarda corrida.
 */
function fechaTango(valor) {
    const d = vacio(valor) ? new Date() : new Date(isNaN(Number(valor)) ? valor : Number(valor));
    if (isNaN(d.getTime())) return fechaTango(null);
    return `${d.toISOString().slice(0, 10)}T00:00:00`;
}

/**
 * @param {object} p
 * @param {object} p.deal        properties del Deal (mas su id)
 * @param {object} p.company     properties de la company asociada
 * @param {Array}  p.lineItems   line items del Deal, con properties
 * @param {Map}    p.productos   id de product de HubSpot -> properties
 * @param {object} p.lookups     tablas auxiliares
 * @returns {{ok, problemas, payload, cliente, renglones}}
 *
 * Nunca lanza: un Deal incompleto es un informe, no una excepcion.
 */
function verificar({ deal = {}, company = null, lineItems = [], productos = new Map(), lookups } = {}) {
    const problemas = [];

    // ---------------------------------------------------------- el cliente
    if (!company) {
        problemas.push(problema('ID_GVA14', 'el negocio no tiene ninguna empresa asociada',
            'asociar la empresa al negocio en HubSpot'));
    }

    const props = company || {};
    const idGva14 = numero(props.tango_id_gva14);
    const cliente = {
        idGva14,
        codigo: vacio(props.codigo_tango) ? null : String(props.codigo_tango).trim(),
        // No es un problema: es un cliente que hay que crear antes (§7.12).
        faltaAlta: !!company && idGva14 === null,
    };

    // -------------------------------------------------------- los renglones
    const renglones = [];
    if (!lineItems.length) {
        problemas.push(problema('RENGLON_DTO', 'el negocio no tiene ningun producto cargado',
            'agregar al menos una linea de producto al negocio'));
    }

    for (const item of lineItems) {
        const p = item.properties || {};
        const nombre = p.name || `line item ${item.id}`;
        const idProducto = p.hs_product_id;

        const producto = idProducto ? productos.get(String(idProducto)) : null;
        const idSta11 = producto ? numero(producto.tango_id_sta11) : null;

        if (!idProducto) {
            problemas.push(problema('RENGLON_DTO', `'${nombre}' no sale del catalogo de productos`,
                'cargar la linea eligiendo un producto de la biblioteca, no escribiendola a mano'));
            continue;
        }
        if (idSta11 === null) {
            // Es el bloqueo esperado hasta que corra el sync de productos: sin
            // el ID del articulo en Tango el renglon no se puede armar.
            problemas.push(problema('RENGLON_DTO', `'${nombre}' no esta atado a ningun articulo de Tango (falta tango_id_sta11)`,
                'esperar a que corra el sync de productos, o revisar ese producto'));
            continue;
        }

        const cantidad = numero(p.quantity);
        if (cantidad === null || cantidad <= 0) {
            problemas.push(problema('RENGLON_DTO', `'${nombre}' tiene cantidad ${p.quantity ?? '(vacia)'}`,
                'corregir la cantidad en la linea de producto'));
            continue;
        }

        const precio = numero(p.price);
        if (precio === null || precio < 0) {
            problemas.push(problema('RENGLON_DTO', `'${nombre}' tiene precio ${p.price ?? '(vacio)'}`,
                'corregir el precio en la linea de producto'));
            continue;
        }

        renglones.push({
            ID_STA11: idSta11,
            CANTIDAD_PEDIDA: cantidad,
            PRECIO: precio,
            PORCENTAJE_BONIFICACION: numero(p.hs_discount_percentage) ?? 0,
            ID_STA22: PEDIDOS.defaults.ID_STA22,
            OBSERVACIONES: '',
        });
    }

    // ----------------------------------------------------------- la cabecera
    const cabecera = {
        FECHA_PEDIDO: fechaTango(deal.closedate),
        // El ID del Deal viaja al ERP para poder rastrear el pedido hasta el
        // negocio que lo origino. Es el numero que genera HubSpot solo: no se
        // inventa una numeracion propia (decision de Matias 2026-08-25).
        LEYENDA_4: `HubSpot deal ${deal.hs_object_id ?? deal.id ?? ''}`.trim(),
        OBSERVACIONES: vacio(deal.dealname) ? '' : String(deal.dealname).slice(0, 250),
    };

    if (idGva14 !== null) cabecera.ID_GVA14 = idGva14;

    const heredado = {};
    for (const campo of DEL_CLIENTE) {
        const r = parametria(campo, props, lookups);
        if (r) { cabecera[campo] = r.valor; heredado[campo] = r; }
    }

    const payload = { ...PEDIDOS.defaults, ...cabecera, RENGLON_DTO: renglones };

    return {
        ok: problemas.length === 0,
        problemas,
        payload,
        cliente,
        renglones,
        heredado,
    };
}

module.exports = { verificar, fechaTango, DEL_CLIENTE };
