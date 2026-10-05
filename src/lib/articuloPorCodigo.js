'use strict';

/**
 * El articulo de Tango de un producto que tiene el CODIGO pero no el ID (§9.34).
 *
 * El renglon del pedido va con `ID_STA11`, el ID interno del articulo, y lo
 * lee de `tango_id_sta11` en el producto de HubSpot. La pasada de productos
 * (§7.17) lo dejo cargado en los que cruzaban, pero Ultraschall sigue subiendo
 * productos con el codigo de Tango en el SKU y sin el ID: hasta el 2026-10-02
 * esos renglones salian con el articulo de prueba o frenaban el pedido.
 *
 * Este paso va ANTES de verificar el pedido y no cambia nada de lo que ya
 * andaba: el producto que tiene su ID lo sigue usando y ni siquiera se consulta
 * Tango. Solo para los que no lo tienen, busca su SKU como codigo de articulo.
 * Orden final de un renglon:
 *
 *   1. `tango_id_sta11` del producto            (lo de siempre)
 *   2. el SKU como codigo de articulo en Tango  (esto)
 *   3. el articulo de prueba, si esta activo    (§9.6)
 *   4. frena con nota
 *
 * Como se compara el SKU con el codigo (decision de Matias 2026-10-05):
 *   - exacto (con los espacios de los costados recortados): se usa;
 *   - igual salvo mayusculas, y hay UN SOLO articulo asi en Tango: se usa
 *     (`L15-7B` en HubSpot es `L15-7b` en Tango, y es el mismo transductor);
 *   - igual salvo mayusculas con MAS DE UNO: no se usa, y la nota los nombra.
 * Medido el 2026-10-05: 21 de los 942 codigos tienen minusculas y ningun par
 * choca si se ignoran, asi que el tercer caso hoy no existe. Esta para que el
 * dia que aparezca no se elija uno a ciegas: mandar otro articulo no falla,
 * se entrega otra cosa. SQL Server no distingue mayusculas, asi que la consulta
 * ya trae los candidatos y la decision se toma aca.
 *
 * No escribe en HubSpot: el ID que encuentra vive solo en este pedido. Cargarlo
 * en el producto es la pasada de productos, y Matias no quiere un sync (§7.17).
 *
 * Si Tango no responde, el error sube igual que cualquier otra lectura del
 * circuito: el pedido tampoco se podria crear, y el reintento lo vuelve a
 * intentar entero.
 */

const procesos = require('../../config/tango.processes.json');

/**
 * Lo que puede ir entre comillas en el filtro. Son los caracteres que usan los
 * 942 codigos de articulo de Tango (medido el 2026-10-02): letras, numeros,
 * espacio y `- + . , / % ( ) Ñ`. Ninguno tiene comilla, y sin comilla no se
 * puede salir del literal. `%` no es comodin: el filtro es con `IN`, no `LIKE`.
 */
const CODIGO_SEGURO = /^[A-Za-z0-9Ññ .,+\-/%()]{1,15}$/;

/** Los codigos van en tandas: un `IN` con todo un negocio entra holgado. */
const TANDA = 100;

const texto = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** El SKU que se puede buscar, o null. */
function codigoBuscable(props = {}) {
    const sku = texto(props.hs_sku);
    return sku && CODIGO_SEGURO.test(sku) ? sku : null;
}

function tieneId(props = {}) {
    const id = Number(texto(props.tango_id_sta11));
    return texto(props.tango_id_sta11) !== '' && Number.isFinite(id) && id > 0;
}

/**
 * @param {object} p
 * @param {object} p.tango      cliente de Tango (`getByFilter`)
 * @param {Map}    p.productos  id de product de HubSpot -> properties
 * @returns {Promise<{productos: Map, porCodigo: Array<{producto, sku, codigo, idSta11}>}>}
 *          `productos` es un Map NUEVO: el de entrada no se toca. A los que se
 *          resolvieron se les agrega `tango_id_sta11` y `tango_id_por_codigo`
 *          (el codigo tal cual esta en Tango); a los que quedaron entre varios
 *          que solo cambian en mayusculas, `tango_codigos_parecidos`.
 */
async function completar({ tango, productos = new Map(), log } = {}) {
    const buscar = new Map(); // codigo -> [id de producto]
    for (const [id, props] of productos) {
        if (tieneId(props)) continue;
        const codigo = codigoBuscable(props);
        if (!codigo) continue;
        if (!buscar.has(codigo)) buscar.set(codigo, []);
        buscar.get(codigo).push(id);
    }

    const salida = new Map(productos);
    const porCodigo = [];
    if (!buscar.size) return { productos: salida, porCodigo };

    const codigos = [...buscar.keys()];
    const articulos = new Map(); // codigo exacto -> fila
    const sinMayusculas = new Map(); // CODIGO EN MAYUSCULAS -> [filas]
    for (let i = 0; i < codigos.length; i += TANDA) {
        const lista = codigos.slice(i, i + TANDA).map((c) => `'${c}'`).join(',');
        const filas = await tango.getByFilter(procesos.entidades.articulos.process, `COD_STA11 IN (${lista})`);
        for (const f of filas || []) {
            const cod = texto(f.COD_STA11);
            if (articulos.has(cod)) continue; // la misma fila en dos tandas
            articulos.set(cod, f);
            const clave = cod.toUpperCase();
            if (!sinMayusculas.has(clave)) sinMayusculas.set(clave, []);
            sinMayusculas.get(clave).push(f);
        }
    }

    const idValido = (f) => { const n = Number(f?.ID_STA11); return Number.isFinite(n) && n > 0 ? n : null; };

    for (const [sku, ids] of buscar) {
        // 1. Exacto. 2. Igual salvo mayusculas, si es UNO solo.
        const candidatos = sinMayusculas.get(sku.toUpperCase()) || [];
        const fila = articulos.get(sku) || (candidatos.length === 1 ? candidatos[0] : null);
        const idSta11 = idValido(fila);

        if (idSta11 === null) {
            // Varios que solo cambian en mayusculas: no se elige. La nota los
            // nombra para que quien conoce el producto corrija el SKU.
            if (candidatos.length > 1) {
                const nombres = candidatos.map((f) => texto(f.COD_STA11));
                for (const id of ids) salida.set(id, { ...salida.get(id), tango_codigos_parecidos: nombres });
            }
            continue;
        }
        const codigo = texto(fila.COD_STA11);
        for (const id of ids) {
            salida.set(id, { ...salida.get(id), tango_id_sta11: String(idSta11), tango_id_por_codigo: codigo });
            porCodigo.push({ producto: id, sku, codigo, idSta11 });
        }
    }

    if (log && porCodigo.length) {
        log.paso('PRODUCTOS', `sin ID de Tango, resueltos por su codigo: ${porCodigo.map((x) => `${x.sku}${x.sku !== x.codigo ? ` (en Tango ${x.codigo})` : ''} -> ID_STA11 ${x.idSta11}`).join(', ')}`);
    }
    return { productos: salida, porCodigo };
}

module.exports = { completar, codigoBuscable, CODIGO_SEGURO };
