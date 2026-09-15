'use strict';

const defaults = require('../../config/defaults.tango.json');
const mapeoPedidos = require('../../config/mapeo.pedidos.json');
const enCastellano = require('./enCastellano');
const verificarEmpresa = require('./verificarEmpresa');

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

/**
 * Parametria que elige COMERCIAL en el Deal, con un desplegable (9.8).
 *
 * ⚠️ EL PEDIDO NO HEREDA NADA DEL CLIENTE (decision de Matias, 2026-09-15,
 * §9.29): *"esas propiedades se sacan del negocio, el cliente nomas lo queremos
 * para hacer la asociacion"*. Del cliente sale `ID_GVA14` y nada mas.
 *
 * Hasta ese dia la condicion de venta, el transporte, la lista y el vendedor se
 * tomaban del cliente cuando el negocio no los traia, y recien si el cliente
 * tampoco, del default. Con la importacion masiva eso pasaba a ser el caso
 * normal: el pedido salia con el transporte y la condicion que el ERP tuviera
 * guardados para esa empresa, sin que comercial los hubiera elegido.
 *
 * De donde sale cada uno ahora:
 *
 *   - condicion de venta, transporte -> el negocio, OBLIGATORIOS (`requerido`
 *     en el mapeo). Si faltan, frena.
 *   - deposito, talonarios           -> el negocio; vacio va el default.
 *   - lista de precios               -> la moneda del negocio (§9.27).
 *   - vendedor                       -> el owner del negocio (§9.19).
 */
const DEL_DEAL = ['ID_STA22', 'ID_GVA43_TALON_PED', 'ID_GVA43_TALONARIO_FACTURA', 'ID_GVA01', 'ID_GVA24'];

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

/** 'ARS' -> 'Pesos', para los mensajes. Cae al codigo si no esta en la tabla. */
function codigoLegible(codigo) {
    const t = (PEDIDOS.monedas || {}).porCodigoDeHubSpot || {};
    const d = (PEDIDOS.monedas || {}).descripciones || {};
    const fila = t[codigo];
    return (fila && d[String(fila.idMoneda)]) || codigo;
}

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
 * Un desplegable del Deal -> ID interno de Tango.
 *
 * El desplegable guarda el CODIGO de Tango, no el ID, y la etiqueta legible
 * ("SERVICIO TECNICO") vive aparte. El ID lo resuelve `lookups` contra la
 * tabla del catalogo: es el mismo criterio que provincias en el alta (7.10), y
 * por el mismo motivo — el codigo NO es el ID, y en depositos divergen 11 de 16.
 *
 * @returns null si comercial no eligio nada (va el default), o
 *          { valor } si resolvio, o { problema } si eligio algo que no resuelve
 *          o no eligio nada en un campo `requerido`.
 */
function deDesplegable(tangoCampo, deal, lookups) {
    const campo = mapeoPedidos.campos.find((c) => c.tango === tangoCampo && c.opcionesInversas);
    if (!campo) return null;

    const elegido = deal[campo.hubspot];
    if (vacio(elegido)) {
        // Condicion de venta y transporte (§9.29): sin eleccion en el negocio
        // no hay de donde sacarlos. El cliente ya no se mira, y un default
        // equivocado —CONTADO, RETIRA CLIENTE— no falla: sale mal la factura o
        // el envio.
        if (!campo.requerido) return null;
        const etiqueta = enCastellano.limpiar(campo.label);
        return { problema: problema(tangoCampo, 'no se eligió en el negocio', `elegir '${etiqueta}' en el negocio`) };
    }

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
 * La moneda del pedido, desde `deal_currency_code` del negocio (2026-09-04).
 *
 * Antes `ID_MONEDA` era un valor fijo en 1 (Pesos) y la moneda del negocio ni
 * se leia. Un negocio en USD entraba a Tango como pesos **con los importes en
 * dolares**: un equipo de USD 3.000 quedaba como 3.000 pesos y no fallaba nada.
 * En el portal habia 4 negocios asi el dia que se implemento esto.
 *
 * ⚠️ Una moneda que no este en la tabla FRENA el pedido. Caer al default seria
 * el mismo modo de falla que se acaba de cerrar, y ademas silencioso: el ERP
 * acepta el pedido igual y el importe queda mal por un factor de mil.
 *
 * Sin moneda en el negocio va la moneda del default (Pesos) CON SU LISTA. Hasta
 * el 2026-09-15 la lista, en ese caso, se heredaba del cliente; desde §9.29 el
 * pedido no hereda nada, y la lista sigue yendo pareja con la moneda.
 *
 * @returns {{valor, codigo, idListaPrecios, porDefecto?}|{problema}|null}
 */
function monedaDelNegocio(deal) {
    const cfg = PEDIDOS.monedas || {};
    const tabla = cfg.porCodigoDeHubSpot || {};
    const codigo = String(deal.deal_currency_code ?? '').trim().toUpperCase();

    if (!codigo) {
        const [codigoDefault, fila] = Object.entries(tabla).find(([, f]) => f.idMoneda === PEDIDOS.defaults.ID_MONEDA) || [];
        return fila ? { valor: fila.idMoneda, codigo: codigoDefault, idListaPrecios: fila.idListaPrecios, porDefecto: true } : null;
    }

    const fila = tabla[codigo];
    if (fila === undefined) {
        return {
            problema: problema('ID_MONEDA', `el negocio esta en '${codigo}' y esa moneda no esta configurada para Tango`,
                `pasar el negocio a una de las monedas configuradas (${Object.keys(tabla).join(', ')}), o avisar a sistemas para que agreguen '${codigo}'`),
        };
    }
    return { valor: fila.idMoneda, codigo, idListaPrecios: fila.idListaPrecios };
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
 * Lo que el pedido lleva, en castellano, para la nota que ve comercial (§9.26).
 *
 * Traduce los IDs internos que se mandaron al ERP a los nombres que la gente
 * reconoce: `ID_GVA23 26` no le dice nada a nadie, "Juan Butorac" si. La
 * traduccion va por `descripcionPorId` porque a esta altura el dato YA esta
 * resuelto a ID — es literalmente lo que viajo en el payload.
 *
 * Nunca lanza ni frena: si una tabla no esta cargada, ese renglon no sale y el
 * resto de la nota igual. El pedido ya esta en el ERP cuando esto se usa.
 */
function resumenParaComercial({ payload, renglones, lineItems = [], lookups }) {
    const desc = (tabla, id) => {
        if (id === undefined || id === null || !lookups) return null;
        try { return lookups.descripcionPorId(tabla, id); } catch { return null; }
    };
    const monedas = (PEDIDOS.monedas || {}).descripciones || {};

    const total = renglones.reduce((suma, r) => {
        const bruto = (Number(r.CANTIDAD_PEDIDA) || 0) * (Number(r.PRECIO) || 0);
        return suma + bruto * (1 - (Number(r.PORCENTAJE_BONIFICACION) || 0) / 100);
    }, 0);

    const nombres = new Map(lineItems.map((l) => [String(l.id), l.properties?.name]));

    return {
        cliente: payload.ID_GVA14 ?? null,
        fechaEntrega: payload.FECHA_ENTREGA ? String(payload.FECHA_ENTREGA).slice(0, 10) : null,
        moneda: monedas[String(payload.ID_MONEDA)] || null,
        condicionVenta: desc('condicionesVenta', payload.ID_GVA01),
        listaPrecios: desc('listasPrecios', payload.ID_GVA10),
        vendedor: desc('vendedores', payload.ID_GVA23),
        transporte: desc('transportes', payload.ID_GVA24),
        deposito: desc('depositos', payload.ID_STA22),
        talonarioFactura: desc('talonariosFactura', payload.ID_GVA43_TALONARIO_FACTURA),
        ordenCompra: payload.NRO_ORDEN_COMPRA || null,
        renglones: renglones.length,
        total,
        // Los nombres reales de lo que se vendio, que es lo primero que
        // comercial va a querer confirmar.
        productos: lineItems.map((l) => nombres.get(String(l.id))).filter(Boolean),
    };
}

/**
 * @param {object} p
 * @param {object} p.deal        properties del Deal (mas su id)
 * @param {object} p.company     properties de la company asociada
 * @param {Array}  p.lineItems   line items del Deal, con properties
 * @param {Map}    p.productos   id de product de HubSpot -> properties
 * @param {object} p.lookups     tablas auxiliares
 * @param {object} p.productoDePrueba  articulo de reemplazo, o null (§9.6)
 * @param {Map}    [p.owners]    id de owner de HubSpot -> mail. Sin esto no hay
 *                               vendedor y el pedido FRENA (§9.19, §9.29).
 * @returns {{ok, problemas, avisos, payload, cliente, renglones}}
 *
 * Nunca lanza: un Deal incompleto es un informe, no una excepcion.
 */
function verificar({ deal = {}, company = null, lineItems = [], productos = new Map(), lookups, owners = null, productoDePrueba = resolverProductoDePrueba() } = {}) {
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

    // La moneda no sale de una tabla de Tango —no hay `process` para monedas—
    // asi que no pasa por `deDesplegable`, pero el criterio es el mismo.
    const moneda = monedaDelNegocio(deal);
    if (moneda && moneda.problema) {
        problemas.push(moneda.problema);
    } else if (moneda) {
        elegido.ID_MONEDA = moneda;
        // La lista de precios VA CON LA MONEDA (decision de Matias 2026-09-04):
        // ARS -> lista 1 (SIN IVA EN $), USD -> lista 2 (SIN IVA EN U$S).
        //
        // Un pedido en dolares con una lista en pesos es plata mal calculada, y
        // era lo que pasaba: `ID_GVA10` se heredaba del cliente y `ID_MONEDA` era
        // fijo en pesos, asi que los dos campos no se miraban nunca entre si.
        if (moneda.idListaPrecios !== undefined) {
            elegido.ID_GVA10 = { valor: moneda.idListaPrecios, porLaMoneda: codigoLegible(moneda.codigo) };
        }
    }

    // El vendedor es quien cerro la venta: el owner del negocio (§9.19). Hasta
    // el 2026-09-15 eso valia solo para el cliente que se CREA; el pedido de un
    // cliente existente llevaba el vendedor que el ERP tuviera asignado (§9.29).
    const vendedor = verificarEmpresa.vendedorDelOwner({ ownerId: deal.hubspot_owner_id, owners, lookups });
    if (vendedor.problema) problemas.push(vendedor.problema);
    else elegido.ID_GVA23 = { valor: vendedor.valor, porOwner: vendedor.mail };

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
                // El ID interno no va: esto lo lee comercial y el articulo se
                // busca por su codigo, no por su ID (§9.21).
                motivo: `'${nombre}' va con el articulo de prueba ${productoDePrueba.codigo}${productoDePrueba.descripcion ? ` (${productoDePrueba.descripcion})` : ''}`,
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

    // Del cliente, nada mas que `ID_GVA14` (§9.29). Lo demas sale del negocio.
    for (const [campo, r] of Object.entries(elegido)) cabecera[campo] = r.valor;

    const payload = { ...PEDIDOS.defaults, ...cabecera, RENGLON_DTO: renglones };

    return {
        ok: problemas.length === 0,
        problemas,
        avisos,
        payload,
        cliente,
        renglones,
        elegido,
        resumen: resumenParaComercial({ payload, renglones, lineItems, lookups }),
    };
}

module.exports = { verificar, fechaTango, resolverProductoDePrueba, deDesplegable, DEL_DEAL, DEL_DEAL_DIRECTO, LEYENDA_PRUEBA };
