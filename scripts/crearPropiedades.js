#!/usr/bin/env node
'use strict';

/**
 * Crea en HubSpot el grupo de propiedades y las propiedades custom que
 * define config/mapeo.*.json, y revisa las que ya existen.
 *
 * Es idempotente: lee lo que ya existe y solo toca lo que hace falta.
 *
 *   node scripts/crearPropiedades.js clientes           # dry-run (no escribe)
 *   node scripts/crearPropiedades.js clientes --aplicar # crea/corrige de verdad
 *
 * Lo que hace, en orden:
 *   1. Crea el grupo `tango_erp` si falta.
 *   2. Crea las propiedades que faltan (los desplegables, con sus opciones).
 *   3. Revisa las que ya existen contra el mapeo. Lo que se arregla con un
 *      PATCH (opciones que faltan) lo arregla; lo que exige borrar y recrear
 *      lo REPORTA y no lo toca — para eso esta scripts/repararPropiedades.js,
 *      que hace backup de los valores antes de borrar.
 *
 * La comparacion vive en src/lib/propiedades.js y esta testeada sin red.
 */

const path = require('node:path');
const fs = require('node:fs');
const hubspot = require('../src/lib/hubspotClient');
const propiedades = require('../src/lib/propiedades');

const ENTIDADES = {
    clientes: { mapeo: 'mapeo.clientes.json', objeto: 'companies' },
    // contactos: FUERA DE ALCANCE desde el 2026-08-24 (ARQUITECTURA.md 7.3). No correr.
    contactos: { mapeo: 'mapeo.contactos.json', objeto: 'contacts' },
    productos: { mapeo: 'mapeo.productos.json', objeto: 'products' },
    pedidos: { mapeo: 'mapeo.pedidos.json', objeto: 'deals' },
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

(async () => {
    const entidad = process.argv[2];
    const aplicar = process.argv.includes('--aplicar');
    const quitarSobrantes = process.argv.includes('--quitar-sobrantes');
    const def = ENTIDADES[entidad];
    if (!def) {
        console.error(`Uso: node scripts/crearPropiedades.js <${Object.keys(ENTIDADES).join('|')}> [--aplicar]`);
        process.exit(1);
    }

    const mapeo = require(path.join(__dirname, '..', 'config', def.mapeo));
    const hs = hubspot.crear({ token: leerToken() });
    const GRUPO = propiedades.GRUPO;

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
    const existentes = await hs.propiedades(def.objeto);
    const plan = propiedades.planificar(mapeo, existentes);

    console.log(`\nya existentes : ${plan.yaEstan.length}`);
    console.log(`a crear       : ${plan.aCrear.length}`);
    console.log(`a parchear    : ${plan.aParchear.length}`);
    console.log(`a convertir   : ${plan.aConvertir.length}`);
    console.log(`a rehacer     : ${plan.aRehacer.length}\n`);

    for (const p of plan.aCrear) {
        const ops = p.options ? `  [${p.options.map((o) => o.value).join(' | ')}]` : '';
        console.log(`   CREAR    ${p.name.padEnd(26)} ${(p.type + '/' + p.fieldType).padEnd(18)} ${p.hasUniqueValue ? '*** UNICA ***  ' : ''}${p.label}${ops}`);
    }
    for (const p of plan.sobrantes) console.log(`   SOBRAN    ${p.name.padEnd(25)} ${p.valores.length} opciones que el mapeo ya no declara${quitarSobrantes ? '' : '  (--quitar-sobrantes para revisarlas)'}`);
    for (const p of plan.aParchear) console.log(`   PARCHEAR  ${p.name.padEnd(25)} ${p.detalle}`);
    for (const p of plan.aConvertir) console.log(`   CONVERTIR ${p.name.padEnd(25)} ${p.detalle}, con ${p.cambios.options.length} opciones`);
    for (const p of plan.aRehacer) console.log(`   REHACER   ${p.name.padEnd(25)} ${p.motivo}`);

    if (plan.aRehacer.length) {
        console.log('\n⚠️  REHACER no se arregla con un PATCH: hay que borrar la propiedad y');
        console.log('    recrearla, y eso borra el valor que tenga en todos los registros.');
        console.log(`    Correr:  node scripts/repararPropiedades.js ${entidad}`);
    }

    if (!aplicar) {
        console.log('\n(dry-run) nada fue modificado.');
        return;
    }

    console.log('');
    let ok = 0;
    const errores = [];

    for (const p of plan.aCrear) {
        try {
            await hs.crearPropiedad(def.objeto, p);
            ok++;
            console.log(`   CREADA    ${p.name}`);
        } catch (e) {
            errores.push({ name: p.name, error: e.message });
            console.log(`   ERROR     ${p.name}: ${e.message}`);
        }
    }
    // Parchear y convertir son los dos un PATCH a la misma ruta: la diferencia
    // esta en que manda cada uno, no en como se aplica.
    for (const p of [...plan.aParchear, ...plan.aConvertir]) {
        try {
            await hs.actualizarPropiedad(def.objeto, p.name, p.cambios);
            ok++;
            console.log(`   ACTUALIZADA ${p.name}`);
        } catch (e) {
            errores.push({ name: p.name, error: e.message });
            console.log(`   ERROR       ${p.name}: ${e.message}`);
        }
    }

    // --- opciones sobrantes
    //
    // Quitar una opcion NO es borrar una propiedad, pero puede vaciar el campo
    // en los registros que la tengan. Por eso se cuenta primero: se sacan solo
    // las que NADIE uso, y las usadas se informan con el numero para que la
    // decision la tome una persona. Sin este conteo, una lista que cambio de
    // valores queda con las viejas y las nuevas conviviendo para siempre —
    // `aParchear` nunca saca nada, a proposito.
    if (quitarSobrantes && plan.sobrantes.length) {
        const props = plan.sobrantes.map((s) => s.name);
        console.log(`\ncontando uso real de las opciones sobrantes en ${def.objeto} ...`);
        const registros = await hs.leerTodos(def.objeto, props);
        console.log(`   ${registros.length} registros leidos`);

        for (const s of plan.sobrantes) {
            const uso = new Map();
            for (const r of registros) {
                const bruto = (r.properties?.[s.name] ?? '').trim();
                if (!bruto) continue;
                // El multivalor llega separado por ';'.
                for (const v of bruto.split(';').map((x) => x.trim()).filter(Boolean)) uso.set(v, (uso.get(v) || 0) + 1);
            }
            const usadas = s.valores.filter((v) => uso.get(v));
            if (usadas.length) {
                console.log(`   ${s.name}: NO se toca. ${usadas.length} opciones estan en uso: ${usadas.map((v) => `'${v}' (${uso.get(v)})`).join(', ')}`);
                continue;
            }
            try {
                await hs.actualizarPropiedad(def.objeto, s.name, s.cambios);
                ok++;
                console.log(`   ${s.name}: quitadas ${s.valores.length} opciones sin uso -> quedan ${s.cambios.options.length}`);
            } catch (e) {
                errores.push({ name: s.name, error: e.message });
                console.log(`   ERROR       ${s.name}: ${e.message}`);
            }
        }
    }

    // El total tiene que incluir las sobrantes cuando se piden: sin eso la
    // corrida que SOLO quita opciones termina diciendo "aplicados: 1/0", que
    // se lee como un error y es exactamente lo contrario.
    const total = plan.aCrear.length + plan.aParchear.length + plan.aConvertir.length
        + (quitarSobrantes ? plan.sobrantes.length : 0);
    console.log(`
aplicados: ${ok}/${total}`);
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
