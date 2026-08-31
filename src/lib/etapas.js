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
 * La etapa inmediatamente anterior, para devolver un negocio que se gano con
 * datos incompletos (§9.9).
 *
 * "Anterior" es por `displayOrder` dentro del MISMO embudo, no por el orden en
 * que HubSpot devuelve las etapas, que no esta garantizado.
 *
 * ⚠️ Se saltea cualquier etapa GANADA. No es teorico: mover el negocio dispara
 * el webhook otra vez (esta suscripto a `dealstage`), asi que retroceder a otra
 * etapa ganada seria un bucle. Retrocediendo a una etapa abierta el webhook
 * llega igual, pero muere en el control 3 sin gastar una sola llamada de red.
 *
 * ⚠️ NO se usa `isClosed` para saltear 'Cierre perdido': en este portal esa
 * etapa esta marcada `isClosed=false` en los dos embudos (mal cargado, ver
 * `desdePipelines`). Hoy no hace falta —medido 2026-08-28, 'Cierre perdido' va
 * DESPUES de 'Cierre ganado' en los dos, displayOrder 6 contra 5—, pero si
 * alguien reordena el embudo esto elegiria mal. El test lo fija contra los
 * embudos reales para que un reordenamiento rompa un test y no un pedido.
 *
 * @returns {{id, label, pipelineId, pipelineLabel}|null} null si no hay anterior
 */
function anterior(etapaActual, pipelines = [], ganadas = GANADAS) {
    const actual = String(etapaActual ?? '').trim();
    if (!actual) return null;

    for (const p of pipelines) {
        const ordenadas = [...(p.stages || [])].sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder));
        const i = ordenadas.findIndex((s) => String(s.id) === actual);
        if (i === -1) continue;

        for (let j = i - 1; j >= 0; j--) {
            if (esGanada(ordenadas[j].id, ganadas)) continue;
            return {
                id: String(ordenadas[j].id),
                label: ordenadas[j].label,
                pipelineId: String(p.id),
                pipelineLabel: p.label,
            };
        }
        return null; // ya estaba en la primera etapa del embudo
    }
    return null; // la etapa no pertenece a ningun embudo conocido
}

/** Nombre legible de una etapa, para poder nombrarla en la nota. */
function etiqueta(etapa, pipelines = []) {
    const id = String(etapa ?? '').trim();
    for (const p of pipelines) {
        for (const s of p.stages || []) if (String(s.id) === id) return s.label;
    }
    return null;
}

module.exports = { esGanada, desdePipelines, anterior, etiqueta, GANADAS };
