#!/usr/bin/env node
'use strict';

/**
 * El ensayo general de la Fase 4: que pasaria con cada negocio ganado si el
 * circuito estuviera conectado, SIN escribir una sola cosa.
 *
 *   node scripts/ensayoNegocios.js --proxy <url>                # solo los mios
 *   node scripts/ensayoNegocios.js --proxy <url> --owner 83855505
 *   node scripts/ensayoNegocios.js --proxy <url> --todos        # el portal entero
 *   node scripts/ensayoNegocios.js --proxy <url> --deal 60784008538
 *
 * Por que existe (pedido de Matias, 2026-09-02): antes de abrir la canilla de
 * webhooks con `hs project upload` hay que saber que negocio saldria bien y cual
 * no, y sobre todo hay que poder mirarlo **solo sobre los negocios propios**,
 * sin que comercial se entere de que hay una prueba corriendo.
 *
 * Corre `dealToTango.procesarDeal` de verdad —el mismo codigo que va a correr en
 * Azure, no una imitacion— con `dryRun: true`. En ese modo:
 *
 *   - NO se crea el cliente en Tango ni el pedido.
 *   - NO se escribe `tango_pedido_problema`, NO se deja nota, NO se mueve la
 *     etapa. `reportarIncompleto` corta antes de la primera escritura.
 *
 * Lo unico que sale a la red son LECTURAS: HubSpot y las tablas de Tango.
 *
 * ⚠️ Tango solo se deja hablar desde Azure (firewall por IP), asi que hace falta
 * `--proxy` con la URL de la Function App desplegada.
 */

const path = require('node:path');
const fs = require('node:fs');

const dealToTango = require('../src/lib/dealToTango');
const hubspotClient = require('../src/lib/hubspotClient');
const tangoClient = require('../src/lib/tangoClient');
const lookups = require('../src/lib/lookups');
const etapas = require('../src/lib/etapas');
const soloOwner = require('../src/lib/soloOwner');
const { fetchPorProxy } = require('../src/lib/proxyTango');
const logger = require('../src/lib/logger');
const defaults = require('../config/defaults.tango.json');

const args = process.argv.slice(2);
const opcion = (n, def = null) => {
    const i = args.indexOf(n);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const bandera = (n) => args.includes(n);

/**
 * `--proxy` quiere la URL COMPLETA de `testTangoConnection`, no la raiz de la
 * Function App. Pasar la raiz devuelve el HTML de "Your Azure Function App is
 * up and running", que `tangoClient` informa como "la ruta no existe en el
 * ERP" — un mensaje que manda a diagnosticar Tango cuando el error estaba aca.
 * Se completa sola en vez de fallar.
 */
function urlDelProxy(url) {
    if (!url) return url;
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/api/testTangoConnection';
    return u.toString();
}

/** Las variables salen de local.settings.json, igual que el resto de los scripts. */
function entorno() {
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (!fs.existsSync(p)) return process.env;
    return { ...JSON.parse(fs.readFileSync(p, 'utf8')).Values, ...process.env };
}

async function main() {
    const env = entorno();
    const proxy = urlDelProxy(opcion('--proxy', env.TANGO_PROXY_URL));
    const unSoloDeal = opcion('--deal');

    // El filtro por defecto es el de la configuracion: si el entorno dice
    // "solo los mios", el ensayo mira lo mismo que va a mirar el circuito.
    const owner = opcion('--owner', env.DEAL_TO_TANGO_SOLO_OWNER);
    const filtro = bandera('--todos')
        ? soloOwner.leer({})
        : soloOwner.leer({ DEAL_TO_TANGO_SOLO_OWNER: owner || '' });

    if (!env.HUBSPOT_TOKEN) throw new Error('falta HUBSPOT_TOKEN');
    if (!proxy) throw new Error('falta --proxy <url de la Function App>: Tango no se deja hablar desde afuera de Azure');

    const log = logger.crear(console, 'ENSAYO');
    const hs = hubspotClient.crear({ token: env.HUBSPOT_TOKEN, log });
    const tango = tangoClient.crear({
        baseUrl: env.TANGO_API_URL,
        apiKey: env.TANGO_API_KEY,
        company: env.TANGO_COMPANY || '1',
        fetchImpl: fetchPorProxy(proxy),
        log,
    });

    console.log('');
    console.log('  Negocios .......... ' + soloOwner.descripcion(filtro));
    console.log('  Modo .............. DRY-RUN: no se escribe en HubSpot ni en Tango');
    console.log('  Tango ............. via proxy ' + proxy);
    console.log('');

    // Las etapas ganadas salen de los embudos REALES: son dos y tienen etapa
    // ganada distinta, y filtrar por el string 'closedwon' pierde licitaciones.
    const pipelines = await hs.pipelines('deals');
    const ganadas = etapas.desdePipelines(pipelines);

    const ids = unSoloDeal ? [unSoloDeal] : await ganados(hs, ganadas, filtro);
    console.log(`  ${ids.length} negocio(s) a ensayar\n`);
    if (!ids.length) return;

    const tablas = await lookups.cargar(tango, log);
    const owners = soloOwner.necesitaOwners(filtro) ? await hs.owners() : null;

    const cuenta = new Map();
    for (const dealId of ids) {
        const r = await dealToTango.procesarDeal({
            dealId, hs, tango,
            lookups: tablas,
            // El mismo default que usa `leerConfig` en Azure: la decision vive
            // en el catalogo versionado, no en una variable de entorno.
            estrategiaNumeracion: env.TANGO_NUMERACION || defaults.clientes.numeracion.estrategia,
            filtroOwner: filtro,
            owners,
            log,
            dryRun: true, // no se negocia: este script no escribe
        });
        const clave = r.estado === 'dry-run' && (r.problemas || []).length ? 'incompleto' : r.estado;
        cuenta.set(clave, (cuenta.get(clave) || 0) + 1);
        informar(r);
    }

    console.log('\n  ── Resumen ─────────────────────────────');
    for (const [estado, n] of [...cuenta].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(4)}  ${estado}`);
    }
    console.log('');
}

/** Los negocios en etapa ganada que ademas pasan el filtro de owner. */
async function ganados(hs, ganadas, filtro) {
    const etapasGanadas = [...ganadas];
    const filtros = [{ propertyName: 'dealstage', operator: 'IN', values: etapasGanadas }];
    // El filtro se aplica tambien en la BUSQUEDA y no solo dentro del circuito:
    // asi el ensayo ni siquiera lee los negocios de comercial.
    if (filtro.activo && filtro.ids.size) {
        filtros.push({ propertyName: 'hubspot_owner_id', operator: 'IN', values: [...filtro.ids] });
    }

    const salida = [];
    let despues = null;
    do {
        const cuerpo = { filterGroups: [{ filters: filtros }], properties: ['dealname', 'dealstage'], limit: 100 };
        if (despues) cuerpo.after = despues;
        const d = await hs.buscar('deals', cuerpo);
        for (const r of d.results || []) salida.push(String(r.id));
        despues = d.paging?.next?.after || null;
    } while (despues);
    return salida;
}

function informar(r) {
    // OJO: en dry-run un negocio que FRENA vuelve con estado 'dry-run' igual que
    // uno que saldria bien — la diferencia esta en `problemas`. Etiquetar los
    // dos como OK es exactamente el informe tranquilizador que no sirve.
    const frena = (r.problemas || []).length > 0;
    const estado = r.estado === 'dry-run' && frena ? 'incompleto' : r.estado;
    const marca = { 'dry-run': '  OK  ', incompleto: ' FRENA', 'ya-tenia': 'YA-ESTA', ajeno: ' AJENO' }[estado] || `  ${estado}`;
    console.log(`  [${marca}] ${r.dealId}  ${r.motivo || ''}`);
    for (const p of r.problemas || []) console.log(`             · falta ${p.campo}: ${p.motivo}`);
}

main().catch((e) => {
    console.error('\n  ERROR: ' + e.message + '\n');
    process.exit(1);
});
