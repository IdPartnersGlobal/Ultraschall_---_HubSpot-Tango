'use strict';

/**
 * Simulacion del sync de empresas contra los datos REALES, sin escribir nada.
 *
 * Reusa las mismas funciones que corren en Azure —lookups.cargar, tango.get,
 * mapper, syncClientes.planificar— para que lo simulado sea lo que va a pasar
 * y no una imitacion. Lo unico propio de este script es volcar el plan a dos
 * CSV que se puedan abrir en Excel.
 *
 *   node scripts/simulacionSync.js
 *   node scripts/simulacionSync.js --proxy <url con ?code=> --salida <carpeta>
 *
 * Nunca escribe: no tiene modo de escritura y no lo va a tener. Para escribir
 * esta el timer de Azure (11.1).
 *
 * Salida (formato del 2026-09-15: UTF-8 con BOM, separador ';', todo entre comillas):
 *   Simulacion sync empresas - una fila por empresa - <fecha>.csv
 *   Simulacion sync empresas - detalle por campo - <fecha>.csv
 */

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const REPO = path.join(__dirname, '..');
// Al lado del repo, que es donde Matias abre los CSV. `--salida <dir>` lo pisa.
const SALIDA = opcion('--salida') || path.join(REPO, '..');
// La URL del proxy sale de --proxy, de TANGO_PROXY_URL o de local.settings.json.
// Necesita su `?code=` o TANGO_PROXY_KEY (10.0.1).
const URL_PROXY_DEFECTO = 'https://ultraschall-tango-hubspot-cjcpbug0g4fxgehg.canadacentral-01.azurewebsites.net/api/testTangoConnection';

const tangoClient = require(path.join(REPO, 'src/lib/tangoClient'));
const hubspotClient = require(path.join(REPO, 'src/lib/hubspotClient'));
const lookups = require(path.join(REPO, 'src/lib/lookups'));
const mapper = require(path.join(REPO, 'src/lib/mapper'));
const sync = require(path.join(REPO, 'src/lib/syncClientes'));
const { fetchPorProxy } = require(path.join(REPO, 'src/lib/proxyTango'));
const procesos = require(path.join(REPO, 'config/tango.processes.json'));
const mapeoClientes = require(path.join(REPO, 'config/mapeo.clientes.json'));

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

const ETIQUETAS = new Map(mapeoClientes.campos.map((c) => [c.hubspot, c.label || c.hubspot]));
const etiqueta = (p) => ETIQUETAS.get(p) || p;

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';
const celda = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
const fila = (xs) => xs.map(celda).join(';');

// Las mismas palabras que uso el CSV del 2026-09-15, para poder comparar.
const NOMBRE_ESTADO = {
    vinculada: 'Vinculada con Tango',
    no_existe: 'No existe en Tango',
    codigo_de_otro_cliente: 'Código de otro cliente',
    ficha_duplicada: 'Ficha duplicada',
    marcada_para_borrar: 'Marcada para borrar en Tango',
    posible_duplicado: 'Posible duplicado',
};

(async () => {
    const t0 = Date.now();
    log.inicio('SIMULACION del sync de empresas (no escribe nada)');

    const tango = tangoClient.crear({
        baseUrl: V.TANGO_API_URL,
        apiKey: V.TANGO_API_KEY,
        log,
        fetchImpl: fetchPorProxy(opcion('--proxy') || V.TANGO_PROXY_URL || URL_PROXY_DEFECTO, { clave: V.TANGO_PROXY_KEY }),
    });
    const hs = hubspotClient.crear({ token: V.HUBSPOT_TOKEN, log });

    log.paso('LOOKUPS', 'cargando tablas auxiliares...');
    const lk = await lookups.cargar(tango, log);

    log.paso('TANGO', 'leyendo clientes (process=' + procesos.entidades.clientes.process + ')...');
    const { registros, total } = await tango.get(procesos.entidades.clientes.process);
    log.datos('TANGO-OK', { 'registros leidos': registros.length, 'totalCount informado': total });

    const m = mapper.crear(mapeoClientes, lk);
    log.paso('HUBSPOT', 'leyendo companies existentes...');
    // Para SIMULAR hay que leer de mas: el sync solo lee lo que necesita para
    // decidir (clave, hash, etiquetas y los campos no autoritativos), asi que
    // los autoritativos —la categoria de IVA, que es el unico que se pisa— no
    // vendrian, y un reemplazo se veria como "se llena". Leer de mas no cambia
    // el plan: planificar solo mira la clave, el hash y los no autoritativos.
    const propsLeer = [...new Set([...sync.propiedadesALeer(m), ...mapeoClientes.campos.map((c) => c.hubspot)])];
    const existentes = await hs.leerTodos('companies', propsLeer);
    log.datos('HUBSPOT-OK', { 'companies leidas': existentes.length });

    log.paso('PLAN', 'planificando...');
    const plan = sync.planificar({ registros, existentes, m, ahora: new Date() });

    // ── indices, para poder contar el "antes" ─────────────────────────────
    const porId = new Map(existentes.map((c) => [String(c.id), c]));
    const CLAVE_HS = mapeoClientes._meta.claveIdempotencia.hubspot;
    const porClave = new Map();
    for (const c of existentes) {
        const k = c.properties ? c.properties[CLAVE_HS] : null;
        if (!vacio(k)) porClave.set(String(k).trim(), c);
    }
    const porCodigoTango = new Map();
    for (const r of registros) {
        const k = m.clave(r);
        if (k) porCodigoTango.set(k, r);
    }

    const noAutoritativos = new Set(m.camposNoAutoritativos());
    const sugeridosUnicos = sync.calcularDominiosUnicos(registros, m, 'tango_dominio_sugerido');

    // ── una entrada por company del plan ──────────────────────────────────
    const entradas = [];
    for (const u of plan.updates) entradas.push({ porIdDeHubSpot: true, id: String(u.id), props: u.properties });
    for (const u of plan.upserts) entradas.push({ porIdDeHubSpot: false, clave: String(u.id), props: u.properties });

    const columnas = [];
    const vistas = new Set();
    for (const e of entradas) {
        for (const p of Object.keys(e.props)) {
            if (!vistas.has(p)) { vistas.add(p); columnas.push(p); }
        }
    }

    const filasEmpresa = [];
    const filasCampo = [];
    const conteo = { vincular: 0, crear: 0, actualizar: 0, soloEtiqueta: 0 };

    for (const e of entradas) {
        const actual = e.porIdDeHubSpot ? porId.get(e.id) : porClave.get(e.clave);
        const propsActuales = (actual && actual.properties) || {};
        const codigo = e.props[CLAVE_HS] || propsActuales[CLAVE_HS] || propsActuales.codigo_tango || e.clave || '';
        const registro = porCodigoTango.get(String(codigo).trim());
        const clienteTango = registro ? String(registro.RAZON_SOCI === undefined ? '' : registro.RAZON_SOCI).trim() : '';
        const nombreHs = propsActuales.name || propsActuales.razon_social || '';
        const estado = e.props.tango_estado || '';
        const detalle = e.props.tango_estado_detalle || '';

        const soloEtiquetas = Object.keys(e.props).every((p) => p === 'tango_estado' || p === 'tango_estado_detalle');
        let accion;
        if (!actual) { accion = 'Crear empresa nueva'; conteo.crear++; }
        else if (soloEtiquetas) { accion = 'Solo etiqueta (no se toca nada mas)'; conteo.soloEtiqueta++; }
        else if (vacio(propsActuales[CLAVE_HS])) { accion = 'Vincular con Tango'; conteo.vincular++; }
        else { accion = 'Actualizar'; conteo.actualizar++; }

        let seLlenan = 0;
        const nombresLlenados = [];
        const nombresReemplazados = [];

        for (const [p, valor] of Object.entries(e.props)) {
            if (p === 'tango_estado' || p === 'tango_estado_detalle') continue;
            const antes = propsActuales[p];
            let tipo;
            if (!actual) tipo = 'empresa nueva';
            else if (vacio(antes)) tipo = 'se llena';
            else if (String(antes) === String(valor)) tipo = 'igual';
            else tipo = 'se reemplaza';

            if (tipo === 'se llena' || tipo === 'empresa nueva') { seLlenan++; nombresLlenados.push(etiqueta(p)); }
            if (tipo === 'se reemplaza') nombresReemplazados.push(etiqueta(p));

            filasCampo.push(fila([accion, (actual && actual.id) || '', nombreHs, codigo, clienteTango, etiqueta(p), antes, valor, tipo]));
        }

        // Lo que Tango traia y NO se escribe porque ya estaba cargado en HubSpot.
        if (registro && actual) {
            const { propiedades } = m.aHubSpot(registro);
            for (const [p, valor] of Object.entries(propiedades)) {
                if (p in e.props) continue;
                if (!noAutoritativos.has(p)) continue;
                if (p === 'tango_dominio_sugerido' && !sugeridosUnicos.has(valor)) continue;
                if (vacio(propsActuales[p])) continue;
                filasCampo.push(fila([accion, actual.id, nombreHs, codigo, clienteTango, etiqueta(p), propsActuales[p], valor, 'se respeta (ya cargado en HubSpot)']));
            }
        }

        filasEmpresa.push(fila([
            NOMBRE_ESTADO[estado] || estado, detalle, accion,
            (actual && actual.id) || '', nombreHs, codigo, clienteTango,
            String(seLlenan), nombresLlenados.join(' · '), nombresReemplazados.join(' · '),
        ].concat(columnas.map((p) => (p in e.props ? e.props[p] : '')))));
    }

    const hoy = new Date().toISOString().slice(0, 10);
    const cabeceraEmpresa = fila([
        'Estado en Tango', 'Detalle', 'Accion', 'ID empresa HubSpot', 'Nombre en HubSpot', 'Codigo Tango', 'Cliente en Tango',
        'Cantidad de campos que se llenan', 'Campos que se llenan (estaban vacios)', 'Se reemplaza (tenia otro valor)',
    ].concat(columnas.map((p) => 'Nuevo valor: ' + etiqueta(p))));
    const cabeceraCampo = fila(['accion', 'empresa_hubspot', 'nombre_en_hubspot', 'codigo_tango', 'cliente_en_tango', 'campo', 'antes', 'despues', 'tipo_de_cambio']);

    const f1 = path.join(SALIDA, 'Simulacion sync empresas - una fila por empresa - ' + hoy + '.csv');
    const f2 = path.join(SALIDA, 'Simulacion sync empresas - detalle por campo - ' + hoy + '.csv');
    fs.writeFileSync(f1, '\uFEFF' + [cabeceraEmpresa].concat(filasEmpresa).join('\r\n') + '\r\n', 'utf8');
    fs.writeFileSync(f2, '\uFEFF' + [cabeceraCampo].concat(filasCampo).join('\r\n') + '\r\n', 'utf8');

    log.datos('RESUMEN', {
        'leidos de Tango': plan.resumen.leidosTango,
        'companies en HubSpot': plan.resumen.enHubSpot,
        'a crear': plan.resumen.aCrear,
        'no se crean (un prospecto sin codigo parece ser el cliente)': plan.resumen.noSeCreanPorPosibleDuplicado,
        'a vincular (importadas)': plan.resumen.aVincular,
        'a actualizar': plan.resumen.aActualizar,
        'sin cambios': plan.resumen.sinCambios,
        'etiquetas cambiadas': plan.resumen.etiquetasCambiadas,
        'campos respetados (lo cargado en HubSpot)': plan.resumen.respetados,
        'conflictos': plan.resumen.conflictos.length,
        'problemas de mapeo': plan.resumen.problemas.length,
        'filas en el CSV por empresa': filasEmpresa.length,
        'filas en el CSV por campo': filasCampo.length,
        'duracion': ((Date.now() - t0) / 1000).toFixed(1) + 's',
    });

    console.log('\nestado en Tango que quedaria:');
    for (const [k, v] of Object.entries(plan.resumen.estados).sort((a, b) => b[1] - a[1])) console.log('   ' + String(v).padStart(6) + '  ' + k);

    if (plan.resumen.conflictos.length) {
        console.log('\nconflictos (' + plan.resumen.conflictos.length + '):');
        for (const c of plan.resumen.conflictos) console.log('   ' + c.codigo + '  ' + c.tipo + '  -> ' + c.empresas.join(', '));
    }

    const porTipo = {};
    for (const p of plan.resumen.problemas) {
        const k = p.replace(/'[^']*'/g, "'X'").replace(/\(cliente [^)]*\)/, '').trim();
        porTipo[k] = (porTipo[k] || 0) + 1;
    }
    if (Object.keys(porTipo).length) {
        console.log('\nproblemas de mapeo por tipo:');
        for (const [k, v] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) console.log('   ' + String(v).padStart(5) + '  ' + k);
    }

    console.log('\nCSV:\n   ' + f1 + '\n   ' + f2);
    log.fin('simulacion completa, no se escribio nada.');
})().catch((e) => {
    console.error('\nFALLO:', e.message);
    console.error(e.stack);
    process.exit(1);
});
