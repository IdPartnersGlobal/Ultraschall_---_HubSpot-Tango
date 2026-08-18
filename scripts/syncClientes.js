#!/usr/bin/env node
'use strict';

/**
 * Corre el sync de clientes fuera de Azure, para auditarlo antes de
 * programarlo.
 *
 *   node scripts/syncClientes.js              # dry-run (default)
 *   node scripts/syncClientes.js --escribir   # escribe en HubSpot
 *
 * Toma la config de local.settings.json si no esta en el entorno.
 *
 * OJO: Tango solo acepta trafico desde la Function App, asi que la lectura
 * del ERP va a fallar desde una maquina local. Este script sirve para correr
 * contra un dump ya bajado (--dump) o desde un entorno con salida permitida.
 */

const fs = require('node:fs');
const path = require('node:path');
const sync = require('../src/lib/syncClientes');

function cargarConfigLocal() {
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
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
    if (process.argv.includes('--escribir')) env.SYNC_DRY_RUN = 'false';

    const config = sync.leerConfig(env);
    log.inicio('Sync clientes Tango -> HubSpot Companies');
    log.datos('CONFIG', {
        'Tango URL': config.TANGO_API_URL,
        'Empresa': config.TANGO_COMPANY,
        'Modo': config.DRY_RUN ? 'DRY-RUN (no escribe)' : '*** ESCRITURA REAL ***',
    });

    const r = await sync.correr({ config, log, dryRun: config.DRY_RUN });

    log.datos('RESUMEN', {
        'leidos de Tango': r.leidosTango,
        'companies en HubSpot': r.enHubSpot,
        'a crear': r.aCrear,
        'a actualizar': r.aActualizar,
        'sin cambios': r.sinCambios,
        'escritos': r.dryRun ? '(dry-run)' : r.escritos,
        'problemas de mapeo': r.problemas.length,
        'fallidos': r.fallidos.length,
        'duracion': `${(r.duracionMs / 1000).toFixed(1)}s`,
    });

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
