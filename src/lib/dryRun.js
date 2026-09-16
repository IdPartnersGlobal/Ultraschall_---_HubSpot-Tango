'use strict';

/**
 * Quien decide si un circuito ESCRIBE o solo calcula.
 *
 * Por que existe
 * --------------
 * Habia una sola variable, `SYNC_DRY_RUN`, y la leian los TRES circuitos:
 * el sync de empresas, el de productos y el de negocios. En Azure esta en
 * `false` desde el 2026-09-02, porque asi se emitio el primer pedido real
 * (§9.16). Es decir que el dia que se prenda `SYNC_CLIENTES_ENABLED`, el sync
 * de empresas arranca escribiendo 5.742 companies del portal real sin que
 * nadie haya tomado esa decision: la tomo otra variable, para otro circuito,
 * dos semanas antes.
 *
 * Al reves es igual de malo: poner `SYNC_DRY_RUN=true` para ensayar el sync de
 * empresas apagaria en silencio el circuito de negocios, que hoy funciona y
 * esta en produccion. Un negocio movido a "Cierre ganado" no emitiria pedido y
 * nada fallaria — el log diria "dry-run" y listo.
 *
 * Encender un circuito y encender los otros dos tienen que ser decisiones
 * separadas, igual que ya lo son `SYNC_CLIENTES_ENABLED`,
 * `SYNC_PRODUCTOS_ENABLED` y `DEAL_TO_TANGO_ENABLED`.
 *
 * Como se resuelve
 * ----------------
 * Cada circuito tiene su propia variable. Si esta definida, manda. Si no,
 * hereda la global `SYNC_DRY_RUN` — asi lo desplegado hoy se sigue comportando
 * exactamente igual y el circuito de negocios no se apaga solo al desplegar
 * esto.
 *
 *   SYNC_DRY_RUN_CLIENTES     el sync de empresas   (Fase 2)
 *   SYNC_DRY_RUN_PRODUCTOS    el sync de productos  (Fase 1)
 *   SYNC_DRY_RUN_NEGOCIOS     el circuito de negocios (Fase 4)
 *   SYNC_DRY_RUN              lo que herede el que no tenga la suya
 *
 * En todos los casos SOLO un `false` explicito escribe: cualquier otro valor
 * —vacio, 'False ', 'no', 'falso', un typo— deja el dry-run. El default es no
 * escribir.
 *
 * La excepcion: los circuitos que NO heredan
 * ------------------------------------------
 * `clientes` tiene `exigePropia: true`. Heredar le sirve a un circuito que ya
 * corre; a uno que nunca corrio en serio le sirve lo contrario, que nadie lo
 * encienda sin nombrarlo. El sync de empresas escribe de una vez sobre miles
 * de fichas del CRM real, asi que para escribir hay que poner
 * `SYNC_DRY_RUN_CLIENTES=false` — la global no alcanza. Sin ella corre igual,
 * calcula todo y no escribe, diciendo en el log que le falta.
 *
 * Es una marca de "todavia no es rutina", no una regla permanente: el dia que
 * el sync de empresas sea una corrida mas, se le saca `exigePropia` y pasa a
 * heredar como los otros dos.
 */

const GLOBAL = 'SYNC_DRY_RUN';

const CIRCUITOS = {
    clientes: {
        variable: 'SYNC_DRY_RUN_CLIENTES',
        que: 'el sync de empresas (Tango GVA14 -> HubSpot companies)',
        // Ver "La excepcion" arriba. Se saca cuando deje de ser la primera vez.
        exigePropia: true,
    },
    productos: {
        variable: 'SYNC_DRY_RUN_PRODUCTOS',
        que: 'el sync de productos (Tango STA11 -> HubSpot products)',
        exigePropia: false,
    },
    negocios: {
        variable: 'SYNC_DRY_RUN_NEGOCIOS',
        que: 'el circuito de negocios (HubSpot deals -> pedidos de Tango)',
        exigePropia: false,
    },
};

const vacio = (v) => v === undefined || v === null || String(v).trim() === '';

/** Solo un `false` explicito escribe. Todo lo demas —incluido un typo— es dry-run. */
const pideEscribir = (v) => !vacio(v) && String(v).trim().toLowerCase() === 'false';

/**
 * ¿Este circuito escribe? `true` = dry-run = no escribe.
 *
 * @param {'clientes'|'productos'|'negocios'} circuito
 * @param {object} [env]
 * @returns {boolean}
 */
function leer(circuito, env = process.env) {
    return resolver(circuito, env).dryRun;
}

/**
 * Lo mismo que `leer`, pero contando QUIEN lo decidio. Es lo que hace que el
 * log de arranque sirva: "dry-run" a secas no distingue entre "lo pedi yo" y
 * "me lo impuso la global del circuito de al lado".
 *
 * @returns {{circuito, dryRun, variable, valor, heredado, faltaPropia, que}}
 *   `variable`/`valor`: la que decidio y con que valor.
 *   `heredado`:    lo decidio la global, no la propia.
 *   `faltaPropia`: el circuito exige la suya y no esta definida.
 */
function resolver(circuito, env = process.env) {
    const def = CIRCUITOS[circuito];
    if (!def) throw new Error(`Circuito de dry-run desconocido: '${circuito}'. Son: ${Object.keys(CIRCUITOS).join(', ')}.`);

    const propia = env[def.variable];
    if (!vacio(propia)) {
        return {
            circuito, que: def.que, dryRun: !pideEscribir(propia),
            variable: def.variable, valor: String(propia).trim(),
            heredado: false, faltaPropia: false,
        };
    }

    if (def.exigePropia) {
        return {
            circuito, que: def.que, dryRun: true,
            variable: def.variable, valor: '(sin definir)',
            heredado: false, faltaPropia: true,
        };
    }

    const global = env[GLOBAL];
    return {
        circuito, que: def.que, dryRun: !pideEscribir(global),
        variable: GLOBAL, valor: vacio(global) ? '(sin definir)' : String(global).trim(),
        heredado: true, faltaPropia: false,
    };
}

/**
 * La linea del log de arranque. Dice el modo Y de donde salio, para que un
 * "ESCRITURA REAL" que nadie pidio para ESTE circuito se vea en el acto.
 */
function descripcion(circuito, env = process.env) {
    const r = resolver(circuito, env);

    if (!r.dryRun) {
        return r.heredado
            ? `*** ESCRITURA REAL *** (heredado de ${GLOBAL}=false, que tambien gobierna los otros circuitos; para decidirlo aca, ${CIRCUITOS[circuito].variable})`
            : `*** ESCRITURA REAL *** (${r.variable}=${r.valor})`;
    }
    if (r.faltaPropia) {
        return `DRY-RUN (no escribe) — ${r.variable} sin definir y este circuito NO hereda de ${GLOBAL}: para escribir hay que ponerla en 'false'`;
    }
    if (r.heredado) {
        return `DRY-RUN (no escribe) (heredado de ${GLOBAL}=${r.valor})`;
    }
    return `DRY-RUN (no escribe) (${r.variable}=${r.valor})`;
}

module.exports = { leer, resolver, descripcion, CIRCUITOS, GLOBAL };
