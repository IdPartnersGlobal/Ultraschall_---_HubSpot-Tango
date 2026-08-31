'use strict';

const procesos = require('../../config/tango.processes.json');

/**
 * El precio de venta de un articulo, que `process=87` no devuelve.
 *
 * Los precios NO viven en STA11 sino en GVA17 (una fila por articulo y por
 * lista), y GVA17 no tiene process propio. Se llega igual por dos caminos que
 * ya estaban en el proyecto y que aca se combinan:
 *
 *   1. **Que articulos tienen precio** — una sola consulta, con la subconsulta
 *      de 7.7: `ID_STA11 IN (SELECT ID_STA11 FROM GVA17 WHERE ID_GVA10 = N)`.
 *      De 826 articulos, 133 tienen precio en la lista 2.
 *   2. **Cuanto vale** — `Api/GetById?process=87&id=<ID_STA11>` devuelve una
 *      proyeccion de 157 campos (contra 141 de `Api/Get`) que incluye el array
 *      `GVA17` con `NRO_DE_LIS`, `ID_GVA10` y `PRECIO`. Es la misma rareza por
 *      la que aparecieron los contactos en GVA27.
 *
 * El orden importa y es lo que hace esto barato: primero se pregunta QUIENES
 * (1 request) y despues se pagan los GetById solo de esos. Al reves serian 826
 * requests por corrida para completar 133 precios.
 *
 * ⚠️ La lista se configura por su NUMERO —el que dice la gente, `NRO_DE_LIS`—
 * y se resuelve al `ID_GVA10` interno contra el catalogo. Hoy coinciden en las
 * cinco listas, pero eso es suerte estructural de una tabla chica (5.4), no una
 * regla: si Ultraschall crea una sexta lista pueden dejar de coincidir, y
 * filtrar por el numero equivocado traeria el precio de OTRA lista sin error.
 */

const PROCESS_ARTICULOS = procesos.entidades.articulos.process;

/** El ID interno de una lista, a partir del numero que usa la gente. */
function idDeLista(nroDeLista, catalogo = procesos.auxiliares.listasPrecios) {
    const n = String(nroDeLista ?? '').trim();
    if (!n) return null;
    const fila = (catalogo.filas || []).find((f) => String(f.NRO_DE_LIS) === n);
    return fila ? Number(fila.ID_GVA10) : null;
}

/** El nombre de la lista, para poder decir de donde salio un precio. */
function nombreDeLista(nroDeLista, catalogo = procesos.auxiliares.listasPrecios) {
    const n = String(nroDeLista ?? '').trim();
    const fila = (catalogo.filas || []).find((f) => String(f.NRO_DE_LIS) === n);
    return fila ? fila.NOMBRE_LIS : null;
}

/**
 * La condicion para pedirle a Tango los articulos que tienen precio en una
 * lista. Se arma con el ID interno, ya resuelto: la subconsulta corre contra la
 * tabla base y ahi vive `ID_GVA10`.
 */
function condicionConPrecio(idGva10) {
    // Entero y POSITIVO. `Number(null)` da 0, que es un entero: sin el `> 0`,
    // un id nulo se colaria como `ID_GVA10 = 0` y traeria cero articulos —
    // "ningun precio cargado", que parece un dato y es un bug.
    const id = Number(idGva10);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`preciosArticulo: ID_GVA10 invalido: ${idGva10}`);
    return `ID_STA11 IN (SELECT ID_STA11 FROM GVA17 WHERE ID_GVA10 = ${id} AND PRECIO > 0)`;
}

/**
 * El precio de una lista dentro del array GVA17 de un articulo.
 *
 * Se filtra por `ID_GVA10` y no por `NRO_DE_LIS` porque el ID es la clave real;
 * el numero es lo que se muestra. Devuelve null si el articulo no tiene precio
 * en esa lista: null es "no hay", y no se puede confundir con 0.
 */
function precioDeLista(gva17, idGva10) {
    if (!Array.isArray(gva17) || !gva17.length) return null;
    const id = Number(idGva10);
    const fila = gva17.find((f) => Number(f.ID_GVA10) === id);
    if (!fila) return null;
    const precio = Number(fila.PRECIO);
    return Number.isFinite(precio) && precio > 0 ? precio : null;
}

/**
 * Los precios de una lista, para los articulos que se le pidan.
 *
 * @param {object}   p
 * @param {object}   p.tango       cliente de Tango
 * @param {number[]} p.idsSta11    ID_STA11 de los articulos a consultar
 * @param {number}   p.idGva10     ID interno de la lista, ya resuelto
 * @param {number}   [p.concurrencia]
 * @returns {Promise<{precios: Map<string, number>, fallidos: Array}>}
 */
async function porArticulo({ tango, idsSta11, idGva10, concurrencia = 4, log = null }) {
    const precios = new Map();
    const fallidos = [];
    const cola = [...idsSta11];
    let hechos = 0;

    async function trabajador() {
        while (cola.length) {
            const id = cola.shift();
            try {
                const art = await tango.getById(PROCESS_ARTICULOS, id);
                const precio = precioDeLista(art?.GVA17, idGva10);
                if (precio !== null) precios.set(String(id), precio);
            } catch (e) {
                fallidos.push({ idSta11: id, motivo: e.message });
            }
            hechos++;
            if (log && hechos % 25 === 0) log.paso('PRECIOS', `${hechos}/${idsSta11.length}`);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrencia, Math.max(1, idsSta11.length)) }, trabajador));
    return { precios, fallidos };
}

/**
 * Los precios de una lista para TODO el catalogo, en dos pasos.
 *
 * `soloIds`, si viene, acota a esos articulos: la corrida de prueba pide uno
 * solo y no tiene por que pagar los 133.
 */
async function cargar({ tango, nroDeLista, soloIds = null, concurrencia = 4, log = null }) {
    const idGva10 = idDeLista(nroDeLista);
    if (idGva10 === null) {
        throw new Error(`preciosArticulo: la lista '${nroDeLista}' no existe en el catalogo de GVA10`);
    }

    const condicion = condicionConPrecio(idGva10);
    if (log) log.paso('PRECIOS', `buscando articulos con precio en la lista ${nroDeLista} (${nombreDeLista(nroDeLista)})...`);
    const conPrecio = await tango.getByFilter(PROCESS_ARTICULOS, condicion);

    let ids = conPrecio.map((a) => Number(a.ID_STA11)).filter(Number.isInteger);
    if (soloIds) {
        const pedidos = new Set(soloIds.map((i) => Number(i)));
        ids = ids.filter((i) => pedidos.has(i));
    }
    if (log) log.paso('PRECIOS', `${conPrecio.length} articulos con precio; se consultan ${ids.length}`);

    const { precios, fallidos } = await porArticulo({ tango, idsSta11: ids, idGva10, concurrencia, log });
    return { precios, fallidos, idGva10, nombreLista: nombreDeLista(nroDeLista), conPrecioEnLaLista: conPrecio.length };
}

module.exports = {
    cargar, porArticulo, precioDeLista, condicionConPrecio, idDeLista, nombreDeLista,
    PROCESS_ARTICULOS,
};
