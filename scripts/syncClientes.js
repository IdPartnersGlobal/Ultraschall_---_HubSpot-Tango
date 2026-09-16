#!/usr/bin/env node
'use strict';

/**
 * Corre el sync de clientes fuera de Azure, para auditarlo antes de
 * programarlo.
 *
 *   node scripts/syncClientes.js --proxy <url>   # dry-run contra el Tango de la Function App
 *   node scripts/syncClientes.js --escribir      # escribe en HubSpot (solo sin proxy)
 *
 * `--escribir` pone SYNC_DRY_RUN_CLIENTES=false para ESTA corrida y nada mas:
 * no toca el modo del sync de productos ni el del circuito de negocios.
 *
 * Toma la config de local.settings.json si no esta en el entorno.
 *
 * ⚠️ Tango solo acepta trafico desde la Function App (§5.6), asi que desde una
 * maquina local hace falta `--proxy` con la URL de `testTangoConnection`.
 *
 * ⚠️ Con `--proxy` NO se puede escribir, a proposito. El proxy manda SU
 * `TANGO_COMPANY` —la de Azure— y no la local, asi que desde aca no hay forma
 * de verificar contra que empresa se leyo, y el sync solo escribe contra
 * productivo (§7.15). La escritura real es la del timer en Azure.
 */

const fs = require('node:fs');
const path = require('node:path');
const sync = require('../src/lib/syncClientes');
const { fetchPorProxy } = require('../src/lib/proxyTango');

function cargarConfigLocal() {
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
}

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

/** La URL completa de testTangoConnection, aunque pasen la raiz (ver ensayoNegocios). */
function urlDelProxy(url) {
    if (!url) return null;
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/api/testTangoConnection';
    return u.toString();
}

// Logger de consola con el mismo contrato que el de Azure.
const log = {
    inicio: (m) => console.log(`\n${'='.repeat(70)}\n${m}\n${'='.repeat(70)}`),
    paso: (e, m) => console.log(`  [${e}] ${m}`),
    datos: (e, o) => {
        console.log(`\n[${e}]`);
        const w = Math.max(...Object.keys(o).map((k) => k.length));
        for (const [k, v] of Object.entries(o)) console.log(`   ${k.padEnd(w)} : ${v}`);
    },
    aviso: (e, m) => console.log(`  ! [${e}] ${m}`),
    error: (e, m) => console.error(`  X [${e}] ${m}`),
    fin: (m) => console.log(`\n${m}\n`),
};

(async () => {
    const env = { ...cargarConfigLocal(), ...process.env };
    const proxy = urlDelProxy(opcion('--proxy'));
    const escribir = args.includes('--escribir');
    if (escribir && proxy) throw new Error('con --proxy no se escribe: la empresa de Tango la decide Azure y desde aca no se puede verificar (§7.15)');
    // La propia, no la global: la global tambien prende productos y negocios.
    if (escribir) env.SYNC_DRY_RUN_CLIENTES = 'false';

    const config = sync.leerConfig(env);
    log.inicio('Sync clientes Tango -> HubSpot Companies');
    log.datos('CONFIG', {
        'Tango URL': config.TANGO_API_URL,
        'Empresa': proxy ? `la de la Function App (via proxy ${proxy})` : config.TANGO_COMPANY,
        'Modo': config.MODO,
    });

    const r = await sync.correr({ config, log, dryRun: config.DRY_RUN, fetchImpl: proxy ? fetchPorProxy(proxy) : undefined });

    log.datos('RESUMEN', {
        'leidos de Tango': r.leidosTango,
        'companies en HubSpot': r.enHubSpot,
        'a crear': r.aCrear,
        'a vincular (importadas)': r.aVincular,
        'a actualizar': r.aActualizar,
        'sin cambios': r.sinCambios,
        'etiquetas cambiadas': r.etiquetasCambiadas,
        'campos respetados': r.respetados,
        'escritos': r.dryRun ? '(dry-run)' : r.escritos,
        'problemas de mapeo': r.problemas.length,
        'fallidos': r.fallidos.length,
        'duracion': `${(r.duracionMs / 1000).toFixed(1)}s`,
    });

    console.log('\nestado en Tango que quedaria:');
    for (const [k, v] of Object.entries(r.estados).sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(6)}  ${k}`);

    if (r.conflictos.length) {
        console.log(`\nconflictos (${r.conflictos.length}): no se vincula ni se crea nada`);
        for (const c of r.conflictos) console.log(`   ${c.codigo}  ${c.tipo}  -> ${c.empresas.join(', ')}`);
    }

    if (r.problemas.length) {
        const porTipo = {};
        for (const p of r.problemas) {
            const k = p.replace(/'[^']*'/g, "'X'").replace(/\(cliente [^)]*\)/, '').trim();
            porTipo[k] = (porTipo[k] || 0) + 1;
        }
        console.log('\nproblemas de mapeo por tipo:');
        for (const [k, v] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) {
            console.log(`   ${String(v).padStart(5)}  ${k}`);
        }
    }
    log.fin(r.dryRun ? 'dry-run completo, no se escribio nada.' : 'listo.');
})().catch((e) => {
    console.error('\nFALLO:', e.message);
    process.exit(1);
});
