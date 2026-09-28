'use strict';

const mapeoProductos = require('../../config/mapeo.productos.json');

/**
 * Pasada UNICA: a los productos que ya estan en HubSpot se les completan los
 * datos de Tango que usa la integracion (2026-09-22). NO es el sync.
 *
 * Por que: Ultraschall subio a mano su base de productos. Trae el codigo de
 * Tango en el SKU, pero no el ID interno (`tango_id_sta11`), y sin ese ID un
 * negocio con ese producto no puede armar el renglon del pedido. Matias: "una
 * pasada completa a los productos que en el campo ref tengan subido el codigo
 * de Tango para poder subirles las propiedades que necesitamos para la
 * integracion. Necesito eso nomas y no la sincronizacion".
 *
 * Lo que la separa del sync (lib/syncProductos), a proposito:
 *
 *   - NO crea productos: solo toca los que ya estan en HubSpot.
 *   - Solo escribe las propiedades del grupo Tango ERP (`tango_*`). El nombre,
 *     la descripcion y el precio son los que cargo Ultraschall: el sync los
 *     reescribiria con los de Tango.
 *   - Solo LLENA vacios. Lo que ya tenga valor no se pisa.
 *   - No escribe el hash ni la fecha de sincronizacion: el producto no queda
 *     "sincronizado" (el nombre no es el de Tango), y un sync futuro no tiene
 *     que creer que si.
 *
 * El codigo se compara TAL CUAL (sin espacios de los costados): como en los
 * clientes (§7.5), no se adivina. Lo que se parece sin ser igual se informa y
 * no se toca.
 */

const CLAVE_TANGO = mapeoProductos._meta.claveIdempotencia.tango; // COD_STA11
const CLAVE_HS = mapeoProductos._meta.claveIdempotencia.hubspot;  // hs_sku
const NO_SE_ESCRIBEN = new Set([
    'tango_sync_hash', 'tango_ultima_sync',
    // Decision de Matias (2026-09-22), al ver los ejemplos: en Tango tienen
    // texto que no corresponde. El LX85 y el S12 dicen "Ecografo ... AX8" en
    // OBSERVACIONES, el P7-3Q dice "P5-1Q", y el C5-2Q tiene en COD_BARRA con
    // que ecografos es compatible ("LX85, LX9"). Copiarlos le pone a comercial
    // un dato equivocado con la etiqueta "Tango", y ninguno lo usa el pedido.
    'tango_observaciones', 'tango_cod_barra',
]);

/** Las propiedades que completa esta pasada: las del grupo Tango, derivadas del mapeo. */
const CAMPOS = mapeoProductos.campos
    .filter((c) => c.tango && c.hubspot && c.hubspot.startsWith('tango_') && !NO_SE_ESCRIBEN.has(c.hubspot))
    .map((c) => c.hubspot);

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';
const texto = (v) => (vacio(v) ? '' : String(v).trim());
/** Para avisar de un "parecido": sin mayusculas, espacios, guiones ni puntos. Nunca para escribir. */
const suelto = (v) => texto(v).toUpperCase().replace(/[^A-Z0-9]/g, '');

const RESULTADO = {
    COMPLETA: 'se completa',
    YA_ESTABA: 'ya estaba completo',
    OTRO_ID: 'ya tiene OTRO ID interno: no se toca',
    PARECIDO: 'el SKU se parece a un codigo de Tango, pero no es igual: no se toca',
    NO_EXISTE: 'el SKU no existe en Tango',
    SIN_SKU: 'no tiene SKU',
};

/**
 * Que escribir en cada producto. Pura: sin red.
 *
 * @param {object}   p
 * @param {object[]} p.registros  articulos de Tango (process 87)
 * @param {object[]} p.productos  products de HubSpot, con CAMPOS y el SKU
 * @param {object}   p.m          mapper de productos (lib/mapper)
 * @returns {{ updates: Array<{id, properties}>, filas: object[], resumen: object }}
 */
function planificar({ registros, productos, m }) {
    const porCodigo = new Map();
    const porSuelto = new Map();
    for (const r of registros) {
        const cod = texto(r[CLAVE_TANGO]);
        if (!cod) continue;
        porCodigo.set(cod, r);
        const s = suelto(cod);
        (porSuelto.get(s) || porSuelto.set(s, []).get(s)).push(cod);
    }

    const skusRepetidos = new Map();
    for (const p of productos) {
        const sku = texto(p.properties?.[CLAVE_HS]);
        if (sku) skusRepetidos.set(sku, (skusRepetidos.get(sku) || 0) + 1);
    }

    const updates = [];
    const filas = [];
    const resumen = { productos: productos.length, articulosTango: registros.length, porResultado: {}, camposCompletados: 0, respetados: 0, problemas: [] };

    for (const p of productos) {
        const props = p.properties || {};
        const sku = texto(props[CLAVE_HS]);
        const fila = { id: String(p.id), nombre: texto(props.name), sku, repetido: (skusRepetidos.get(sku) || 0) > 1, articulo: null, parecidos: [], completa: {}, resultado: null };
        filas.push(fila);

        if (!sku) { fila.resultado = RESULTADO.SIN_SKU; continue; }

        const articulo = porCodigo.get(sku);
        if (!articulo) {
            fila.parecidos = porSuelto.get(suelto(sku)) || [];
            fila.resultado = fila.parecidos.length ? RESULTADO.PARECIDO : RESULTADO.NO_EXISTE;
            continue;
        }
        fila.articulo = articulo;

        const { propiedades, problemas } = m.aHubSpot(articulo);
        for (const x of problemas) resumen.problemas.push(`${sku}: ${x}`);

        // El ID interno es lo que usa el pedido. Si ya tiene otro, alguien lo
        // cargo a mano o es otro articulo: no se decide solo.
        const idActual = texto(props.tango_id_sta11);
        if (idActual && idActual !== texto(propiedades.tango_id_sta11)) {
            fila.resultado = RESULTADO.OTRO_ID;
            continue;
        }

        for (const campo of CAMPOS) {
            const nuevo = propiedades[campo];
            if (vacio(nuevo)) continue;
            if (!vacio(props[campo])) { resumen.respetados++; continue; }
            fila.completa[campo] = nuevo;
        }

        if (Object.keys(fila.completa).length) {
            updates.push({ id: fila.id, properties: { ...fila.completa } });
            resumen.camposCompletados += Object.keys(fila.completa).length;
            fila.resultado = RESULTADO.COMPLETA;
        } else {
            fila.resultado = RESULTADO.YA_ESTABA;
        }
    }

    for (const f of filas) resumen.porResultado[f.resultado] = (resumen.porResultado[f.resultado] || 0) + 1;
    return { updates, filas, resumen };
}

/**
 * ¿El nombre de HubSpot y la descripcion de Tango comparten alguna palabra?
 * Es solo una senal para revisar a ojo: un SKU que existe en Tango pero es de
 * otro articulo (el `123` de una prueba, por ejemplo) sale sin palabras en comun.
 */
function palabrasEnComun(nombre, articulo) {
    const palabras = (t) => new Set(String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 2));
    const a = palabras(nombre);
    const b = palabras(`${articulo?.DESCRIPCIO ?? ''} ${articulo?.DESC_ADIC ?? ''} ${articulo?.[CLAVE_TANGO] ?? ''}`);
    return [...a].filter((w) => b.has(w));
}

module.exports = { planificar, palabrasEnComun, CAMPOS, RESULTADO, CLAVE_HS, CLAVE_TANGO };
