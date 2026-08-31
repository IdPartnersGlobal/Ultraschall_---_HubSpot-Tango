#!/usr/bin/env node
'use strict';

/**
 * Corre el sync de articulos fuera de Azure, para auditarlo antes de
 * programarlo.
 *
 *   node scripts/syncProductos.js                       # dry-run (default)
 *   node scripts/syncProductos.js --solo ART-001        # un articulo puntual
 *   node scripts/syncProductos.js --solo ART-001 --escribir
 *
 * Toma la config de local.settings.json si no esta en el entorno. `--solo`
 * pisa a SYNC_PRODUCTOS_SOLO.
 *
 * Tango solo acepta trafico desde la Function App (5.6). Desde cualquier otra
 * maquina hay que salir por el proxy desplegado:
 *
 *   node scripts/syncProductos.js --proxy https://<funcion>/api/testTangoConnection
 *
 * o dejando `TANGO_PROXY_URL` en local.settings.json. Ver lib/proxyTango.
 */

const fs = require('node:fs');
const path = require('node:path');
const sync = require('../src/lib/syncProductos');
const tangoClient = require('../src/lib/tangoClient');
const { fetchPorProxy } = require('../src/lib/proxyTango');

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

    // --solo ART-001[,ART-002]: limita la corrida. Es lo que se usa para la
    // primera prueba contra el ERP, con UN articulo.
    const iSolo = process.argv.indexOf('--solo');
    if (iSolo !== -1 && process.argv[iSolo + 1]) env.SYNC_PRODUCTOS_SOLO = process.argv[iSolo + 1];

    // --proxy <url>: salir por la Function App en vez de hablarle a Tango de
    // frente. Es lo unico que hace falta para correr esto desde afuera.
    const iProxy = process.argv.indexOf('--proxy');
    const urlProxy = (iProxy !== -1 && process.argv[iProxy + 1]) || env.TANGO_PROXY_URL || null;

    const config = sync.leerConfig(env);
    log.inicio('Sync articulos Tango -> HubSpot Products');
    log.datos('CONFIG', {
        'Tango URL': config.TANGO_API_URL,
        'Salida': urlProxy ? `por el proxy (${new URL(urlProxy).host})` : 'directa (solo funciona desde Azure)',
        'Empresa': config.TANGO_COMPANY,
        'Articulos': config.SOLO_CODIGOS.length ? config.SOLO_CODIGOS.join(', ') : 'TODOS',
        'Perfiles que se publican': config.PERFILES.length ? config.PERFILES.join(', ') : 'todos',
        'Lista de precios': config.LISTA_PRECIOS ?? '(apagada)',
        'Modo': config.DRY_RUN ? 'DRY-RUN (no escribe)' : '*** ESCRITURA REAL ***',
    });

    const tango = urlProxy
        ? tangoClient.crear({
            baseUrl: config.TANGO_API_URL,
            apiKey: config.TANGO_API_KEY,
            company: config.TANGO_COMPANY,
            log,
            fetchImpl: fetchPorProxy(urlProxy),
        })
        : null;

    const r = await sync.correr({ config, log, dryRun: config.DRY_RUN, tango });

    log.datos('RESUMEN', {
        'leidos de Tango': r.leidosTango,
        'despues del filtro': r.filtrados,
        'products en HubSpot': r.enHubSpot,
        'a crear': r.aCrear,
        'a actualizar': r.aActualizar,
        'sin cambios': r.sinCambios,
        'excluidos por perfil': r.excluidosPorPerfil,
        'precios completados': `${r.preciosCompletados} (lista ${r.listaPrecios ?? '-'}${r.nombreLista ? `, ${r.nombreLista}` : ''})`,
        'sin precio en Tango': r.sinPrecioEnTango,
        'precios respetados': r.preciosRespetados,
        'escritos': r.dryRun ? '(dry-run)' : r.escritos,
        'problemas de mapeo': r.problemas.length,
        'fallidos': r.fallidos.length,
        'duracion': `${(r.duracionMs / 1000).toFixed(1)}s`,
    });

    if (r.problemas.length) {
        const porTipo = {};
        for (const p of r.problemas) {
            const k = p.replace(/'[^']*'/g, "'X'").replace(/\(articulo [^)]*\)/, '').trim();
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
