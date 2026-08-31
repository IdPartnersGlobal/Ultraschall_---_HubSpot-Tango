#!/usr/bin/env node
'use strict';

/**
 * Trae la tabla STA22 (depositos) ENTERA con su process, y completa con ella el
 * catalogo y el desplegable que ve comercial.
 *
 *   node scripts/tablaDepositos.js                     # informe, no escribe
 *   node scripts/tablaDepositos.js --aplicar           # actualiza config/
 *   node scripts/tablaDepositos.js --proxy <url>       # desde afuera de Azure
 *
 * Por que existe: hasta el 2026-08-31 no habia process para STA22 y la tabla se
 * habia reconstruido al reves, desde los pedidos ya cargados (9.7). Ese metodo
 * solo ve los depositos que ALGUN pedido uso: quedaron 16 filas y el resto,
 * invisible. Matias consiguio el process 2941 y con eso sale la tabla completa.
 *
 * Lo primero que hace no es escribir sino CONTRASTAR: las 16 filas derivadas
 * contra las mismas filas leidas de la tabla. Son dos caminos independientes
 * hacia el mismo dato, y si discrepan en un solo par (ID, codigo) el metodo de
 * 9.7 esta mal y hay pedidos que saldrian del deposito equivocado. Por eso el
 * contraste corre siempre, tambien en el informe.
 *
 * Es SOLO LECTURA contra el ERP. Lo unico que escribe son dos archivos de
 * config, y solo con --aplicar.
 */

const fs = require('node:fs');
const path = require('node:path');
const tangoClient = require('../src/lib/tangoClient');
const { fetchPorProxy } = require('../src/lib/proxyTango');

const RAIZ = path.join(__dirname, '..');
const P_PROCESOS = path.join(RAIZ, 'config', 'tango.processes.json');
const P_MAPEO = path.join(RAIZ, 'config', 'mapeo.pedidos.json');

/** Columnas que esperamos. Si la vista las llama de otro modo, el informe lo dice. */
const COL_ID = 'ID_STA22';
const COL_COD = 'COD_STA22';
const COL_DESC = 'NOMBRE_SUC';

/**
 * Un deposito inhabilitado no tiene que aparecer en el desplegable. En STA22 la
 * columna se llama INHABILITA (truncada, como varias de Tango) y viene booleana:
 * 9 de los 36 estan en true. El nombre se busca por prefijo justamente porque
 * Tango corta los nombres de columna a diez caracteres sin avisar.
 */
const RE_BAJA = /^(INHABILIT|DADO_DE_BAJA|BAJA$|INACTIV)/i;

function cargarConfigLocal() {
    const p = path.join(RAIZ, 'local.settings.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
}

function argumento(nombre, porDefecto) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1]
        : porDefecto;
}

const norm = (v) => `${v ?? ''}`.trim();

/** Lee la entidad entera, pagina por pagina. */
async function leerTodo(tango, proc, { pageSize = 200, maxPaginas = 50 } = {}) {
    const filas = [];
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
        const { registros, hayMas, total } = await tango.get(proc, { pageSize, pagina });
        filas.push(...registros);
        console.log(`   pagina ${pagina}: ${registros.length} filas (acumulado ${filas.length}${total ? ` de ${total}` : ''})`);
        if (!hayMas || registros.length === 0) break;
    }
    return filas;
}

/**
 * Contrasta lo que se habia derivado desde los pedidos contra la tabla real.
 * Devuelve las discrepancias; vacio es lo que se espera.
 */
function contrastar(derivadas, deLaTabla) {
    const porId = new Map(deLaTabla.map((f) => [norm(f[COL_ID]), f]));
    const problemas = [];

    for (const d of derivadas) {
        const id = norm(d[COL_ID]);
        const real = porId.get(id);
        if (!real) {
            problemas.push(`ID ${id} (codigo ${d[COL_COD]}, ${d[COL_DESC]}) no existe en la tabla`);
            continue;
        }
        if (norm(real[COL_COD]) !== norm(d[COL_COD])) {
            problemas.push(`ID ${id}: derivado codigo '${d[COL_COD]}', la tabla dice '${real[COL_COD]}'`);
        }
        if (norm(real[COL_DESC]) !== norm(d[COL_DESC])) {
            problemas.push(`ID ${id}: derivado '${d[COL_DESC]}', la tabla dice '${real[COL_DESC]}'`);
        }
    }
    return problemas;
}

(async () => {
    const aplicar = process.argv.includes('--aplicar');
    const cfg = { ...cargarConfigLocal(), ...process.env };
    const urlProxy = argumento('proxy', cfg.TANGO_PROXY_URL);

    const procesos = JSON.parse(fs.readFileSync(P_PROCESOS, 'utf8'));
    const catalogo = procesos.auxiliares.depositos;
    const PROCESS = catalogo.process;
    if (!PROCESS) throw new Error('El catalogo no tiene process para depositos');

    const tango = tangoClient.crear({
        baseUrl: cfg.TANGO_API_URL,
        apiKey: cfg.TANGO_API_KEY || 'la-pone-el-proxy',
        company: cfg.TANGO_COMPANY,
        fetchImpl: urlProxy ? fetchPorProxy(urlProxy) : fetch,
    });

    console.log(`STA22 · process ${PROCESS}  ·  ${urlProxy ? `por el proxy (${new URL(urlProxy).host})` : 'directo contra Tango'}`);
    if (!aplicar) console.log('\n(informe: no escribe nada. Agregar --aplicar para actualizar config/)\n');

    const filas = await leerTodo(tango, PROCESS);
    if (filas.length === 0) throw new Error('La tabla vino vacia: revisar el process');

    const columnas = Object.keys(filas[0]);
    console.log(`\nColumnas de la vista (${columnas.length}): ${columnas.join(', ')}`);

    for (const c of [COL_ID, COL_COD, COL_DESC]) {
        if (!columnas.includes(c)) {
            console.log(`\n⚠️  Falta la columna esperada ${c}. Una fila entera, para ver como se llama:`);
            console.log(JSON.stringify(filas[0], null, 2));
            process.exit(2);
        }
    }

    // ── 1. El contraste. Corre siempre, antes de tocar nada.
    const derivadas = catalogo.filas;
    const problemas = contrastar(derivadas, filas);
    console.log(`\nContraste con las ${derivadas.length} filas derivadas desde los pedidos (9.7):`);
    if (problemas.length === 0) {
        console.log(`   ✅ coinciden las ${derivadas.length}, ID por ID. El metodo de la columna interna queda confirmado por un segundo camino.`);
    } else {
        console.log(`   ❌ ${problemas.length} discrepancia(s). NO aplicar hasta entender esto:`);
        for (const p of problemas) console.log(`      · ${p}`);
        process.exit(3);
    }

    // ── 2. Que hay de nuevo.
    const conocidos = new Set(derivadas.map((f) => norm(f[COL_ID])));
    const nuevas = filas.filter((f) => !conocidos.has(norm(f[COL_ID])));

    const colBaja = columnas.find((c) => RE_BAJA.test(c));
    const estaDeBaja = (f) => !!colBaja && (f[colBaja] === true || /^(1|s|si|true)$/i.test(norm(f[colBaja])));

    console.log(`\nLa tabla tiene ${filas.length} depositos: ${derivadas.length} ya estaban, ${nuevas.length} son nuevos.`);

    if (nuevas.length) {
        console.log('\n   nuevos (ninguno tiene pedidos, por eso no aparecian):');
        for (const f of nuevas) {
            console.log(`      ID ${String(f[COL_ID]).padStart(3)}  cod ${norm(f[COL_COD]).padStart(3)}  ${norm(f[COL_DESC])}${estaDeBaja(f) ? '   [INHABILITADO]' : ''}`);
        }
    }

    if (colBaja) {
        const bajas = filas.filter(estaDeBaja);
        console.log(`\nInhabilitados (columna ${colBaja}): ${bajas.length} de ${filas.length}. Quedan FUERA del desplegable.`);
        for (const f of bajas) {
            const yaEstaba = conocidos.has(norm(f[COL_ID]));
            console.log(`      ID ${String(f[COL_ID]).padStart(3)}  cod ${norm(f[COL_COD]).padStart(3)}  ${norm(f[COL_DESC])}${yaEstaba ? '   ← estaba en el desplegable de las 16' : ''}`);
        }
    } else {
        console.log('\n   La vista no trae ninguna columna de baja: entran todos al desplegable.');
    }

    const divergen = filas.filter((f) => norm(f[COL_COD]).replace(/^0+/, '') !== norm(f[COL_ID])).length;
    console.log(`\nCodigo vs ID interno: divergen ${divergen} de ${filas.length}. Leer el codigo como ID manda el pedido a otro deposito sin que nada falle (5.4).`);

    if (!aplicar) {
        console.log('\n(informe) no se modifico nada. Agregar --aplicar.');
        return;
    }

    // ── 3. Escribir el catalogo, conservando los conteos de pedidos ya medidos.
    const conteos = new Map(derivadas.map((f) => [norm(f[COL_ID]), f]));
    const paraDesplegable = filas.filter((f) => !estaDeBaja(f));

    const filasNuevas = filas
        .map((f) => {
            const previo = conteos.get(norm(f[COL_ID])) || {};
            return {
                [COL_ID]: Number(f[COL_ID]),
                [COL_COD]: norm(f[COL_COD]),
                [COL_DESC]: norm(f[COL_DESC]),
                pedidos2026: previo.pedidos2026 ?? 0,
                pedidos2025: previo.pedidos2025 ?? 0,
                ...(estaDeBaja(f) ? { deBaja: true } : {}),
            };
        })
        .sort((a, b) => a[COL_ID] - b[COL_ID]);

    catalogo.filas = filasNuevas;
    catalogo.registros = filasNuevas.length;
    catalogo.verificado = new Date().toISOString().slice(0, 10);
    catalogo.divergen = `${divergen}/${filas.length}`;
    catalogo.alcance = `La tabla STA22 COMPLETA, leida con el process ${PROCESS} el ${catalogo.verificado}. Los conteos de pedidos son de 2026 y 2025 y valen 0 para los depositos que ningun pedido uso.`;
    catalogo.contraste = `Las ${derivadas.length} filas que se habian derivado desde los pedidos (9.7) coinciden ID por ID con la tabla. Dos caminos independientes, mismo resultado.`;
    fs.writeFileSync(P_PROCESOS, JSON.stringify(procesos, null, 2) + '\n', 'utf8');
    console.log(`\n✔ config/tango.processes.json — ${filasNuevas.length} filas`);

    // ── 4. Escribir el desplegable. El valor es el CODIGO; la etiqueta, el nombre.
    const mapeo = JSON.parse(fs.readFileSync(P_MAPEO, 'utf8'));
    const campo = mapeo.campos.find((c) => c.hubspot === 'tango_deposito');
    if (!campo) throw new Error('No esta el campo tango_deposito en mapeo.pedidos.json');

    const pedidosDe = (f) => {
        const previo = conteos.get(norm(f[COL_ID])) || {};
        return (previo.pedidos2026 ?? 0) + (previo.pedidos2025 ?? 0);
    };
    // Primero los que mas se usan; los que nunca se usaron, por codigo.
    const ordenadas = [...paraDesplegable].sort(
        (a, b) => pedidosDe(b) - pedidosDe(a) || norm(a[COL_COD]).localeCompare(norm(b[COL_COD])),
    );

    campo.opciones = Object.fromEntries(ordenadas.map((f) => [norm(f[COL_COD]), norm(f[COL_COD])]));
    campo.opcionesOrden = ordenadas.map((f) => norm(f[COL_COD]));
    campo.opcionesEtiquetas = Object.fromEntries(ordenadas.map((f) => [norm(f[COL_COD]), norm(f[COL_DESC])]));
    campo.opcionesInversas = { ...campo.opciones };
    campo.opcionesNota = `Codigo COD_STA22 -> valor de la opcion, y valor -> etiqueta que ve comercial. Las ${ordenadas.length} filas salen de la tabla STA22 completa (process ${PROCESS}), leida el ${catalogo.verificado}${colBaja ? ', sin los depositos de baja' : ''}. Ordenadas por cantidad de pedidos reales; las que nunca se usaron van al final. Rederivable con scripts/tablaDepositos.js.`;
    fs.writeFileSync(P_MAPEO, JSON.stringify(mapeo, null, 2) + '\n', 'utf8');
    console.log(`✔ config/mapeo.pedidos.json — desplegable con ${ordenadas.length} opciones`);

    console.log('\nSigue: node scripts/crearPropiedades.js pedidos            (ver el plan)');
    console.log('       node scripts/crearPropiedades.js pedidos --aplicar  (PATCH de opciones, no toca las existentes)');
})().catch((e) => {
    console.error(`\n❌ ${e.message}`);
    if (e.detalle) console.error(JSON.stringify(e.detalle, null, 2));
    process.exit(1);
});
