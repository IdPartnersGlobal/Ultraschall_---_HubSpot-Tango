'use strict';

/**
 * Formato de log unificado para toda la integracion.
 *
 * Mantiene el estilo [REQ-xxx] que ya usaba testTangoConnection, pero como
 * modulo compartido para que syncClientes, syncProductos y dealToTango
 * produzcan logs que se puedan correlacionar en Application Insights.
 */

function nuevoId() {
    return Math.random().toString(36).substring(2, 9).toUpperCase();
}

/**
 * Enmascara un secreto dejando visibles las puntas.
 * Nunca loguear una credencial completa (ver ARQUITECTURA.md 10).
 */
function enmascarar(valor) {
    if (!valor) return '❌ NO CONFIGURADA';
    if (valor.length <= 12) return '***';
    return `${valor.substring(0, 6)}...${valor.substring(valor.length - 4)}`;
}

/**
 * @param {object} context  contexto de Azure Functions
 * @param {string} proceso  nombre corto: 'SYNC-CLI', 'DEAL-TANGO', ...
 */
function crear(context, proceso) {
    const id = nuevoId();
    const inicio = Date.now();
    const log = (m) => context.log(m);
    const err = (m) => (context.error ? context.error(m) : context.log(m));

    return {
        id,
        transcurrido: () => Date.now() - inicio,

        inicio(detalle) {
            log('='.repeat(70));
            log(`🚀 [START] [${proceso}-${id}] ${detalle || ''}`);
            log('='.repeat(70));
        },

        paso(etiqueta, detalle) {
            log(`▶️  [${etiqueta}] [${proceso}-${id}] ${detalle}`);
        },

        /** Bloque de pares clave/valor alineados. */
        datos(etiqueta, obj) {
            log(`📋 [${etiqueta}] [${proceso}-${id}]`);
            const ancho = Math.max(...Object.keys(obj).map((k) => k.length));
            for (const [k, v] of Object.entries(obj)) {
                log(`   • ${k.padEnd(ancho)} : ${v}`);
            }
        },

        aviso(etiqueta, detalle) {
            log(`⚠️  [${etiqueta}] [${proceso}-${id}] ${detalle}`);
        },

        error(etiqueta, detalle) {
            err(`❌ [${etiqueta}] [${proceso}-${id}] ${detalle}`);
        },

        fin(resumen) {
            const ms = Date.now() - inicio;
            log(`🏁 [END] [${proceso}-${id}] ${resumen || ''} — ${ms}ms`);
            log('');
        },
    };
}

/** Logger que descarta todo. Para tests que no necesitan salida. */
const silencioso = {
    id: 'TEST', transcurrido: () => 0,
    inicio() {}, paso() {}, datos() {}, aviso() {}, error() {}, fin() {},
};

module.exports = { crear, enmascarar, nuevoId, silencioso };
