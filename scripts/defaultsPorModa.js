#!/usr/bin/env node
'use strict';

/**
 * Recalcula los `codigoPorDefecto` del alta de clientes con la MODA del padron
 * real: el valor que mas se repite entre los 5.670 clientes que ya existen.
 *
 *   node scripts/defaultsPorModa.js              # dry-run: compara y muestra
 *   node scripts/defaultsPorModa.js --aplicar    # reescribe defaults.tango.json
 *
 * Por que hace falta: los valores que hay hoy en config salieron de
 * test/fixtures/clientes-muestra.json, que NO es representativo — son 300
 * clientes de codigo 000003 a 002311, la parte mas vieja del padron, y no hay
 * ninguno por encima de 3000. Se nota en el vendedor: ahi FACUNDO sale 42 de
 * 300 (14%) cuando en el padron entero tiene el 63%.
 *
 * ⚠️ Tango solo acepta trafico desde la Function App (ARQUITECTURA.md 5.6), asi
 * que esto hay que correrlo desde Azure o desde un entorno con salida
 * permitida. Es solo lectura: un Api/Get del padron completo (~107 s).
 *
 * Sobre la moda de un campo que esta mayormente vacio: se calcula sobre los que
 * TIENEN valor. En lista de precios y transporte el valor mas repetido es
 * "nada" (176 de 300 en la muestra), y un default vacio no sirve de default.
 * El informe muestra cuantos vacios hay para que la decision se vea.
 */

const fs = require('node:fs');
const path = require('node:path');
const tangoClient = require('../src/lib/tangoClient');

const RUTA_CONFIG = path.join(__dirname, '..', 'config', 'defaults.tango.json');

/** Campo de Tango -> columna del padron de la que sale su codigo. */
const COLUMNAS = {
    ID_GVA01: 'GVA01_COND_VTA',
    ID_GVA10: 'GVA10_NRO_DE_LIS',
    ID_GVA23: 'GVA23_CODIGO',
    ID_GVA24: 'GVA24_CODIGO',
    ID_GVA05: 'GVA05_CODIGO',
};

function cargarConfigLocal() {
    if (!fs.existsSync(path.join(__dirname, '..', 'local.settings.json'))) return {};
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local.settings.json'), 'utf8')).Values || {};
}

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

/** Moda de una columna, ignorando los vacios. Devuelve tambien el reparto. */
function moda(registros, columna) {
    const cuenta = new Map();
    let vacios = 0;
    for (const r of registros) {
        const v = r[columna];
        if (vacio(v)) { vacios++; continue; }
        const k = String(v).trim();
        cuenta.set(k, (cuenta.get(k) || 0) + 1);
    }
    const orden = [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
    return { codigo: orden[0]?.[0] ?? null, veces: orden[0]?.[1] ?? 0, conValor: registros.length - vacios, vacios, top: orden.slice(0, 5) };
}

(async () => {
    const env = { ...cargarConfigLocal(), ...process.env };
    const aplicar = process.argv.includes('--aplicar');

    const tango = tangoClient.crear({
        baseUrl: env.TANGO_API_URL,
        apiKey: env.TANGO_API_KEY,
        company: env.TANGO_COMPANY || '1',
        log: { paso: (e, m) => console.log(`  [${e}] ${m}`), aviso: (e, m) => console.log(`  ! [${e}] ${m}`) },
    });

    const config = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8'));
    const campos = config.clientes.alta.campos;

    console.log('\nLeyendo el padron completo de Tango (puede tardar ~2 min)...');
    const { registros } = await tango.get(config.clientes.process);
    console.log(`Padron leido: ${registros.length} clientes\n`);

    let cambios = 0;
    for (const [tangoCampo, columna] of Object.entries(COLUMNAS)) {
        const campo = campos.find((c) => c.tango === tangoCampo);
        if (!campo || !campo.codigoPorDefecto) continue;

        const m = moda(registros, columna);
        const igual = String(campo.codigoPorDefecto) === String(m.codigo);
        const pct = m.conValor ? Math.round((m.veces / m.conValor) * 100) : 0;

        console.log(`${tangoCampo} (${columna})`);
        console.log(`   en config : ${campo.codigoPorDefecto}  ${campo.descripcion || ''}`);
        console.log(`   moda real : ${m.codigo}  (${m.veces} de ${m.conValor} con valor, ${pct}%${m.vacios ? `; ${m.vacios} vacios` : ''})`);
        console.log(`   reparto   : ${m.top.map(([k, n]) => `${k}=${n}`).join('  ')}`);
        console.log(`   -> ${igual ? 'coincide' : 'CAMBIA'}\n`);

        if (!igual && m.codigo !== null) {
            campo.codigoPorDefecto = m.codigo;
            campo.descripcion = undefined; // la vieja ya no describe al nuevo codigo
            campo.evidencia = `moda del padron completo: ${m.veces} de ${m.conValor} con valor (${pct}%). Recalculado ${new Date().toISOString().slice(0, 10)} por scripts/defaultsPorModa.js.`;
            cambios++;
        }
    }

    if (!cambios) { console.log('Nada que cambiar: los defaults ya son la moda del padron.\n'); return; }

    if (!aplicar) {
        console.log(`${cambios} default(s) cambiarian. Volve a correr con --aplicar para escribir config/defaults.tango.json.\n`);
        return;
    }

    config.clientes.alta._modas._calculadoSobre = `padron completo (${registros.length} clientes), ${new Date().toISOString().slice(0, 10)}`;
    fs.writeFileSync(RUTA_CONFIG, JSON.stringify(config, null, 2) + '\n');
    console.log(`config/defaults.tango.json actualizado (${cambios} cambios).`);
    console.log('OJO: el archivo quedo reformateado por JSON.stringify. Revisar el diff antes de commitear.\n');
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
