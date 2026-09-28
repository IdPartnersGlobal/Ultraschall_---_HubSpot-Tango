'use strict';

/**
 * Pasada UNICA: completa los datos de Tango de los productos que ya estan en
 * HubSpot, cruzando el SKU con el codigo de articulo (2026-09-22). No es el
 * sync: no crea productos ni toca nombre, descripcion o precio. La logica y el
 * por que, en src/lib/completarProductos.js.
 *
 *   node scripts/completarProductos.js             # simula: no escribe, deja un CSV
 *   node scripts/completarProductos.js --aplicar   # escribe en HubSpot y relee
 *   node scripts/completarProductos.js --verificar # solo lee: compara HubSpot contra Tango
 *
 * Tango se lee por el proxy de Azure (Tango solo acepta la IP de Azure), con
 * la URL de --proxy, de TANGO_PROXY_URL o la de siempre, y TANGO_PROXY_KEY de
 * local.settings.json. La empresa de Tango la pone Azure (hoy la 3, productivo).
 *
 * El CSV queda al lado del repo, en la carpeta de Ultraschall (--salida lo pisa).
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const APLICAR = args.includes('--aplicar');
const VERIFICAR = args.includes('--verificar');

const REPO = path.join(__dirname, '..');
const SALIDA = opcion('--salida') || path.join(REPO, '..');
const URL_PROXY_DEFECTO = 'https://ultraschall-tango-hubspot-cjcpbug0g4fxgehg.canadacentral-01.azurewebsites.net/api/testTangoConnection';
const PORTAL = '51311915';

const tangoClient = require('../src/lib/tangoClient');
const hubspotClient = require('../src/lib/hubspotClient');
const lookups = require('../src/lib/lookups');
const mapper = require('../src/lib/mapper');
const completar = require('../src/lib/completarProductos');
const { fetchPorProxy } = require('../src/lib/proxyTango');
const procesos = require('../config/tango.processes.json');
const mapeoProductos = require('../config/mapeo.productos.json');

const V = JSON.parse(fs.readFileSync(path.join(REPO, 'local.settings.json'), 'utf8')).Values;

const log = {
    inicio: (m) => console.log('\n' + '='.repeat(70) + '\n' + m + '\n' + '='.repeat(70)),
    paso: (e, m) => console.log('  [' + e + '] ' + m),
    datos: (e, o) => {
        console.log('\n[' + e + ']');
        const w = Math.max(...Object.keys(o).map((k) => k.length));
        for (const [k, val] of Object.entries(o)) console.log('   ' + k.padEnd(w) + ' : ' + val);
    },
    aviso: (e, m) => console.log('  ! [' + e + '] ' + m),
    error: (e, m) => console.error('  X [' + e + '] ' + m),
    fin: (m) => console.log('\n' + m + '\n'),
};

const ETIQUETAS = new Map(mapeoProductos.campos.map((c) => [c.hubspot, c.label || c.hubspot]));
/**
 * ¿Lo que quedo en HubSpot es lo que se escribio? Las fechas se mandan en ms
 * (medianoche UTC) y HubSpot las devuelve 'YYYY-MM-DD'; los numeros y los
 * booleanos vuelven como texto. Sin esto, la relectura del 2026-09-22 marco
 * como distintas las 109 fechas de alta, que eran iguales.
 */
function mismoValor(escrito, leido) {
    if (String(leido ?? '') === String(escrito)) return true;
    if (typeof escrito === 'number' && /^\d{4}-\d{2}-\d{2}$/.test(String(leido))) return new Date(escrito).toISOString().slice(0, 10) === leido;
    if (typeof escrito === 'number') return Number(leido) === escrito;
    return false;
}

const celda = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
const fila = (xs) => xs.map(celda).join(';');

(async () => {
    const t0 = Date.now();
    log.inicio(APLICAR
        ? 'COMPLETAR productos con los datos de Tango  *** ESCRIBE EN HUBSPOT ***'
        : 'COMPLETAR productos con los datos de Tango  (simulacion: no escribe nada)');

    const tango = tangoClient.crear({
        baseUrl: V.TANGO_API_URL,
        apiKey: V.TANGO_API_KEY,
        log,
        fetchImpl: fetchPorProxy(opcion('--proxy') || V.TANGO_PROXY_URL || URL_PROXY_DEFECTO, { clave: V.TANGO_PROXY_KEY }),
    });
    const hs = hubspotClient.crear({ token: V.HUBSPOT_TOKEN, log });

    log.paso('LOOKUPS', 'cargando tablas auxiliares...');
    const lk = await lookups.cargar(tango, log);
    const m = mapper.crear(mapeoProductos, lk);

    log.paso('TANGO', `leyendo articulos (process=${procesos.entidades.articulos.process})...`);
    const { registros } = await tango.get(procesos.entidades.articulos.process);

    log.paso('HUBSPOT', 'leyendo products...');
    const leer = [...new Set(['name', completar.CLAVE_HS, 'id_proveedor', ...completar.CAMPOS])];
    const productos = await hs.leerTodos('products', leer);

    if (VERIFICAR) {
        // Lo que Tango diria para cada campo, como si estuviera vacio, contra lo
        // que hay hoy en HubSpot. No escribe nada.
        const enBlanco = productos.map((p) => ({ id: p.id, properties: { ...p.properties, ...Object.fromEntries(completar.CAMPOS.map((c) => [c, ''])) } }));
        const esperado = completar.planificar({ registros, productos: enBlanco, m });
        const actual = new Map(productos.map((p) => [String(p.id), p.properties || {}]));
        let iguales = 0;
        const distintos = [];
        for (const u of esperado.updates) {
            for (const [campo, valor] of Object.entries(u.properties)) {
                if (mismoValor(valor, actual.get(u.id)?.[campo])) iguales++;
                else distintos.push(`${u.id} ${campo}: Tango dice '${valor}', HubSpot tiene '${actual.get(u.id)?.[campo] ?? ''}'`);
            }
        }
        log.datos('VERIFICACION', { 'productos con codigo de Tango': esperado.updates.length, 'valores iguales a Tango': `${iguales} de ${iguales + distintos.length}` });
        for (const d of distintos.slice(0, 30)) log.aviso('DISTINTO', d);
        log.fin('verificacion completa: no se escribio nada.');
        return;
    }

    const plan = completar.planificar({ registros, productos, m });

    // ── CSV ───────────────────────────────────────────────────────────────
    const hoy = new Date().toISOString().slice(0, 10);
    const cabecera = fila([
        'ID producto HubSpot', 'Link', 'Nombre en HubSpot', 'SKU', 'P/N', 'Resultado', 'SKU repetido en HubSpot',
        'Descripcion en Tango', 'Palabras en comun (para revisar a ojo)', 'Codigos parecidos en Tango',
        ...completar.CAMPOS.map((c) => 'Se completa: ' + ETIQUETAS.get(c)),
    ]);
    const porId = new Map(productos.map((p) => [String(p.id), p]));
    const lineas = plan.filas.map((f) => {
        const enComun = f.articulo ? completar.palabrasEnComun(f.nombre, f.articulo) : [];
        return fila([
            f.id, `https://app.hubspot.com/contacts/${PORTAL}/record/0-7/${f.id}`, f.nombre, f.sku,
            porId.get(f.id)?.properties?.id_proveedor || '', f.resultado, f.repetido ? 'si' : '',
            f.articulo ? String(f.articulo.DESCRIPCIO ?? '').trim() : '',
            f.articulo ? (enComun.length ? enComun.join(' ') : 'NINGUNA') : '',
            f.parecidos.join(', '),
            ...completar.CAMPOS.map((c) => (f.completa[c] === undefined ? '' : f.completa[c])),
        ]);
    });
    const archivo = path.join(SALIDA, `Productos - completar datos de Tango - ${hoy}${APLICAR ? ' - aplicado' : ''}.csv`);
    fs.writeFileSync(archivo, '﻿' + [cabecera, ...lineas].join('\r\n') + '\r\n', 'utf8');

    log.datos('RESUMEN', {
        'articulos leidos de Tango': plan.resumen.articulosTango,
        'products en HubSpot': plan.resumen.productos,
        ...Object.fromEntries(Object.entries(plan.resumen.porResultado).map(([k, v]) => ['  ' + k, v])),
        'productos a escribir': plan.updates.length,
        'campos que se completan': plan.resumen.camposCompletados,
        'campos respetados (ya tenian valor)': plan.resumen.respetados,
        'sin palabras en comun (revisar)': plan.filas.filter((f) => f.articulo && !completar.palabrasEnComun(f.nombre, f.articulo).length).length,
        'problemas de mapeo': plan.resumen.problemas.length,
        'CSV': archivo,
    });
    for (const p of plan.resumen.problemas.slice(0, 20)) log.aviso('MAPEO', p);

    if (!APLICAR) {
        log.fin(`simulacion completa en ${((Date.now() - t0) / 1000).toFixed(0)} s: no se escribio nada. Para escribir: --aplicar`);
        return;
    }

    // ── escribir y releer ─────────────────────────────────────────────────
    log.paso('HUBSPOT', `escribiendo ${plan.updates.length} products por ID...`);
    const r = await hs.batchUpdate('products', plan.updates);
    for (const f of r.fallidos.slice(0, 20)) log.error('ESCRITURA', JSON.stringify(f));

    // No se da por escrito lo que dice la respuesta: se relee y se compara.
    const releidos = new Map((await hs.leerTodos('products', leer)).map((p) => [String(p.id), p.properties || {}]));
    let iguales = 0;
    const distintos = [];
    for (const u of plan.updates) {
        for (const [campo, valor] of Object.entries(u.properties)) {
            const hay = releidos.get(u.id)?.[campo];
            if (mismoValor(valor, hay)) iguales++; else distintos.push(`${u.id} ${campo}: se escribio '${valor}', quedo '${hay}'`);
        }
    }
    log.datos('ESCRITO', {
        'products escritos': r.procesados,
        'fallidos': r.fallidos.length,
        'valores releidos iguales': `${iguales} de ${plan.resumen.camposCompletados}`,
    });
    for (const d of distintos.slice(0, 30)) log.aviso('RELECTURA', d);
    log.fin(`listo en ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
})().catch((e) => {
    console.error('\nFALLO:', e.message);
    process.exit(1);
});
