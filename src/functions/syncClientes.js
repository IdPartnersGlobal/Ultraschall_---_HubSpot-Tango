'use strict';

const { app } = require('@azure/functions');
const logger = require('../lib/logger');
const sync = require('../lib/syncClientes');

/**
 * Fase 2 — Tango GVA14 -> HubSpot Companies.
 *
 * Timer y no HTTP a proposito: la lectura completa de Tango tarda ~107 s y
 * un trigger HTTP corta antes (ARQUITECTURA.md 8.3). host.json sube
 * functionTimeout a 10 min, el maximo del plan Consumption.
 *
 * Horario por SYNC_CLIENTES_CRON. Default: 03:00 (hora del server).
 * Escribe solo si SYNC_DRY_RUN=false; cualquier otro valor deja el dry-run.
 */

const CRON = process.env.SYNC_CLIENTES_CRON || '0 0 3 * * *';

async function handler(_timer, context) {
    const log = logger.crear(context, 'SYNC-CLI');
    log.inicio('Sincronizacion de clientes Tango -> HubSpot Companies');

    try {
        const config = sync.leerConfig();
        log.datos('CONFIG', {
            'Tango URL': config.TANGO_API_URL,
            'Tango key': logger.enmascarar(config.TANGO_API_KEY),
            'Empresa': config.TANGO_COMPANY,
            'HubSpot token': logger.enmascarar(config.HUBSPOT_TOKEN),
            'Modo': config.DRY_RUN ? 'DRY-RUN (no escribe)' : 'ESCRITURA REAL',
        });

        const r = await sync.correr({ config, log, dryRun: config.DRY_RUN });

        log.datos('RESUMEN', {
            'leidos de Tango': r.leidosTango,
            'companies en HubSpot': r.enHubSpot,
            'a crear': r.aCrear,
            'a actualizar': r.aActualizar,
            'sin cambios': r.sinCambios,
            'escritos': r.dryRun ? '(dry-run)' : r.escritos,
            'con problemas de mapeo': r.problemas.length,
            'fallidos': r.fallidos.length,
        });

        // Un registro que falla no corta la corrida: se reporta al final.
        for (const p of r.problemas.slice(0, 20)) log.aviso('MAPEO', p);
        if (r.problemas.length > 20) log.aviso('MAPEO', `... y ${r.problemas.length - 20} mas`);
        for (const f of r.fallidos.slice(0, 20)) log.error('ESCRITURA', JSON.stringify(f));

        log.fin(r.dryRun ? 'dry-run completo' : `${r.escritos} companies escritas`);
    } catch (e) {
        log.error('FATAL', `${e.message}`);
        if (e.esFaltaDeScope) log.error('FATAL', 'Es un problema de scopes de la app de HubSpot, no del codigo.');
        log.error('FATAL', e.stack);
        throw e; // que Azure la marque como fallida
    }
}

app.timer('syncClientes', { schedule: CRON, runOnStartup: false, handler });

module.exports = { handler, CRON };
