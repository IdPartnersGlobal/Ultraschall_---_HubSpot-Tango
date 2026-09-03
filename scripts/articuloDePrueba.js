'use strict';

/**
 * Candidatos para el ARTICULO DE PRUEBA del pedido (§9.6).
 *
 * Por que existe: el 2026-09-03 BAT250 se quedo sin stock. Con `VALIDA_STOCK`
 * en true el ERP rechaza el pedido, y el error parece del circuito — era el
 * riesgo anotado en `productoDePrueba.ojo` desde el 2026-08-27.
 *
 * Elegir "otro que tenga stock" repite el problema el mes que viene. Lo que
 * este script busca es un articulo que **no se pueda quedar sin stock**:
 *
 *   - `STOCK = false`               -> el articulo NO lleva stock (un servicio).
 *                                      La validacion no tiene nada que validar.
 *   - `DESCARGA_NEGATIVO_STOCK`     -> lleva stock pero deja descargar en
 *                                      negativo: tampoco frena el pedido.
 *
 * El precio del articulo no importa: el renglon viaja con el precio de la linea
 * de HubSpot, no con el de la lista (§9.12).
 *
 * SOLO LECTURA. No escribe en Tango ni en HubSpot ni toca la config.
 *
 *   node scripts/articuloDePrueba.js --proxy <url de la Function App>
 *
 * ⚠️ Tango solo acepta la IP de Azure: sin `--proxy` no hay forma de correrlo
 * desde una maquina de escritorio (§5.6).
 */

const fs = require('fs');
const path = require('path');
const tangoClient = require('../src/lib/tangoClient');
const { fetchPorProxy } = require('../src/lib/proxyTango');
const procesos = require('../config/tango.processes.json');
const defaults = require('../config/defaults.tango.json');

const PRUEBA = defaults.pedidos.productoDePrueba;

/** Los perfiles que se pueden vender. `C` (compras) y `N` no van en un pedido. */
const PERFILES_VENTA = new Set(['A', 'V']);

function entorno() {
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (!fs.existsSync(p)) return process.env;
    return { ...JSON.parse(fs.readFileSync(p, 'utf8')).Values, ...process.env };
}

/** La raiz de la Function App alcanza: el path se completa solo. */
function urlDelProxy(url) {
    if (!url) return url;
    const u = new URL(url);
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/api/testTangoConnection';
    return u.toString();
}

const bool = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

/** Un articulo que no puede frenar un pedido por stock, y por que. */
function porQueNoFrena(a) {
    if (!bool(a.STOCK)) return 'no lleva stock';
    if (bool(a.DESCARGA_NEGATIVO_STOCK)) return 'descarga en negativo';
    return null;
}

async function main() {
    const args = process.argv.slice(2);
    const proxy = urlDelProxy(args[args.indexOf('--proxy') + 1]);
    if (!args.includes('--proxy') || !proxy) {
        console.error('  ERROR: falta --proxy <url de la Function App>: Tango no se deja hablar desde afuera de Azure');
        process.exit(1);
    }

    const env = entorno();
    const tango = tangoClient.crear({
        baseUrl: env.TANGO_API_URL,
        apiKey: env.TANGO_API_KEY,
        company: env.TANGO_COMPANY || '1',
        fetchImpl: fetchPorProxy(proxy),
    });

    const proc = procesos.entidades.articulos.process;
    console.log(`Leyendo STA11 (process ${proc}) por el proxy...\n`);

    const todos = [];
    let pagina = 1;
    for (;;) {
        const { registros, hayMas } = await tango.get(proc, { pagina });
        todos.push(...registros);
        if (!hayMas || !registros.length) break;
        pagina += 1;
    }
    console.log(`  ${todos.length} articulos\n`);

    // El que estamos usando, para tener con que comparar.
    const actual = todos.find((a) => String(a.COD_STA11).trim() === PRUEBA.codigo);
    if (actual) {
        console.log(`ACTUAL — ${PRUEBA.codigo} (ID_STA11=${PRUEBA.idSta11})`);
        console.log(`  STOCK=${actual.STOCK}  DESCARGA_NEGATIVO_STOCK=${actual.DESCARGA_NEGATIVO_STOCK}  PERFIL=${actual.PERFIL}`);
        console.log(`  ${porQueNoFrena(actual) ? 'no frena: ' + porQueNoFrena(actual) : '⚠️  puede frenar el pedido si no tiene stock'}\n`);
    } else {
        console.log(`⚠️  ${PRUEBA.codigo} no aparece en STA11\n`);
    }

    const candidatos = todos
        .filter((a) => PERFILES_VENTA.has(String(a.PERFIL || '').trim().toUpperCase()))
        .map((a) => ({ a, motivo: porQueNoFrena(a) }))
        .filter((c) => c.motivo);

    console.log(`CANDIDATOS: ${candidatos.length} de ${todos.length} no pueden frenar un pedido por stock\n`);
    console.log('  ID_STA11  COD_STA11             PERFIL  motivo                 descripcion');
    for (const { a, motivo } of candidatos.slice(0, 40)) {
        console.log(
            '  ' + String(a.ID_STA11).padEnd(9) +
            String(a.COD_STA11).trim().padEnd(22) +
            String(a.PERFIL).padEnd(8) +
            motivo.padEnd(23) +
            String(a.DESCRIPCIO || '').trim().slice(0, 40)
        );
    }
    if (candidatos.length > 40) console.log(`  ... y ${candidatos.length - 40} mas`);

    console.log('\nPara usar uno sin desplegar: TANGO_PRODUCTO_PRUEBA=<ID_STA11> en las Application Settings.');
    console.log('Para dejarlo fijo: config/defaults.tango.json -> pedidos.productoDePrueba (codigo + idSta11).');
}

main().catch((e) => {
    console.error('\nERROR:', e.message);
    process.exit(1);
});
