'use strict';

/**
 * Eleccion del COD_GVA14 para un cliente que se da de alta desde HubSpot.
 *
 * Tango NO autoasigna el codigo (verificado 2026-08-21, ARQUITECTURA.md 7.6):
 * sin COD_GVA14 el alta se rechaza con "La codificacion automatica no esta
 * disponible para este tipo de apertura". O sea que el numero lo elige la
 * integracion y la respuesta de Tango solo confirma lo que mandamos.
 *
 * Dos estrategias, ambas pendientes de que administracion elija (§7.6):
 *
 *   correlativo — sigue despues del maximo de la cartera (hoy 007610). Respeta
 *                 la convencion que usa administracion. Puede colisionar si un
 *                 operador da de alta en Tango en el mismo momento; la colision
 *                 FALLA, no corrompe, y se reintenta con el candidato siguiente.
 *   reservado   — arranca en 900001. No colisiona nunca y deja a la vista en el
 *                 ERP que ese cliente vino del CRM.
 *
 * El algoritmo es el mismo para las dos: primer numero libre hacia arriba desde
 * un piso. Lo unico que cambia es el piso.
 *
 * ⚠️ Ni una ni otra rellena los 1.943 huecos que hay entre 1 y 7610. Es
 * deliberado: un hueco es un codigo que administracion dio de baja, y reusarlo
 * mezclaria el historial de dos clientes distintos.
 */

const ANCHO = 6;
const RESERVADO_DESDE = 900001;
const ESTRATEGIAS = ['correlativo', 'reservado'];

/**
 * ⚠️ El indice de ocupados va por VALOR NUMERICO, no por texto.
 *
 * En la cartera conviven codigos de largo 5 y de largo 6 (750 de largo 5,
 * §7.6), asi que '07610' y '007610' son dos strings distintos que Tango acepta
 * como dos clientes distintos. Generar '007611' cuando ya existe '07611' seria
 * legal para el ERP y un desastre para cualquiera que despues los mire.
 * Comparando por numero, una variante de padding cuenta como ocupada.
 *
 * Ojo con la vuelta de rosca: esto vale para ELEGIR un codigo nuevo. Para
 * escribirlo en HubSpot sigue valiendo la regla de §7.5 — `codigo_tango` se
 * copia tal cual viene de Tango, sin normalizar ni rellenar con ceros.
 */
function ocupados(codigos) {
    const set = new Set();
    for (const c of codigos) {
        if (c === null || c === undefined) continue;
        const s = String(c).trim();
        if (!/^\d+$/.test(s)) continue; // un codigo no numerico no compite por el espacio
        set.add(Number(s));
    }
    return set;
}

/** '7611' -> '007611'. Falla si no entra: es sintoma de que el espacio se agoto. */
function formatear(n) {
    const s = String(n);
    if (s.length > ANCHO) {
        throw new Error(
            `numeracion: ${n} no entra en ${ANCHO} digitos. El espacio de codigos se agoto ` +
            'o la estrategia esta mal configurada.'
        );
    }
    return s.padStart(ANCHO, '0');
}

/**
 * Candidatos para el alta, en orden.
 *
 * Devuelve varios (no uno) a proposito: si Tango rechaza el primero porque un
 * operador se adelanto, el alta reintenta con el siguiente sin volver a leer
 * el padron entero.
 *
 * @param {Array<string|number>} codigosExistentes  COD_GVA14 de todo el padron
 * @param {object} opciones
 * @param {'correlativo'|'reservado'} opciones.estrategia
 * @param {number} [opciones.cantidad=3]        cuantos candidatos devolver
 * @param {number} [opciones.reservadoDesde]    piso del rango reservado
 * @returns {{ codigos: string[], estrategia: string, piso: number }}
 */
function planificar(codigosExistentes, { estrategia, cantidad = 3, reservadoDesde = RESERVADO_DESDE } = {}) {
    if (!ESTRATEGIAS.includes(estrategia)) {
        throw new Error(
            `numeracion: estrategia '${estrategia}' desconocida. Es una decision de administracion de ` +
            `Ultraschall todavia pendiente (ARQUITECTURA.md 7.6); las opciones son: ${ESTRATEGIAS.join(', ')}.`
        );
    }
    if (!Number.isInteger(cantidad) || cantidad < 1) throw new Error('numeracion: cantidad tiene que ser >= 1');

    const tomados = ocupados(codigosExistentes);

    let piso;
    if (estrategia === 'reservado') {
        piso = reservadoDesde;
    } else {
        // Maximo de la cartera real: lo que esta dentro del rango reservado no
        // cuenta. Sin este corte, los registros de prueba 999998/999999 (§7.6)
        // arrastrarian el correlativo a 1000000.
        let max = 0;
        for (const n of tomados) if (n < reservadoDesde && n > max) max = n;
        piso = max + 1;
    }

    const codigos = [];
    for (let n = piso; codigos.length < cantidad; n++) {
        if (tomados.has(n)) continue;
        codigos.push(formatear(n));
    }

    return { codigos, estrategia, piso };
}

module.exports = { planificar, ocupados, formatear, ANCHO, RESERVADO_DESDE, ESTRATEGIAS };
