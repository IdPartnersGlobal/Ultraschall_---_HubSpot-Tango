'use strict';

const { app } = require('@azure/functions');
const logger = require('../lib/logger');
const sync = require('../lib/syncProductos');

/**
 * Fase 1 — Tango STA11 -> HubSpot Products.
 *
 * Timer, por el mismo motivo que el de clientes: la lectura del ERP tarda y un
 * trigger HTTP corta antes (ARQUITECTURA.md 8.3).
 *
 * DOS VECES POR DIA (decision de Matias, 2026-08-25): 06:00 y 18:00 hora del
 * server. Se corre a las 6 y no a las 3 para no pisarse con el sync de
 * clientes, que arranca a las 3 y lee el padron entero.
 *
 * Se puede cambiar con SYNC_PRODUCTOS_CRON.
 */

const CRON = process.env.SYNC_PRODUCTOS_CRON || '0 0 6,18 * * *';

/**
 * Interruptor explicito, apagado por defecto. Igual que el de clientes:
 * desplegar el codigo y activar algo que escribe en el CRM son dos decisiones
 * distintas.
 */
const HABILITADO = String(process.env.SYNC_PRODUCTOS_ENABLED || 'false').toLowerCase() === 'true';

async function handler(_timer, context) {
    const log = logger.crear(context, 'SYNC-PRO');

    if (!HABILITADO) {
        context.log('[SYNC-PRO] deshabilitado (SYNC_PRODUCTOS_ENABLED != true). No se hace nada.');
        return;
    }

    log.inicio('Sincronizacion de articulos Tango -> HubSpot Products');

    try {
        const config = sync.leerConfig();
        log.datos('CONFIG', {
            'Tango URL': config.TANGO_API_URL,
            'Tango key': logger.enmascarar(config.TANGO_API_KEY),
            'Empresa': config.TANGO_COMPANY,
            'HubSpot token': logger.enmascarar(config.HUBSPOT_TOKEN),
            'Articulos': config.SOLO_CODIGOS.length ? config.SOLO_CODIGOS.join(', ') : 'TODOS',
            'Modo': config.DRY_RUN ? 'DRY-RUN (no escribe)' : 'ESCRITURA REAL',
        });

        const r = await sync.correr({ config, log, dryRun: config.DRY_RUN });

        log.datos('RESUMEN', {
            'leidos de Tango': r.leidosTango,
            'despues del filtro': r.filtrados,
            'products en HubSpot': r.enHubSpot,
            'a crear': r.aCrear,
            'a actualizar': r.aActualizar,
            'sin cambios': r.sinCambios,
            'campos respetados': r.respetados,
            'escritos': r.dryRun ? '(dry-run)' : r.escritos,
            'con problemas de mapeo': r.problemas.length,
            'fallidos': r.fallidos.length,
            'duracion': `${Math.round(r.duracionMs / 1000)}s`,
        });

        for (const p of r.problemas.slice(0, 20)) log.aviso('MAPEO', p);
        for (const f of r.fallidos.slice(0, 20)) log.error('HUBSPOT', JSON.stringify(f).slice(0, 300));

        log.fin('Sincronizacion de articulos terminada');
    } catch (e) {
        log.error('FATAL', `${e.message}`);
        throw e;
    }
}

app.timer('syncProductos', { schedule: CRON, runOnStartup: false, handler });
