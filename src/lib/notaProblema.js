'use strict';

const enCastellano = require('./enCastellano');

/**
 * El texto de la nota que queda en el negocio cuando el pedido no se puede
 * crear en Tango.
 *
 * POR QUE UNA NOTA Y NO SOLO LA PROPIEDAD
 * ---------------------------------------
 * `tango_pedido_problema` ya existia y se mantiene: es la marca que lee el
 * circuito y la que se limpia cuando el pedido finalmente sale. Pero una
 * propiedad de texto se pisa a si misma —el ultimo intento borra el anterior—,
 * no avisa a nadie y no queda en la linea de tiempo del negocio.
 *
 * La nota es lo contrario: se acumula, aparece en la actividad del Deal donde
 * comercial ya mira, y deja el historial de cuantas veces se intento. Las dos
 * cosas juntas son la respuesta correcta: la propiedad para la maquina, la nota
 * para la persona (decision de Matias, 2026-08-28).
 *
 * Es logica pura: arma texto. No toca la red.
 */

/** HubSpot interpreta el cuerpo como HTML: hay que escapar lo que venga de datos. */
function escapar(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Un problema en una linea. `comoSeArregla` es la mitad util: decir "falta
 * razon_social" no le sirve a nadie que no sepa que es razon_social.
 *
 * ⚠️ TODO lo que sale por aca pasa por `enCastellano` (pedido de Matias,
 * 2026-09-03). Las notas mostraban `RAZON_SOCI`, `RENGLON_DTO[1]` y
 * `cargar condicion_iva en la company`: nombres de columnas de Tango, del DTO
 * de su API y de propiedades internas de HubSpot. La nota es para la persona
 * que tiene que arreglarlo, y esos nombres para ella no existen.
 */
function linea(p) {
    const campo = escapar(enCastellano.etiqueta(p.campo, p.propiedad));
    const motivo = escapar(enCastellano.humanizar(p.motivo || ''));
    const arreglo = p.comoSeArregla ? ` <i>&rarr; ${escapar(enCastellano.humanizar(p.comoSeArregla))}</i>` : '';
    return `<li><b>${campo}</b>: ${motivo}${arreglo}</li>`;
}

/**
 * `tipo` cambia como se lee la misma lista. No es cosmetico: a un negocio al
 * que le falta el CUIT hay que decirle "cargá esto"; a uno que fallo porque el
 * ERP estaba caido hay que decirle lo contrario —"no falta nada tuyo"—, o
 * comercial va a salir a buscar un dato que no existe. Los dos igual retroceden
 * de etapa, porque en los dos casos el negocio no tiene pedido (§9.9).
 *
 * @param {object} p
 * @param {Array}  p.problemas   [{campo, motivo, comoSeArregla}]
 * @param {object} [p.retroceso] {label} de la etapa a la que se movio, si se movio
 * @param {string} [p.etapaGanada] nombre legible de la etapa ganada, para el reintento
 * @param {'datos'|'rechazo'|'tecnico'} [p.tipo] de que tipo es la falla
 * @returns {string} HTML para `hs_note_body`
 */
function cuerpo({ problemas = [], retroceso = null, etapaGanada = 'Cierre ganado', tipo = 'datos' } = {}) {
    const partes = [];

    partes.push('<p><b>El pedido no se pudo crear en Tango.</b></p>');
    if (tipo === 'tecnico') {
        partes.push('<p><b>No falta ningún dato del negocio.</b> Fue un problema técnico:</p>');
    } else if (tipo === 'rechazo') {
        // No falta un dato: hay uno que Tango no acepta, o una regla del ERP
        // que no se cumple. Decir "falta este dato" manda a buscar un campo
        // vacio que no existe.
        partes.push('<p>Tango no aceptó la operación por esto:</p>');
    } else {
        partes.push(problemas.length === 1 ? '<p>Falta este dato:</p>' : `<p>Faltan ${problemas.length} datos:</p>`);
    }
    partes.push(`<ul>${problemas.map(linea).join('')}</ul>`);

    // Que el negocio se haya movido solo tiene que estar dicho ACA. Si no,
    // comercial ve el negocio en otra etapa y no sabe por que.
    if (retroceso) {
        partes.push(`<p>El negocio se movió a <b>${escapar(retroceso.label)}</b> mientras tanto.</p>`);
    }
    // ⚠️ Guardar el negocio NO dispara nada: el webhook escucha el CAMBIO DE
    // ETAPA y nada mas. Decir "volvé a guardarlo" —como decia la cola de
    // veneno— manda a alguien a hacer algo que no hace nada.
    partes.push(tipo === 'tecnico'
        ? `<p>Para reintentar, movelo a <b>${escapar(etapaGanada)}</b> otra vez cuando Tango vuelva a estar disponible.</p>`
        : `<p>Cuando cargues lo que falta, movelo de nuevo a <b>${escapar(etapaGanada)}</b>: el pedido se reintenta solo.</p>`);

    return partes.join('');
}

/** Un renglon de la ficha del pedido. Se omite si no hay dato. */
function dato(etiqueta, valor) {
    if (valor === null || valor === undefined || String(valor).trim() === '') return '';
    return `<li><b>${escapar(etiqueta)}</b>: ${escapar(valor)}</li>`;
}

/** 10859.73 -> "10.859,73". Formato de aca, que es el que lee comercial. */
function importe(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    return v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * EL PEDIDO SALIO BIEN (§9.26, pedido de Matias 2026-09-04).
 *
 * Hasta ahora un pedido exitoso no dejaba NADA en la linea de tiempo del
 * negocio: solo se escribian cuatro propiedades. Comercial veia el negocio en
 * Cierre ganado y tenia que ir a mirar campos para saber si habia salido, o
 * entrar a Tango — que es justamente lo que no hace.
 *
 * Que lleva, y por que cada cosa:
 *
 *   - El NUMERO de Tango. Es con lo que administracion busca el pedido en el
 *     ERP, y desde §9.19 es el de verdad y no el ID del negocio.
 *   - El cliente, la fecha de entrega y la moneda: lo que comercial comprometio
 *     y quiere confirmar que viajo bien.
 *   - Condicion de venta, vendedor, deposito, talonario: la parametria con la
 *     que el pedido quedo grabado. Si algo salio por default, se ve aca.
 *   - Los avisos. Hoy el unico es el articulo de prueba, y un pedido que salio
 *     con un articulo que no es el que se vendio NO puede pasar en silencio.
 *
 * @param {object} p
 * @param {string} p.nroPedido  el NRO_PEDIDO de Tango
 * @param {object} [p.resumen]  `verificarPedido.verificar().resumen`
 * @param {Array}  [p.avisos]   cosas que el pedido lleva y hay que saber
 */
function cuerpoPedidoCreado({ nroPedido, resumen = {}, avisos = [] } = {}) {
    const partes = [];
    partes.push(`<p><b>El pedido se creó en Tango: ${escapar(nroPedido)}</b></p>`);
    partes.push('<p>Con este número lo encontrás en el ERP.</p>');

    const total = importe(resumen.total);
    const filas = [
        dato('Cliente en Tango', resumen.cliente),
        dato('Fecha de entrega', resumen.fechaEntrega),
        dato('Condición de venta', resumen.condicionVenta),
        dato('Moneda', resumen.moneda),
        // "segun el negocio" y no "total del pedido" a proposito: lo calcula
        // esto sumando las lineas, no lo devuelve Tango. Ponerle el nombre del
        // total del ERP seria darle una autoridad que no tiene.
        dato('Total según el negocio', total ? `${total}${resumen.moneda ? ` ${resumen.moneda}` : ''}` : null),
        dato('Productos', resumen.productos?.length ? resumen.productos.join(', ') : null),
        dato('Vendedor', resumen.vendedor),
        dato('Depósito', resumen.deposito),
        dato('Talonario de factura', resumen.talonarioFactura),
        dato('Lista de precios', resumen.listaPrecios),
        dato('Transporte', resumen.transporte),
        dato('Orden de compra', resumen.ordenCompra),
    ].filter(Boolean).join('');

    if (filas) partes.push(`<ul>${filas}</ul>`);

    if (avisos.length) {
        partes.push(avisos.length === 1
            ? '<p><b>Una cosa a tener en cuenta:</b></p>'
            : `<p><b>${avisos.length} cosas a tener en cuenta:</b></p>`);
        partes.push(`<ul>${avisos.map(linea).join('')}</ul>`);
    }

    return partes.join('');
}

/**
 * La otra nota: el cliente SE CREO y el pedido salio, pero con lo minimo.
 *
 * Es la contracara de `cuerpo`. Aquella dice "no se pudo, arreglalo"; esta dice
 * "ya esta hecho, completalo cuando puedas". Mezclarlas seria el peor de los
 * dos mundos: o comercial ignora los errores de verdad, o sale corriendo por
 * algo que ya funciono.
 *
 * @param {object} p
 * @param {Array}  p.avisos   [{campo, motivo, comoSeArregla}]
 * @param {object} [p.cliente] {codigo} del cliente creado en Tango
 */
function cuerpoACompletar({ avisos = [], cliente = null } = {}) {
    const partes = [];
    const donde = cliente?.codigo ? ` como el cliente <b>${escapar(cliente.codigo)}</b>` : '';

    partes.push(`<p><b>La empresa se creó en Tango${donde} y el pedido salió.</b></p>`);
    partes.push(avisos.length === 1
        ? '<p>Queda un dato por completar en la empresa:</p>'
        : `<p>Quedan ${avisos.length} datos por completar en la empresa:</p>`);
    partes.push(`<ul>${avisos.map(linea).join('')}</ul>`);
    partes.push('<p>No hace falta hacer nada con el negocio: el pedido ya está en el ERP. Esto es para que la ficha del cliente quede completa.</p>');

    return partes.join('');
}

/**
 * Version en texto plano. Va a `tango_pedido_problema`, que comercial ve en la
 * ficha del negocio: tambien se traduce.
 */
function resumen({ problemas = [] } = {}) {
    return problemas
        .map((p) => `${enCastellano.etiqueta(p.campo, p.propiedad)}: ${enCastellano.humanizar(p.motivo)}`)
        .join(' | ');
}

module.exports = { cuerpo, cuerpoPedidoCreado, cuerpoACompletar, resumen, escapar };
