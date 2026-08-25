'use strict';

const catalogo = require('../../config/tango.processes.json');

/**
 * Politica de acceso del proxy de diagnostico (testTangoConnection).
 *
 * El proxy es anonimo por decision de Matias y asi queda. Entonces la
 * contencion no puede venir de la autenticacion: viene de aca. Este modulo
 * decide, para cada peticion, si se reenvia a Tango y con que parametros.
 *
 * Que cierra, de lo que quedo abierto en ARQUITECTURA.md 10.0:
 *
 *   - Reenviaba CUALQUIER tangoPath    -> allowlist de rutas (punto 3)
 *   - Reenviaba TODOS los query params -> allowlist de params
 *   - No miraba el metodo              -> cada ruta acepta un solo metodo
 *   - filtroSql libre                  -> prohibido en modo cerrado
 *
 * Lo que NO cierra, y hay que saberlo: en modo relevamiento el filtroSql
 * sigue aceptando subconsultas, o sea lectura de cualquier tabla del ERP.
 * Es a proposito — el metodo de 5.7 y el oraculo booleano que resolvio GVA10
 * y CATEGORIA_IVA lo necesitan. Por eso ese modo es opt-in y el default es
 * cerrado: el dia que esto apunte a produccion no hay que acordarse de nada.
 *
 * Dos interruptores, los dos apagados por defecto:
 *   TANGO_PROXY_MODO=relevamiento  -> process desconocidos + filtroSql
 *   TANGO_PROXY_ESCRITURA=true     -> Api/Create, Api/Update, Api/Delete
 */

const MODO_CERRADO = 'cerrado';
const MODO_RELEVAMIENTO = 'relevamiento';

/** Ruta canonica -> unico metodo que la puede invocar, y si escribe. */
const RUTAS = {
    'api/get': { canonica: 'Api/Get', metodo: 'GET', escribe: false },
    'api/getbyid': { canonica: 'Api/GetById', metodo: 'GET', escribe: false },
    'api/getbyfilter': { canonica: 'Api/GetByFilter', metodo: 'GET', escribe: false },
    'api/create': { canonica: 'Api/Create', metodo: 'POST', escribe: true },
    'api/update': { canonica: 'Api/Update', metodo: 'PUT', escribe: true },
    'api/delete': { canonica: 'Api/Delete', metodo: 'DELETE', escribe: true },
};

/**
 * Params que se reenvian. Lo demas se rechaza en vez de descartarse en
 * silencio: un proxy que come parametros hace mentir al diagnostico.
 *
 * 'company' NO esta: la empresa la pone el proxy desde TANGO_COMPANY.
 */
const PARAMS = {
    'api/get': ['process', 'pages', 'pageSize'],
    'api/getbyid': ['process', 'id'],
    'api/getbyfilter': ['process', 'filtroSql'],
    'api/create': ['process'],
    'api/update': ['process', 'id'],
    'api/delete': ['process', 'id'],
};

/** SQL que no tiene nada que hacer adentro de un WHERE de solo lectura. */
const SQL_PROHIBIDO = [
    { patron: /;/, motivo: 'punto y coma (encadena sentencias)' },
    { patron: /--/, motivo: 'comentario de linea' },
    { patron: /\/\*/, motivo: 'comentario de bloque' },
    { patron: /\b(insert|update|delete|drop|alter|truncate|merge|create|grant|exec|execute|backup|shutdown)\b/i, motivo: 'verbo de escritura o DDL' },
    { patron: /\b(xp_|sp_)\w+/i, motivo: 'procedimiento extendido' },
];

/** Los process que ya conocemos, sacados del catalogo. Unica fuente. */
function procesosDelCatalogo(cfg = catalogo) {
    const vistos = new Set();
    for (const grupo of [cfg.entidades, cfg.auxiliares]) {
        for (const [nombre, def] of Object.entries(grupo || {})) {
            if (nombre.startsWith('_') || !def || typeof def !== 'object') continue;
            if (Number.isInteger(def.process)) vistos.add(def.process);
        }
    }
    return vistos;
}

const PROCESSES_CONOCIDOS = procesosDelCatalogo();

function normalizarModo(valor) {
    return String(valor || '').trim().toLowerCase() === MODO_RELEVAMIENTO ? MODO_RELEVAMIENTO : MODO_CERRADO;
}

function esVerdadero(valor) {
    return /^(true|1|si|yes)$/i.test(String(valor || '').trim());
}

/** Lee los dos interruptores del entorno. Ausente o basura = lo mas cerrado. */
function politicaDelEntorno(env = process.env) {
    return {
        modo: normalizarModo(env.TANGO_PROXY_MODO),
        escritura: esVerdadero(env.TANGO_PROXY_ESCRITURA),
    };
}

function rechazo(status, motivo) {
    return { ok: false, status, motivo };
}

function revisarFiltro(filtro, modo) {
    if (modo !== MODO_RELEVAMIENTO) {
        return rechazo(403, 'filtroSql solo se acepta en modo relevamiento (TANGO_PROXY_MODO=relevamiento)');
    }
    if (!/^\s*where\b/i.test(filtro)) {
        // Sin WHERE, SQL Server tira "Incorrect syntax near '='". Ver 5.8.
        return rechazo(400, 'filtroSql tiene que empezar con WHERE');
    }
    for (const { patron, motivo } of SQL_PROHIBIDO) {
        if (patron.test(filtro)) return rechazo(403, `filtroSql rechazado: ${motivo}`);
    }
    return null;
}

/**
 * @param {object} p
 * @param {string} p.metodo      metodo HTTP tal cual llego
 * @param {string} p.tangoPath   ruta pedida (?tangoPath=, o la default del metodo)
 * @param {URLSearchParams|object} p.params  query params, ya sin tangoPath
 * @param {string} [p.modo]      'cerrado' (default) | 'relevamiento'
 * @param {boolean} [p.escritura] habilita Create/Update/Delete
 * @param {Set<number>} [p.processesPermitidos] override del catalogo, para tests
 * @returns {{ok:true, tangoPath:string, params:URLSearchParams} | {ok:false, status:number, motivo:string}}
 *
 * Nunca lanza: una peticion mal armada es un 400/403, no un 500.
 */
function decidir({ metodo, tangoPath, params, modo = MODO_CERRADO, escritura = false, processesPermitidos = PROCESSES_CONOCIDOS } = {}) {
    const modoNormalizado = normalizarModo(modo);
    const entrada = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});

    const clave = String(tangoPath || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
    const ruta = RUTAS[clave];
    if (!ruta) {
        const permitidas = Object.values(RUTAS).map((r) => r.canonica).join(', ');
        return rechazo(403, `ruta no permitida: '${tangoPath}'. Permitidas: ${permitidas}`);
    }

    // Sin esto un GET Api/Delete pasaria igual: Tango mira la ruta, no el metodo.
    if (String(metodo || '').toUpperCase() !== ruta.metodo) {
        return rechazo(405, `${ruta.canonica} se invoca con ${ruta.metodo}, no con ${String(metodo || '').toUpperCase()}`);
    }

    if (ruta.escribe && !escritura) {
        return rechazo(403, `${ruta.canonica} escribe en el ERP: habilitar con TANGO_PROXY_ESCRITURA=true`);
    }

    const permitidos = PARAMS[clave];
    const sobrantes = [...entrada.keys()].filter((k) => !permitidos.includes(k));
    if (sobrantes.length) {
        return rechazo(400, `parametros no permitidos para ${ruta.canonica}: ${sobrantes.join(', ')}. Acepta: ${permitidos.join(', ')}`);
    }

    const process = entrada.get('process');
    if (process === null || String(process).trim() === '') {
        return rechazo(400, 'falta el parametro process');
    }
    if (!/^\d+$/.test(String(process).trim())) {
        return rechazo(400, `process tiene que ser un entero, llego '${process}'`);
    }
    const nroProcess = Number(String(process).trim());
    if (modoNormalizado !== MODO_RELEVAMIENTO && !processesPermitidos.has(nroProcess)) {
        return rechazo(403, `process ${nroProcess} no esta en el catalogo. Para descubrir process nuevos: TANGO_PROXY_MODO=relevamiento`);
    }

    const filtro = entrada.get('filtroSql');
    if (filtro !== null) {
        const problema = revisarFiltro(filtro, modoNormalizado);
        if (problema) return problema;
    }

    // Se devuelve la query reconstruida, no la que llego: lo que no esta en la
    // allowlist no viaja, aunque manana alguien afloje la validacion de arriba.
    const salida = new URLSearchParams();
    for (const nombre of permitidos) {
        const valor = entrada.get(nombre);
        if (valor !== null) salida.set(nombre, valor);
    }

    return { ok: true, tangoPath: ruta.canonica, params: salida };
}

module.exports = {
    decidir, politicaDelEntorno, procesosDelCatalogo,
    PROCESSES_CONOCIDOS, RUTAS, PARAMS,
    MODO_CERRADO, MODO_RELEVAMIENTO,
};
