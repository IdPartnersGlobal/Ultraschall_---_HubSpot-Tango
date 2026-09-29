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

/**
 * A que etapa vuelve un negocio que se gano y no pudo generar el pedido (§9.9).
 *
 * Es una etapa FIJA por embudo, de la configuracion (`pedidos.retroceso` en
 * defaults.tango.json). Decision de Matias 2026-09-29, §9.32. Hasta ese dia era
 * "la anterior por displayOrder", y el 28/9 Ultraschall agrego Seguimiento
 * Masivo, No Contesta y Basura - No Calificado justo antes de Cierre ganado: dos
 * negocios de la demo terminaron en Basura. Una etapa fija no depende del orden.
 *
 * No mueve nada (null) si:
 *   - el embudo no tiene etapa configurada (un embudo nuevo no se adivina);
 *   - la etapa configurada ya no existe en el embudo (la borraron);
 *   - la etapa configurada es GANADA: mover el negocio dispara el webhook otra
 *     vez (esta suscripto a `dealstage`) y seria un bucle.
 * En esos casos la nota sale igual y el negocio queda donde esta.
 *
 * El label es el ACTUAL del portal, no el de la configuracion: si le cambian el
 * nombre a la etapa, la nota dice el nombre nuevo.
 *
 * @returns {{id, label, pipelineId, pipelineLabel}|null}
 */
function destinoDelRetroceso(etapaActual, pipelines = [], ganadas = GANADAS, porEmbudo = {}) {
    const actual = String(etapaActual ?? '').trim();
    if (!actual) return null;

    const p = pipelines.find((x) => (x.stages || []).some((s) => String(s.id) === actual));
    if (!p) return null; // la etapa no pertenece a ningun embudo conocido

    const destino = String(porEmbudo?.[String(p.id)]?.etapa ?? '').trim();
    if (!destino) return null;

    const etapa = (p.stages || []).find((s) => String(s.id) === destino);
    if (!etapa || esGanada(etapa.id, ganadas)) return null;

    return { id: String(etapa.id), label: etapa.label, pipelineId: String(p.id), pipelineLabel: p.label };
}

/** Nombre legible de una etapa, para poder nombrarla en la nota. */
function etiqueta(etapa, pipelines = []) {
    const id = String(etapa ?? '').trim();
    for (const p of pipelines) {
        for (const s of p.stages || []) if (String(s.id) === id) return s.label;
    }
    return null;
}

module.exports = { esGanada, desdePipelines, destinoDelRetroceso, etiqueta, GANADAS };
