#!/usr/bin/env node
'use strict';

/**
 * Rederiva los defaults fijos del pedido (talonario, deposito, moneda, lista de
 * precios) leyendo los pedidos que Ultraschall YA tiene cargados en Tango.
 *
 *   node scripts/defaultsDePedido.js            # informe
 *   node scripts/defaultsDePedido.js --desde 2024-01-01
 *
 * Por que existe: esos cuatro valores fueron PROVISORIOS hasta el 2026-08-28
 * (salian de un ejemplo de Postman) y no habia forma de elegirlos, porque los
 * process de GVA43 (talonarios) y STA22 (depositos) nunca se consiguieron.
 *
 * El desbloqueo fue darse cuenta de dos cosas (ARQUITECTURA.md 9.7):
 *
 *   1. El process 19845 (GVA21) no es solo de alta: TAMBIEN SE LEE. Cada pedido
 *      real trae TALONARIO_PEDIDO, COD_STA22, COD_MONEDA y NRO_DE_LIS.
 *   2. Las columnas ID_ son columnas reales de la tabla base aunque la vista no
 *      las devuelva, asi que se resuelve codigo -> ID interno sin el process de
 *      la auxiliar. Es el metodo de 7.7, que este documento daba por inservible
 *      para STA22 y GVA43: lo era DESDE GVA14, que no las referencia. GVA21 si.
 *
 * La consulta parte el filtro en dos, y es lo unico que hay que entender para
 * reusar esto con cualquier otra auxiliar:
 *
 *   - el WHERE de AFUERA corre contra la VISTA  -> ahi viven los COD_*
 *   - la SUBCONSULTA corre contra la TABLA BASE -> ahi viven los ID_*
 *
 * Mezclarlas da 'Invalid column name', que es lo que hace parecer que la
 * columna no existe.
 *
 * Es SOLO LECTURA: ni crea ni modifica nada.
 *
 * ⚠️ Tango solo acepta trafico desde la Function App (ARQUITECTURA.md 5.6), asi
 * que esto hay que correrlo desde Azure. Desde una maquina cualquiera el
 * equivalente es pegarle al proxy desplegado con Api/GetByFilter, que necesita
 * TANGO_PROXY_MODO=relevamiento.
 */

const fs = require('node:fs');
const path = require('node:path');
const tangoClient = require('../src/lib/tangoClient');

const PROCESS_PEDIDOS = 19845;

/** Que resolver: el ID interno de la tabla base y el codigo que muestra la vista. */
const A_RESOLVER = [
    { nombre: 'talonario de pedidos (GVA43)', idBase: 'ID_GVA43_TALON_PED', codVista: 'TALONARIO_PEDIDO', descVista: 'DESCRIPCION_TALONARIO_PEDIDO', texto: false, hasta: 25 },
    { nombre: 'deposito (STA22)', idBase: 'ID_STA22', codVista: 'COD_STA22', descVista: 'NOMBRE_SUC', texto: true, hasta: 60 },
    { nombre: 'moneda', idBase: 'ID_MONEDA', codVista: 'COD_MONEDA', descVista: 'DESC_MONEDA', texto: true, hasta: 12 },
    { nombre: 'lista de precios (GVA10)', idBase: 'ID_GVA10', codVista: 'NRO_DE_LIS', descVista: 'NOMBRE_LIS', texto: false, hasta: 12 },
];

function cargarConfigLocal() {
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
}

function argumento(nombre, porDefecto) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

/** Reparto de una columna de la vista, de mayor a menor. */
function reparto(pedidos, columna) {
    const cuenta = new Map();
    for (const p of pedidos) {
        const k = `${p[columna]}`.trim();
        cuenta.set(k, (cuenta.get(k) || 0) + 1);
    }
    return [...cuenta.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Barre los IDs internos y devuelve, de cada uno que tenga al menos un pedido,
 * el codigo y la descripcion que muestra la vista. Un ID sin pedidos no aparece:
 * el default se elige entre los que el ERP ya acepto, no entre los que existen.
 */
async function tabla(tango, { idBase, codVista, descVista, hasta }) {
    const filas = [];
    const TANDA = 8;
    for (let i = 1; i <= hasta; i += TANDA) {
        const ids = [];
        for (let n = i; n < i + TANDA && n <= hasta; n++) ids.push(n);
        const res = await Promise.all(ids.map(async (id) => {
            const r = await tango.getByFilter(PROCESS_PEDIDOS,
                `ID_GVA21 IN (SELECT TOP 1 ID_GVA21 FROM GVA21 WHERE ${idBase} = ${id})`);
            return [id, r[0]];
        }));
        for (const [id, p] of res) {
            if (p) filas.push({ id, codigo: `${p[codVista]}`.trim(), descripcion: p[descVista] });
        }
    }
    return filas;
}

/**
 * La falsacion de 7.7: si el ID interno significa de verdad ese codigo, NO puede
 * existir ningun pedido con ese ID y otro codigo. Se mide sobre el padron
 * entero, no sobre el primer registro — esa es exactamente la trampa de 5.4.
 */
async function falsar(tango, { idBase, codVista, texto }, id, codigo) {
    const literal = texto ? `'${codigo}'` : codigo;
    const contra = await tango.getByFilter(PROCESS_PEDIDOS,
        `${codVista} <> ${literal} AND ID_GVA21 IN (SELECT ID_GVA21 FROM GVA21 WHERE ${idBase} = ${id})`);
    return contra.length;
}

(async () => {
    const env = { ...cargarConfigLocal(), ...process.env };
    const desde = argumento('desde', '2025-01-01');

    const tango = tangoClient.crear({
        baseUrl: env.TANGO_API_URL,
        apiKey: env.TANGO_API_KEY,
        company: env.TANGO_COMPANY || '1',
        log: { paso: (e, m) => console.log(`  [${e}] ${m}`), aviso: (e, m) => console.log(`  ! [${e}] ${m}`) },
    });

    console.log(`\nLeyendo los pedidos de Tango desde ${desde}...`);
    const pedidos = await tango.getByFilter(PROCESS_PEDIDOS, `FECHA_PEDI >= '${desde}'`);
    console.log(`${pedidos.length} pedidos.\n`);

    if (pedidos.length === 0) {
        console.log('Sin pedidos en ese rango: no hay evidencia de la que sacar un default.');
        process.exit(1);
    }

    for (const campo of A_RESOLVER) {
        console.log(`=== ${campo.nombre} ===`);

        const uso = reparto(pedidos, campo.codVista);
        const [codigoModa, veces] = uso[0];
        const pct = Math.round((veces / pedidos.length) * 100);
        console.log(`  lo que usan los pedidos: ` + uso.map(([k, v]) => `${k}=${v}`).join('  '));

        const filas = await tabla(tango, campo);
        for (const f of filas) {
            const marca = f.codigo === codigoModa ? ' <- moda' : '';
            console.log(`    ID=${String(f.id).padStart(2)}  COD=${String(f.codigo).padStart(3)}  ${f.descripcion}${marca}`);
        }

        const elegida = filas.find((f) => f.codigo === codigoModa);
        if (!elegida) {
            console.log(`  ! el codigo mas usado (${codigoModa}) no resolvio a ningun ID interno en 1..${campo.hasta}. Subir el barrido.\n`);
            continue;
        }

        const contraejemplos = await falsar(tango, campo, elegida.id, elegida.codigo);
        const veredicto = contraejemplos === 0 ? 'OK' : `${contraejemplos} CONTRAEJEMPLOS — NO usar`;
        console.log(`  => ${campo.idBase} = ${elegida.id}  (codigo ${elegida.codigo}, "${elegida.descripcion}", ${pct}% de los pedidos)`);
        console.log(`     falsacion sobre el padron entero: ${veredicto}`);
        if (elegida.codigo !== String(elegida.id)) {
            console.log(`     OJO: el codigo (${elegida.codigo}) NO es el ID (${elegida.id}). Guardar el ID.`);
        }
        console.log('');
    }

    console.log('Los valores vigentes estan en config/defaults.tango.json -> pedidos.defaults,');
    console.log('con la evidencia al lado. Este script NO los reescribe: cambiar un default');
    console.log('del pedido es una decision, no un recalculo.\n');
})().catch((e) => {
    console.error('\nFallo:', e.message);
    process.exit(1);
});
