'use strict';

/**
 * Que etapa de HubSpot cuenta como "negocio ganado".
 *
 * Es el tercer control del webhook (ARQUITECTURA.md 10.2) y el que filtra el
 * volumen: llegan peticiones por TODO cambio de etapa, y la enorme mayoria no
 * son ganados. Tiene que decidirse sin tocar la red.
 *
 * ⚠️ El portal tiene DOS embudos y cada uno tiene su propia etapa de cierre
 * ganado (verificado 2026-08-25):
 *
 *     Embudo de Ventas Ultraschall   -> 'closedwon'
 *     Embudo de Licitaciones         -> '1376134021'
 *
 * Comparar contra el string 'closedwon' dejaria afuera TODOS los ganados de
 * licitaciones, y en silencio: no hay error, simplemente no pasa nada. Por eso
 * la lista arranca con las dos y se puede ampliar leyendo los pipelines.
 *
 * Decision de Matias (2026-08-25): los dos embudos cuentan como ganado.
 */

/**
 * Etapas ganadas conocidas. Es el fallback: alcanza para operar sin pedirle
 * nada a HubSpot, y se refresca con `desdePipelines` cuando conviene.
 */
const GANADAS = new Set(['closedwon', '1376134021']);

/**
 * Saca las etapas ganadas de los pipelines reales.
 *
 * El criterio es `isClosed` + probabilidad 1: una etapa cerrada con
 * probabilidad 1 es un ganado, en cualquier embudo, tenga el id que tenga.
 * Asi un embudo nuevo entra solo, sin tocar codigo.
 *
 * ⚠️ `isClosed` llega como STRING ('true'/'false'). Tratarlo como booleano da
 * verdadero siempre — incluido 'false' — y todas las etapas parecerian ganadas.
 *
 * (Nota del relevamiento: en este portal las etapas 'Cierre perdido' estan
 * marcadas `isClosed=false` en los dos embudos. Esta mal cargado, pero no nos
 * afecta: solo miramos las ganadas.)
 */
function desdePipelines(pipelines = []) {
    const salida = new Set();
    for (const p of pipelines) {
        for (const e of p.stages || []) {
            const meta = e.metadata || {};
            if (String(meta.isClosed) === 'true' && Number(meta.probability) === 1) salida.add(String(e.id));
        }
    }
    return salida.size ? salida : new Set(GANADAS);
}

/** @returns {boolean} sin red, sin excepciones. */
function esGanada(etapa, ganadas = GANADAS) {
    if (etapa === null || etapa === undefined) return false;
    return ganadas.has(String(etapa).trim());
}

module.exports = { esGanada, desdePipelines, GANADAS };
