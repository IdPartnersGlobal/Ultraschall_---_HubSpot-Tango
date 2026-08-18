#!/usr/bin/env node
'use strict';

/**
 * Crea en HubSpot el grupo de propiedades y las propiedades custom que
 * define config/mapeo.*.json.
 *
 * Es idempotente: lee lo que ya existe y solo crea lo que falta.
 *
 *   node scripts/crearPropiedades.js clientes           # dry-run (no escribe)
 *   node scripts/crearPropiedades.js clientes --aplicar # crea de verdad
 *
 * ⚠️ `hasUniqueValue` NO se puede cambiar despues. La propiedad clave
 * (codigo_tango) se crea unica; si se crea mal hay que borrarla y rehacerla.
 */

const path = require('node:path');
const fs = require('node:fs');
const hubspot = require('../src/lib/hubspotClient');

const GRUPO = { name: 'tango_erp', label: 'Datos Tango ERP' };

const ENTIDADES = {
    clientes: { mapeo: 'mapeo.clientes.json', objeto: 'companies' },
    productos: { mapeo: 'mapeo.productos.json', objeto: 'products' },
};

/** Propiedades estandar de HubSpot: no se crean, ya existen. */
const ESTANDAR = new Set([
    'name', 'website', 'phone', 'address', 'city', 'zip', 'state', 'country',
    'description', 'price', 'hs_sku',
]);

function tipoHubSpot(campo) {
    const t = (campo.hsFieldType || '').toLowerCase();
    if (t === 'number' || campo.tipo === 'number') return { type: 'number', fieldType: 'number' };
    if (t === 'date' || campo.tipo === 'datetime' || campo.tipo === 'date') return { type: 'date', fieldType: 'date' };
    if (t === 'select') return { type: 'enumeration', fieldType: 'select' };
    if (t === 'checkbox' || campo.tipo === 'bool' || campo.tipo === 'boolean') return { type: 'bool', fieldType: 'booleancheckbox' };
    return { type: 'string', fieldType: 'text' };
}

function leerToken() {
    if (process.env.HUBSPOT_TOKEN) return process.env.HUBSPOT_TOKEN;
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
        if (v.HUBSPOT_TOKEN) return v.HUBSPOT_TOKEN;
    }
    throw new Error('Falta HUBSPOT_TOKEN (variable de entorno o local.settings.json)');
}

(async () => {
    const entidad = process.argv[2];
    const aplicar = process.argv.includes('--aplicar');
    const def = ENTIDADES[entidad];
    if (!def) {
        console.error(`Uso: node scripts/crearPropiedades.js <${Object.keys(ENTIDADES).join('|')}> [--aplicar]`);
        process.exit(1);
    }

    const mapeo = require(path.join(__dirname, '..', 'config', def.mapeo));
    const hs = hubspot.crear({ token: leerToken() });

    const cuenta = await hs.cuenta();
    console.log(`Portal ${cuenta.portalId} (${cuenta.accountType})  ·  objeto: ${def.objeto}`);
    console.log(aplicar ? '\n*** MODO APLICAR: va a escribir en HubSpot ***\n' : '\n(dry-run: no escribe nada. Agregar --aplicar para ejecutar)\n');

    // --- grupo
    const grupos = await hs.grupos(def.objeto);
    const grupoExiste = grupos.some((g) => g.name === GRUPO.name);
    if (grupoExiste) {
        console.log(`grupo '${GRUPO.name}': ya existe`);
    } else if (aplicar) {
        await hs.crearGrupo(def.objeto, { ...GRUPO, displayOrder: -1 });
        console.log(`grupo '${GRUPO.name}': CREADO`);
    } else {
        console.log(`grupo '${GRUPO.name}': se crearia`);
    }

    // --- propiedades
    const existentes = new Set((await hs.propiedades(def.objeto)).map((p) => p.name));
    const clave = mapeo._meta?.claveIdempotencia?.hubspot;

    const aCrear = [];
    const yaEstan = [];
    for (const campo of mapeo.campos) {
        if (!campo.hubspot || ESTANDAR.has(campo.hubspot)) continue;
        if (existentes.has(campo.hubspot)) { yaEstan.push(campo.hubspot); continue; }
        const { type, fieldType } = tipoHubSpot(campo);
        aCrear.push({
            name: campo.hubspot,
            label: campo.label || campo.hubspot,
            groupName: GRUPO.name,
            type, fieldType,
            description: (campo.notas || '').slice(0, 250) || undefined,
            hasUniqueValue: campo.hubspot === clave ? true : undefined,
            // Una propiedad enumeration sin opciones es invalida: se degrada a texto.
            ...(type === 'enumeration' ? { type: 'string', fieldType: 'text' } : {}),
        });
    }

    console.log(`\npropiedades ya existentes : ${yaEstan.length}`);
    console.log(`propiedades a crear       : ${aCrear.length}\n`);
    for (const p of aCrear) {
        console.log(`   ${p.name.padEnd(26)} ${(p.type + '/' + p.fieldType).padEnd(18)} ${p.hasUniqueValue ? '*** UNICA ***  ' : ''}${p.label}`);
    }

    if (!aplicar) {
        console.log('\n(dry-run) nada fue creado.');
        return;
    }

    console.log('');
    let ok = 0;
    const errores = [];
    for (const p of aCrear) {
        try {
            await hs.crearPropiedad(def.objeto, p);
            ok++;
            console.log(`   CREADA  ${p.name}`);
        } catch (e) {
            errores.push({ name: p.name, error: e.message });
            console.log(`   ERROR   ${p.name}: ${e.message}`);
        }
    }
    console.log(`\ncreadas: ${ok}/${aCrear.length}`);
    if (errores.length) {
        console.log('con error:');
        for (const e of errores) console.log(`   ${e.name}: ${e.error}`);
        process.exitCode = 1;
    }
})().catch((e) => {
    console.error('\nFALLO:', e.message);
    if (e.esFaltaDeScope) console.error('Es un problema de scopes de la app, no del script.');
    process.exit(1);
});
