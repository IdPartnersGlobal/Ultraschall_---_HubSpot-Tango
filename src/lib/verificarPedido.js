'use strict';

const defaults = require('../../config/defaults.tango.json');
const mapeoPedidos = require('../../config/mapeo.pedidos.json');
const enCastellano = require('./enCastellano');

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
 * `config/defaults.tango.json`. Desde el 2026-08-28 esos valores ya NO son
 * provisorios: se leyeron de los pedidos que Ultraschall ya tiene cargados en
 * el ERP. Talonario 2 "PEDIDOS" (el unico en uso, 3.234 de 3.234 pedidos de
 * 2025-2026) y deposito 01 "PRODUCTO TERMINADO" (66% de los de 2026). Los
 * process de GVA43 y STA22 nunca se consiguieron y ya no hacen falta: las
 * auxiliares se resolvieron por la columna interna de GVA21 (7.7).
 *
 * El que sigue sin evidencia es VALIDA_STOCK. Si el articulo no tiene stock,
 * Tango rechaza el pedido y el error va a parecer del circuito.
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

/**
 * Parametria que elige COMERCIAL en el Deal, con un desplegable (9.8).
 *
 * Es la unica parametria del pedido que no se hereda ni sale de un default: son
 * decisiones del negocio que ni la company ni el catalogo pueden saber. De que
 * deposito sale la mercaderia es la mas obvia — dos tercios de los pedidos
 * salen de PRODUCTO TERMINADO, pero los ~144 anuales de SERVICIO TECNICO y los
 * ~104 de EQUIPOS VETERINARIA no.
 *
 * Vacio no es un problema: es el caso normal, y va el default.
 *
 * ⚠️ `ID_GVA01` (condicion de venta) esta en las DOS listas, y no es un error:
 * se hereda del cliente, pero si comercial eligio una en el negocio, esa gana.
 * La condicion se negocia por venta —un anticipo, tres cheques— y no es un
 * atributo fijo de la empresa (decision de Matias, 2026-09-04). El orden en que
 * se arma la cabecera es lo que lo resuelve: `heredado` primero, `elegido`
 * despues. No tocar ese orden.
 */
const DEL_DEAL = ['ID_STA22', 'ID_GVA43_TALON_PED', 'ID_GVA43_TALONARIO_FACTURA', 'ID_GVA01'];

/**
 * Datos del negocio que van derecho al pedido, sin tabla que resolver (§9.18).
 *
 * `requerido: true` en el mapeo los vuelve bloqueantes. Hoy lo es solo la fecha
 * de entrega, por decision de Matias (2026-09-02): la tienen 5.975 de los 6.000
 * pedidos del padron y **tambien los dos que dejo el equipo de Tango por API**,
 * asi que no es algo que el ERP complete despues — si falta, falta.
 *
 * El numero y la fecha de la OC son del cliente y no siempre existen: opcionales.
 */
const DEL_DEAL_DIRECTO = ['FECHA_ENTREGA', 'NRO_ORDEN_COMPRA', 'FECHA_ORDEN_COMPRA'];

/** Lo que queda escrito en el pedido cuando se usa el articulo de prueba. */
const LEYENDA_PRUEBA = 'ARTICULO DE PRUEBA - integracion de productos pendiente';

/**
 * El articulo de prueba, o null si no corresponde usarlo (§9.6).
 *
 * Existe porque hoy NINGUN product de HubSpot tiene `tango_id_sta11`: sin esto
 * todos los renglones se marcan incompletos y el pedido no sale nunca, asi que
 * el circuito entero queda sin poder probarse punta a punta.
 *
 * Se apaga solo el dia que el sync de productos ate los IDs: solo actua sobre
 * un producto que NO tiene el suyo.
 *
 * @param {object} env  para poder apagarlo o cambiar el articulo sin desplegar
 */
function resolverProductoDePrueba(env = process.env) {
    const cfg = PEDIDOS.productoDePrueba;
    if (!cfg || cfg.activo !== true) return null;

    const override = String(env.TANGO_PRODUCTO_PRUEBA ?? '').trim();
    if (['off', 'false', 'no', '0'].includes(override.toLowerCase())) return null;

    const forzado = override === '' ? null : Number(override);
    if (forzado !== null && Number.isFinite(forzado) && forzado > 0) {
        return { ...cfg, idSta11: forzado, codigo: `ID_STA11=${forzado}` };
    }
    return cfg;
}

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
 * Un desplegable del Deal -> ID interno de Tango.
 *
 * El desplegable guarda el CODIGO de Tango, no el ID, y la etiqueta legible
 * ("SERVICIO TECNICO") vive aparte. El ID lo resuelve `lookups` contra la
 * tabla del catalogo: es el mismo criterio que provincias en el alta (7.10), y
 * por el mismo motivo — el codigo NO es el ID, y en depositos divergen 11 de 16.
 *
 * @returns null si comercial no eligio nada (va el default), o
 *          { valor } si resolvio, o { problema } si eligio algo que no resuelve.
 */
function deDesplegable(tangoCampo, deal, lookups) {
    const campo = mapeoPedidos.campos.find((c) => c.tango === tangoCampo && c.opcionesInversas);
    if (!campo) return null;

    const elegido = deal[campo.hubspot];
    if (vacio(elegido)) return null;

    const codigo = campo.opcionesInversas[String(elegido).trim()];
    // Que una opcion no resuelva NO puede terminar en "va el default": eso
    // manda el pedido a OTRO deposito, valido, sin que nada falle. Es
    // exactamente el modo de falla silencioso de 5.4, y frena el pedido.
    if (codigo === undefined) {
        return { problema: problema(tangoCampo, `'${elegido}' no es una opcion valida de '${enCastellano.limpiar(campo.label)}'`,
            'elegir otra opción en el negocio. Si la opción es correcta, avisar a sistemas') };
    }
    const r = lookups ? lookups.resolver(campo.lookupInverso, codigo, tangoCampo) : { ok: false, motivo: 'sin lookups' };
    if (!r.ok) {
        return { problema: problema(tangoCampo, `'${enCastellano.limpiar(campo.label)}': ${r.motivo}`,
            'avisar a sistemas: esa opción ya no existe en Tango') };
    }
    return { valor: r.id, codigo, descripcion: r.descripcion, delDeal: true };
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
 * @param {object} p.productoDePrueba  articulo de reemplazo, o null (§9.6)
 * @returns {{ok, problemas, avisos, payload, cliente, renglones}}
 *
 * Nunca lanza: un Deal incompleto es un informe, no una excepcion.
 */
function verificar({ deal = {}, company = null, lineItems = [], productos = new Map(), lookups, productoDePrueba = resolverProductoDePrueba() } = {}) {
    const problemas = [];
    // Los avisos NO frenan el pedido: son cosas que el pedido lleva y hay que
    // saber, no cosas que falten.
    const avisos = [];

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

    // ------------------------------------------- lo que eligio comercial (9.8)
    const elegido = {};
    for (const campo of DEL_DEAL) {
        const r = deDesplegable(campo, deal, lookups);
        if (!r) continue;
        if (r.problema) { problemas.push(r.problema); continue; }
        elegido[campo] = r;
    }
    const idSta22 = elegido.ID_STA22 ? elegido.ID_STA22.valor : PEDIDOS.defaults.ID_STA22;

    // -------------------------------------------------------- los renglones
    const renglones = [];
    let huboPrueba = false;
    if (!lineItems.length) {
        problemas.push(problema('RENGLON_DTO', 'el negocio no tiene ningun producto cargado',
            'agregar al menos una linea de producto al negocio'));
    }

    for (const item of lineItems) {
        const p = item.properties || {};
        const nombre = p.name || `line item ${item.id}`;
        const idProducto = p.hs_product_id;

        const producto = idProducto ? productos.get(String(idProducto)) : null;
        let idSta11 = producto ? numero(producto.tango_id_sta11) : null;
        let dePrueba = false;

        if (!idProducto) {
            // Esto NO lo cubre el articulo de prueba, a proposito: no es la
            // integracion que falta, es una linea mal cargada, y reemplazarla
            // por el articulo de prueba taparia el error.
            problemas.push(problema('RENGLON_DTO', `'${nombre}' no sale del catalogo de productos`,
                'cargar la linea eligiendo un producto de la biblioteca, no escribiendola a mano'));
            continue;
        }
        if (idSta11 === null && !productoDePrueba) {
            // Es el bloqueo esperado hasta que corra el sync de productos: sin
            // el ID del articulo en Tango el renglon no se puede armar.
            problemas.push(problema('RENGLON_DTO', `'${nombre}' todavía no está vinculado con el artículo equivalente de Tango`,
                'no es algo que se cargue en el negocio: avisar a sistemas'));
            continue;
        }
        if (idSta11 === null) {
            // El renglon sale igual, con el articulo de prueba (§9.6). Queda
            // dicho aca Y en el pedido: el ERP recibe el nombre real en
            // OBSERVACIONES y la cabecera va marcada con LEYENDA_3.
            idSta11 = productoDePrueba.idSta11;
            dePrueba = true;
            huboPrueba = true;
            avisos.push({
                campo: 'RENGLON_DTO',
                motivo: `'${nombre}' va con el articulo de prueba ${productoDePrueba.codigo} (ID_STA11=${idSta11})`,
                porQue: 'ese producto todavia no esta atado a Tango y la integracion de productos esta pendiente',
            });
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
            // El renglon sale del mismo deposito que la cabecera. Si no, el
            // pedido diria una cosa y la mercaderia saldria de otro lado.
            ID_STA22: idSta22,
            // El articulo que correspondia, para que del lado del ERP se pueda
            // leer que se pidio de verdad. Es lo unico que queda del producto
            // original cuando va el de prueba.
            OBSERVACIONES: dePrueba ? `PRUEBA - en el negocio: ${nombre}`.slice(0, 250) : '',
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

    // Los datos del negocio que van derechos al pedido (§9.18). Antes no se
    // mandaba ninguno y el pedido quedaba en Tango sin fecha de entrega ni OC,
    // que es lo primero que se nota al abrirlo al lado de uno de comercial.
    for (const tangoCampo of DEL_DEAL_DIRECTO) {
        const campo = mapeoPedidos.campos.find((c) => c.tango === tangoCampo);
        if (!campo) continue;
        const valor = deal[campo.hubspot];

        if (vacio(valor)) {
            if (campo.requerido) {
                problemas.push(problema(tangoCampo, `falta '${enCastellano.limpiar(campo.label)}' en el negocio`,
                    `cargar '${enCastellano.limpiar(campo.label)}' en el negocio y volver a moverlo a Cierre ganado`));
            }
            continue;
        }
        // Las fechas van sin zona horaria: el ERP no interpreta el offset y una
        // fecha con 'Z' se guarda corrida un dia (§9.4).
        cabecera[tangoCampo] = campo.tipo === 'date' ? fechaTango(valor) : String(valor).trim();
    }

    // Un pedido armado con el articulo de prueba tiene que ser reconocible
    // DESDE EL ERP, sin entrar a HubSpot ni a los logs. Si no, el dia que se
    // apague este modo no hay forma de saber cuales hay que dar de baja.
    if (huboPrueba) cabecera.LEYENDA_3 = LEYENDA_PRUEBA;

    const heredado = {};
    for (const campo of DEL_CLIENTE) {
        const r = parametria(campo, props, lookups);
        if (r) { cabecera[campo] = r.valor; heredado[campo] = r; }
    }

    for (const [campo, r] of Object.entries(elegido)) cabecera[campo] = r.valor;

    const payload = { ...PEDIDOS.defaults, ...cabecera, RENGLON_DTO: renglones };

    return {
        ok: problemas.length === 0,
        problemas,
        avisos,
        payload,
        cliente,
        renglones,
        heredado,
        elegido,
    };
}

module.exports = { verificar, fechaTango, resolverProductoDePrueba, deDesplegable, DEL_CLIENTE, DEL_DEAL, DEL_DEAL_DIRECTO, LEYENDA_PRUEBA };
