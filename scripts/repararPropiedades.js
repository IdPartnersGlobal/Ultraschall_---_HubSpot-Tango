#!/usr/bin/env node
'use strict';

/**
 * ⚠️ DESTRUCTIVO. Borra y recrea las propiedades que estan mal definidas.
 *
 *   node scripts/repararPropiedades.js clientes           # dry-run
 *   node scripts/repararPropiedades.js clientes --aplicar # ejecuta
 *
 * En HubSpot `type` y `hasUniqueValue` son inmutables: la unica forma de
 * corregirlos es borrar la propiedad y crearla de nuevo, y al borrarla se
 * pierde el valor que tenga en todos los registros. Por eso este script esta
 * separado de crearPropiedades.js, que nunca borra nada.
 *
 * Orden de operaciones (importa):
 *   1. Lee TODOS los valores de las propiedades afectadas y los guarda en un
 *      archivo antes de tocar nada. Si algo falla despues, el dato esta.
 *   2. Borra y recrea con la definicion del mapeo.
 *   3. Reescribe los valores que habia, pasandolos por el transform del mapeo
 *      (el CUIT vuelve como texto con guiones, no como el numero que era).
 *
 * Los dos casos reales al 2026-08-20, ambos en companies:
 *   - codigo_tango: existe sin hasUniqueValue y es la clave de idempotencia
 *     del batch upsert. Sin unicidad el upsert no puede funcionar. Esta vacia
 *     en las 65 companies, asi que no se pierde nada.
 *   - cuit: creada como `number` y tiene que ser texto, porque no siempre es
 *     un CUIT y porque el formato acordado lleva guiones. 3 valores cargados.
 */

const path = require('node:path');
const fs = require('node:fs');
const hubspot = require('../src/lib/hubspotClient');
const propiedades = require('../src/lib/propiedades');
const mapper = require('../src/lib/mapper');

const ENTIDADES = {
    clientes: { mapeo: 'mapeo.clientes.json', objeto: 'companies' },
    contactos: { mapeo: 'mapeo.contactos.json', objeto: 'contacts' },
    productos: { mapeo: 'mapeo.productos.json', objeto: 'products' },
};

function leerToken() {
    if (process.env.HUBSPOT_TOKEN) return process.env.HUBSPOT_TOKEN;
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
        if (v.HUBSPOT_TOKEN) return v.HUBSPOT_TOKEN;
    }
    throw new Error('Falta HUBSPOT_TOKEN (variable de entorno o local.settings.json)');
}

/** Reescribe el valor guardado como lo espera la propiedad nueva. */
function valorRestaurado(mapeo, nombre, valor) {
    const campo = mapeo.campos.find((c) => c.hubspot === nombre);
    const fn = campo && campo.transform ? mapper.transforms[campo.transform] : null;
    return fn ? fn(valor) : valor;
}

(async () => {
    const entidad = process.argv[2];
    const aplicar = process.argv.includes('--aplicar');
    const def = ENTIDADES[entidad];
    if (!def) {
        console.error(`Uso: node scripts/repararPropiedades.js <${Object.keys(ENTIDADES).join('|')}> [--aplicar]`);
        process.exit(1);
    }

    const mapeo = require(path.join(__dirname, '..', 'config', def.mapeo));
    const hs = hubspot.crear({ token: leerToken() });

    const cuenta = await hs.cuenta();
    console.log(`Portal ${cuenta.portalId} (${cuenta.accountType})  ·  objeto: ${def.objeto}`);

    const plan = propiedades.planificar(mapeo, await hs.propiedades(def.objeto));
    if (!plan.aRehacer.length) {
        console.log('\nNo hay ninguna propiedad para rehacer. Nada que hacer.');
        return;
    }

    console.log(`\nPropiedades a borrar y recrear: ${plan.aRehacer.length}`);
    for (const p of plan.aRehacer) console.log(`   ${p.name.padEnd(26)} ${p.motivo}`);

    // --- 1. backup ANTES de tocar nada
    const nombres = plan.aRehacer.map((p) => p.name);
    console.log(`\nLeyendo valores actuales de ${def.objeto}...`);
    const registros = await hs.leerTodos(def.objeto, nombres);

    const backup = [];
    for (const r of registros) {
        const conDato = {};
        for (const n of nombres) {
            const v = r.properties[n];
            if (v !== null && v !== undefined && String(v) !== '') conDato[n] = v;
        }
        if (Object.keys(conDato).length) backup.push({ id: r.id, properties: conDato });
    }

    console.log(`registros leidos: ${registros.length}  ·  con algun valor cargado: ${backup.length}`);
    for (const b of backup) console.log(`   id=${b.id}  ${JSON.stringify(b.properties)}`);

    const archivo = path.join(
        __dirname, '..',
        `backup-propiedades-${def.objeto}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );
    fs.writeFileSync(archivo, JSON.stringify({ objeto: def.objeto, propiedades: nombres, registros: backup }, null, 2));
    console.log(`\nbackup guardado en: ${archivo}`);

    if (!aplicar) {
        console.log('\n(dry-run) el backup se escribio, pero NO se borro ni recreo nada.');
        console.log('Para ejecutar de verdad, repetir con --aplicar.');
        return;
    }

    // --- 2. borrar y recrear
    console.log('\n*** MODO APLICAR ***\n');
    const recreadas = [];
    for (const p of plan.aRehacer) {
        try {
            await hs.borrarPropiedad(def.objeto, p.name);
            console.log(`   BORRADA   ${p.name}`);
            await hs.crearPropiedad(def.objeto, p.definicion);
            console.log(`   RECREADA  ${p.name}  (${p.definicion.type}/${p.definicion.fieldType}${p.definicion.hasUniqueValue ? ', UNICA' : ''})`);
            recreadas.push(p.name);
        } catch (e) {
            console.log(`   ERROR     ${p.name}: ${e.message}`);
            console.log('   El backup esta a salvo. Revisar antes de reintentar.');
            process.exitCode = 1;
            return;
        }
    }

    // --- 3. restaurar valores
    const aRestaurar = [];
    for (const b of backup) {
        const props = {};
        for (const [n, v] of Object.entries(b.properties)) {
            if (!recreadas.includes(n)) continue;
            const nuevo = valorRestaurado(mapeo, n, v);
            if (nuevo !== null && nuevo !== undefined) props[n] = nuevo;
        }
        if (Object.keys(props).length) aRestaurar.push({ id: b.id, properties: props });
    }

    if (!aRestaurar.length) {
        console.log('\nNo habia valores que restaurar.');
        return;
    }

    console.log(`\nRestaurando ${aRestaurar.length} registros...`);
    let ok = 0;
    for (const r of aRestaurar) {
        try {
            await hs.actualizarObjeto(def.objeto, r.id, r.properties);
            ok++;
            console.log(`   OK    id=${r.id}  ${JSON.stringify(r.properties)}`);
        } catch (e) {
            console.log(`   ERROR id=${r.id}: ${e.message}`);
            process.exitCode = 1;
        }
    }
    console.log(`\nrestaurados: ${ok}/${aRestaurar.length}`);
    console.log(`Si algo quedo mal, los valores originales estan en ${archivo}`);
})().catch((e) => {
    console.error('\nFALLO:', e.message);
    if (e.esFaltaDeScope) console.error('Es un problema de scopes de la app, no del script.');
    process.exit(1);
});
