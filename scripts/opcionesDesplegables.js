#!/usr/bin/env node
'use strict';

/**
 * Genera las `opciones` de los desplegables de config/mapeo.*.json a partir de
 * las tablas del ERP.
 *
 *   node scripts/opcionesDesplegables.js                 # informe, no escribe
 *   node scripts/opcionesDesplegables.js --aplicar       # escribe los mapeos
 *   node scripts/opcionesDesplegables.js --proxy <url>   # relee el ERP primero
 *
 * POR QUE EXISTE
 *
 * Once campos del mapeo pedian `hsFieldType: "select"` y ninguno declaraba
 * `opciones`. `tipoHubSpot()` degrada a texto libre cuando faltan, asi que
 * quedaron de texto en el portal sin que nada fallara — y `planificar` los
 * comparaba contra la spec ya degradada, o sea que informaba `0 a rehacer`.
 * Se descubrio el 2026-09-01, mirando la ficha de una empresa.
 *
 * Un campo que en Tango sale de una tabla no puede ser texto libre en HubSpot:
 * comercial escribe cualquier cosa y despues no cruza contra nada.
 *
 * QUE ENTRA EN CADA LISTA (decision de Matias, 2026-09-01)
 *
 * La tabla COMPLETA de Tango, no los valores en uso. Los que estan dados de
 * baja entran igual, con `hidden: true`: no se ofrecen en el desplegable pero
 * se siguen pudiendo escribir por API (verificado contra el portal). Esa es la
 * diferencia con tango_deposito, donde el de baja se saca y listo:
 *
 *   - tango_deposito lo ELIGE comercial. Nadie tiene ese valor guardado, asi
 *     que sacar una fila no rompe nada.
 *   - estos once los ESCRIBE el sync. Si un cliente tiene asignado un vendedor
 *     inhabilitado y ese valor no esta entre las opciones, HubSpot contesta
 *     400 INVALID_OPTION y voltea la tanda de 100 entera, no el registro.
 *
 * Falsacion hecha el 2026-09-01 sobre el padron entero (5670 clientes, no la
 * muestra): CERO valores fuera de las tablas en los seis campos de cliente.
 * `--proxy` la vuelve a correr.
 */

const path = require('node:path');
const fs = require('node:fs');
const tangoClient = require('../src/lib/tangoClient');
const { fetchPorProxy } = require('../src/lib/proxyTango');

const RAIZ = path.join(__dirname, '..');
const P_PROCESOS = path.join(RAIZ, 'config', 'tango.processes.json');
const DIR_FIXTURES = path.join(RAIZ, 'test', 'fixtures');
const F_DOMINIOS = path.join(DIR_FIXTURES, 'articulos-dominios.json');

/**
 * De donde sale cada desplegable.
 *
 *   valor  : la columna que el sync LEE de Tango y ESCRIBE en HubSpot. Es a la
 *            vez la CLAVE y el VALOR del mapa `opciones`.
 *
 *            Que sea un mapa identidad no es redundancia. `opciones` en el
 *            mapeo es la tabla que consulta lib/mapper con el dato crudo de
 *            Tango: si la clave no esta, omite el campo y lo reporta en vez de
 *            escribir algo que HubSpot va a rechazar (mapper.js:319). En
 *            condicion_iva la clave es distinta del valor porque Tango manda
 *            'RI' y el portal guarda 'Responsable Inscripto'; aca el mapeo
 *            apunta a la columna que ya trae lo que se quiere guardar, asi que
 *            clave y valor coinciden y el mapa funciona como lista blanca.
 *
 *            OJO: la clave NO puede ser el ID de la tabla. Poner ID_GVA05 dejo
 *            'NEA' sin opcion y el mapper empezo a omitir la zona de todos los
 *            clientes — tres tests en rojo, 2026-09-01.
 *
 *   entrada: true en los desplegables que comercial ELIGE y que tienen que
 *            volver al ERP. Guardan el CODIGO de Tango y muestran la
 *            descripcion (§9.14), porque `lookups.resolver` traduce codigo ->
 *            ID interno y con la descripcion no hay vuelta posible. Los que no
 *            lo declaran son espejo de Tango: guardan la descripcion.
 *   codigo / etiqueta / columnaCliente: solo en los de entrada. La columna del
 *            codigo en la tabla auxiliar, la de la descripcion legible, y la
 *            columna de la vista de CLIENTES de la que el mapeo pasa a leer.
 *   clave  : columna del ID interno. NO va al mapeo: los IDs viven en los
 *            campos tango_id_gvaNN via `lookup`. Se usa solo en el informe.
 *   baja   : columna booleana de inhabilitado, si la tabla tiene. OJO: Tango
 *            corta los nombres de columna a diez caracteres, por eso es
 *            INHABILITA y no INHABILITADO (§9.11).
 */
const DESPLEGABLES = [
    // --- companies
    {
        mapeo: 'clientes', campo: 'tango_categoria_iva',
        fuente: { tipo: 'catalogo', clave: 'categoriasIva' },
        valor: 'DESC_CATEGORIA_IVA', clave: 'COD_CATEGORIA_IVA',
    },
    {
        mapeo: 'clientes', campo: 'tango_condicion_venta', entrada: true,
        fuente: { tipo: 'fixture', archivo: 'condicionesVenta' },
        codigo: 'COND_VTA', etiqueta: 'DESC_COND', clave: 'ID_GVA01', columnaCliente: 'GVA01_COND_VTA',
    },
    {
        mapeo: 'clientes', campo: 'tango_lista_precios', entrada: true,
        fuente: { tipo: 'catalogo', clave: 'listasPrecios' },
        codigo: 'NRO_DE_LIS', etiqueta: 'NOMBRE_LIS', clave: 'ID_GVA10', columnaCliente: 'GVA10_NRO_DE_LIS',
    },
    {
        mapeo: 'clientes', campo: 'tango_zona', entrada: true,
        fuente: { tipo: 'fixture', archivo: 'zonas' },
        codigo: 'COD_GVA05', etiqueta: 'NOMBRE_ZON', clave: 'ID_GVA05', columnaCliente: 'GVA05_CODIGO',
    },
    {
        mapeo: 'clientes', campo: 'tango_vendedor',
        fuente: { tipo: 'fixture', archivo: 'vendedores' },
        valor: 'NOMBRE_VEN', clave: 'ID_GVA23', baja: 'INHABILITA',
    },
    {
        mapeo: 'clientes', campo: 'tango_transporte', entrada: true,
        fuente: { tipo: 'fixture', archivo: 'transportes' },
        codigo: 'COD_GVA24', etiqueta: 'NOMBRE_TRA', clave: 'ID_GVA24', columnaCliente: 'GVA24_CODIGO',
    },
    // --- products
    {
        mapeo: 'productos', campo: 'tango_alicuota_iva',
        fuente: { tipo: 'fixture', archivo: 'alicuotasIva' },
        valor: 'DESCRIPCIO', clave: 'ID_GVA41',
        nota: 'GVA41 mezcla alicuotas de IVA con impuestos internos y percepciones. La lista muestra las 9 filas de la tabla; en los 826 articulos solo se usan tres (IVA 10,5%, IVA 21%, IVA 0%).',
    },
    {
        mapeo: 'productos', campo: 'tango_perfil',
        fuente: { tipo: 'estatico' },
        // Convencion de Tango Gestion, confirmada por Matias el 2026-09-01.
        // Cierra con lo medido: el sync publica A y V, o sea los vendibles.
        opciones: { A: 'A', V: 'V', N: 'N', C: 'C' },
        etiquetas: { A: 'Ambos', V: 'Ventas', N: 'Ninguno', C: 'Compras' },
        orden: ['A', 'V', 'N', 'C'],
    },
    {
        mapeo: 'productos', campo: 'tango_remitible',
        fuente: { tipo: 'estatico' },
        // Se guarda la S/N que manda Tango: asi no hay que tocar el mapper ni
        // el hash de sync. La casilla booleana quedo descartada por eso.
        opciones: { S: 'S', N: 'N' },
        etiquetas: { S: 'Si', N: 'No' },
        orden: ['S', 'N'],
    },
    {
        mapeo: 'productos', campo: 'tango_unidad_venta',
        fuente: { tipo: 'dominio', columna: 'MEDIDA_VENTAS_DESCRIPCION' },
    },
    {
        mapeo: 'productos', campo: 'tango_clasificacion',
        fuente: { tipo: 'dominio', columna: 'CLASIFICACION', separador: ';' },
        // Multivalor: un articulo puede tener tres clasificaciones a la vez, y
        // Tango las manda separadas por ';' — el mismo separador que usa
        // HubSpot para las casillas multiples. Por eso va `multiselect` y no
        // `select`: con select, los 43 articulos con mas de una se caen.
        hsFieldType: 'multiselect',
    },
];

const norm = (v) => `${v ?? ''}`.trim();
const leerJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Vuelve a escribir un mapeo con el formato que ya tenia: indentacion 2, CRLF,
 * y las lineas en blanco que separan los bloques de primer nivel.
 *
 * Sin esto un JSON.stringify pelado se come esas lineas, y un cambio de tres
 * campos aparece en el diff como si hubiera tocado el archivo entero.
 */
function serializarMapeo(datos, original) {
    const enBlancoAntesDe = new Set();
    const lineas = original.replace(/\r\n/g, '\n').split('\n');
    for (let i = 1; i < lineas.length; i++) {
        const m = /^ {2}"([^"]+)":/.exec(lineas[i]);
        if (m && lineas[i - 1].trim() === '') enBlancoAntesDe.add(m[1]);
    }

    const salida = [];
    for (const linea of `${JSON.stringify(datos, null, 2)}\n`.split('\n')) {
        const m = /^ {2}"([^"]+)":/.exec(linea);
        if (m && enBlancoAntesDe.has(m[1])) salida.push('');
        salida.push(linea);
    }
    return salida.join('\r\n');
}

function argumento(nombre, porDefecto) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
        ? process.argv[i + 1]
        : porDefecto;
}

/** Relee del ERP las tablas auxiliares y los dominios de articulo. */
async function refrescarDesdeElErp(urlProxy, procesos) {
    const cfg = { ...leerJson(path.join(RAIZ, 'local.settings.json')).Values, ...process.env };
    const tango = tangoClient.crear({
        baseUrl: cfg.TANGO_API_URL,
        apiKey: cfg.TANGO_API_KEY || 'la-pone-el-proxy',
        company: cfg.TANGO_COMPANY,
        fetchImpl: urlProxy ? fetchPorProxy(urlProxy) : fetch,
    });

    const porFixture = {
        condicionesVenta: 'condicionesVenta', zonas: 'zonas',
        vendedores: 'vendedores', transportes: 'transportes', alicuotasIva: 'alicuotasIva',
    };
    for (const [clave, archivo] of Object.entries(porFixture)) {
        const proc = procesos.auxiliares[clave]?.process;
        if (!proc) { console.log(`   ${archivo}: sin process en el catalogo, se deja el fixture`); continue; }
        const { registros, total } = await tango.get(proc);
        // Indentacion 1 y sin newline final: el formato con el que ya estan
        // versionados. Reescribirlos con otro formato hace que un refresco que
        // no cambio ningun dato aparezca igual como cinco archivos tocados.
        fs.writeFileSync(path.join(DIR_FIXTURES, `${archivo}.json`), JSON.stringify(registros, null, 1));
        console.log(`   ${archivo}: ${registros.length} de ${total} filas`);
    }

    const procArticulos = procesos.entidades.articulos.process;
    const { registros: articulos } = await tango.get(procArticulos);
    const dominios = { _meta: { origen: `Api/Get process=${procArticulos} (STA11)`, articulos: articulos.length, medido: new Date().toISOString().slice(0, 10) } };
    for (const d of DESPLEGABLES.filter((x) => x.fuente.tipo === 'dominio')) {
        const cuenta = new Map();
        for (const a of articulos) {
            const bruto = norm(a[d.fuente.columna]);
            if (!bruto) continue;
            const partes = d.fuente.separador
                ? bruto.split(d.fuente.separador).map(norm).filter(Boolean)
                : [bruto];
            for (const p of partes) cuenta.set(p, (cuenta.get(p) || 0) + 1);
        }
        dominios[d.fuente.columna] = Object.fromEntries([...cuenta].sort((a, b) => b[1] - a[1]));
        console.log(`   dominio ${d.fuente.columna}: ${cuenta.size} valores distintos`);
    }
    fs.writeFileSync(F_DOMINIOS, `${JSON.stringify(dominios, null, 2)}\n`);

    return articulos;
}

/** Las filas de la tabla de la que sale un desplegable. */
function filasDe(d, procesos) {
    if (d.fuente.tipo === 'catalogo') {
        const aux = procesos.auxiliares[d.fuente.clave];
        if (!aux?.filas) throw new Error(`${d.campo}: el catalogo no tiene filas para ${d.fuente.clave}`);
        return aux.filas;
    }
    if (d.fuente.tipo === 'fixture') {
        return leerJson(path.join(DIR_FIXTURES, `${d.fuente.archivo}.json`));
    }
    return null;
}

/**
 * Desplegable de ENTRADA: el valor guardado es el codigo de Tango.
 *
 * `opciones` queda como identidad sobre el codigo, porque el mapeo apunta a la
 * columna del CODIGO en la vista de clientes (`GVA05_CODIGO`, `COND_VTA`...) y
 * no a la de la descripcion. Asi el mapper guarda el codigo tal cual y no hay
 * traduccion que pueda quedar ambigua.
 *
 * La etiqueta desambigua cuando dos filas comparten descripcion: sin eso,
 * comercial ve dos renglones identicos y no puede saber cual eligio.
 */
function construirEntrada(d, filas) {
    const repetidas = new Map();
    for (const f of filas) {
        const e = norm(f[d.etiqueta]);
        if (e) repetidas.set(e, (repetidas.get(e) || 0) + 1);
    }

    const opciones = {};
    const etiquetas = {};
    const orden = [];
    const ocultas = new Set();
    let deBaja = 0;

    for (const f of filas) {
        const codigo = norm(f[d.codigo]);
        if (!codigo) continue;
        const desc = norm(f[d.etiqueta]) || codigo;
        opciones[codigo] = codigo;
        etiquetas[codigo] = repetidas.get(desc) > 1 ? `${desc} (${codigo})` : desc;
        orden.push(codigo);
        if (d.baja && f[d.baja] === true) { ocultas.add(codigo); deBaja++; }
    }

    return { opciones, etiquetas, orden, ocultas: [...ocultas], total: orden.length, deBaja };
}

/** { opciones, etiquetas, orden, ocultas } de un desplegable. */
function construir(d, procesos) {
    if (d.fuente.tipo === 'estatico') {
        return { opciones: d.opciones, etiquetas: d.etiquetas, orden: d.orden, ocultas: [], total: Object.keys(d.opciones).length, deBaja: 0 };
    }

    if (d.fuente.tipo === 'dominio') {
        if (!fs.existsSync(F_DOMINIOS)) throw new Error(`${d.campo}: falta ${path.basename(F_DOMINIOS)}. Correr con --proxy <url> para medirlo contra el ERP.`);
        const cuenta = leerJson(F_DOMINIOS)[d.fuente.columna];
        if (!cuenta) throw new Error(`${d.campo}: ${path.basename(F_DOMINIOS)} no tiene la columna ${d.fuente.columna}`);
        const valores = Object.keys(cuenta); // ya vienen ordenados por frecuencia
        return {
            opciones: Object.fromEntries(valores.map((v) => [v, v])),
            etiquetas: undefined, orden: valores, ocultas: [],
            total: valores.length, deBaja: 0,
        };
    }

    const filas = filasDe(d, procesos);

    // Un desplegable de ENTRADA guarda el CODIGO de Tango y muestra la
    // descripcion. Son los tres estratos del deposito (§9.8): lo que ve
    // comercial, lo que se guarda, y lo que va al ERP.
    //
    // No es un detalle de presentacion, es lo que hace que elegir SIRVA:
    // `lookups.resolver` traduce CODIGO -> ID interno, y con la descripcion
    // falla ('NOA' no existe en GVA05, '04' sí). Ademas la descripcion no
    // siempre identifica la fila: 'CHEQUE 45 DIAS FF' esta dos veces en GVA01,
    // con IDs 13 y 1069.
    if (d.entrada) return construirEntrada(d, filas);

    const opciones = {};
    const orden = [];
    const ocultas = new Set();
    const vistos = new Set();
    let deBaja = 0;

    for (const f of filas) {
        const valor = norm(f[d.valor]);
        if (!valor) continue;
        opciones[valor] = valor;

        // Dos filas distintas con la misma descripcion (pasa en GVA01) dan una
        // sola opcion: HubSpot no admite dos con el mismo `value`.
        if (!vistos.has(valor)) { vistos.add(valor); orden.push(valor); }

        if (d.baja && f[d.baja] === true) { ocultas.add(valor); deBaja++; }
    }

    // Una descripcion que comparten una fila viva y una de baja se OFRECE: hay
    // alguien vivo que la usa. Ocultarla la sacaria de la lista por culpa de
    // la otra.
    for (const f of filas) {
        if (d.baja && f[d.baja] !== true) ocultas.delete(norm(f[d.valor]));
    }

    return { opciones, etiquetas: undefined, orden, ocultas: [...ocultas], total: orden.length, deBaja };
}

(async () => {
    const aplicar = process.argv.includes('--aplicar');
    const urlProxy = argumento('proxy', null);
    const procesos = leerJson(P_PROCESOS);

    if (urlProxy) {
        console.log(`Releyendo el ERP por el proxy (${new URL(urlProxy).host})\n`);
        await refrescarDesdeElErp(urlProxy, procesos);
        console.log('');
    }

    if (!aplicar) console.log('(informe: no escribe nada. Agregar --aplicar para actualizar config/mapeo.*.json)\n');

    const porMapeo = new Map();
    for (const d of DESPLEGABLES) {
        if (!porMapeo.has(d.mapeo)) {
            const p = path.join(RAIZ, 'config', `mapeo.${d.mapeo}.json`);
            const original = fs.readFileSync(p, 'utf8');
            porMapeo.set(d.mapeo, { ruta: p, original, datos: JSON.parse(original), tocados: 0 });
        }
        const m = porMapeo.get(d.mapeo);
        const campo = m.datos.campos.find((c) => c.hubspot === d.campo);
        if (!campo) { console.log(`❌ ${d.campo}: no esta en mapeo.${d.mapeo}.json`); process.exitCode = 1; continue; }

        const { opciones, etiquetas, orden, ocultas, total, deBaja } = construir(d, procesos);

        // Un desplegable de entrada deja de leer la columna de la DESCRIPCION y
        // pasa a leer la del CODIGO. Es lo que hace que el valor guardado sea
        // el codigo sin ninguna traduccion en el medio.
        if (d.columnaCliente && campo.tango !== d.columnaCliente) {
            console.log(`   ${d.campo}: la fuente pasa de '${campo.tango}' a '${d.columnaCliente}'`);
            campo.tango = d.columnaCliente;
        }
        campo.hsFieldType = d.hsFieldType || 'select';
        campo.opciones = opciones;
        if (etiquetas) campo.opcionesEtiquetas = etiquetas; else delete campo.opcionesEtiquetas;
        campo.opcionesOrden = orden;
        if (ocultas.length) campo.opcionesOcultas = ocultas; else delete campo.opcionesOcultas;
        if (d.nota) campo.notasOpciones = d.nota;
        m.tocados++;

        const tipo = (d.hsFieldType || 'select') === 'multiselect' ? 'casillas' : 'desplegable';
        console.log(`✅ ${d.campo.padEnd(24)} ${String(total).padStart(3)} opciones  ${tipo.padEnd(12)}${deBaja ? `  (${deBaja} de baja, ocultas: ${ocultas.length})` : ''}`);
        console.log(`      ${orden.slice(0, 5).map((v) => JSON.stringify(v)).join(', ')}${orden.length > 5 ? `, ... +${orden.length - 5}` : ''}`);
    }

    if (!aplicar) { console.log('\n(informe) nada fue modificado.'); return; }

    console.log('');
    for (const [nombre, m] of porMapeo) {
        fs.writeFileSync(m.ruta, serializarMapeo(m.datos, m.original));
        console.log(`escrito config/mapeo.${nombre}.json (${m.tocados} campos)`);
    }
    console.log('\nSigue: node scripts/crearPropiedades.js clientes   (y productos) para ver el plan.');
})().catch((e) => {
    console.error('\nFALLO:', e.message);
    process.exit(1);
});
