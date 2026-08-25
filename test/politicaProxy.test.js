'use strict';

const test = require('node:test');
const assert = require('node:assert');

const politica = require('../src/lib/politicaProxy');

// 2117 (clientes) y 842 (zonas) son process reales del catalogo.

// ── Rutas ────────────────────────────────────────────────────────────────

test('la lectura normal de clientes pasa con la politica cerrada', () => {
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: { process: '2117', pageSize: '6000' } });
    assert.strictEqual(r.ok, true, r.motivo);
    assert.strictEqual(r.tangoPath, 'Api/Get');
    assert.strictEqual(r.params.toString(), 'process=2117&pageSize=6000');
});

test('una ruta fuera de la allowlist se rechaza', () => {
    // El agujero de 10.0: el proxy reenviaba cualquier tangoPath.
    for (const ruta of ['Api/Menu', 'Api/Modules', '../../etc/passwd', 'Api', '']) {
        const r = politica.decidir({ metodo: 'GET', tangoPath: ruta, params: { process: '2117' } });
        assert.strictEqual(r.ok, false, `deberia rechazar '${ruta}'`);
        assert.strictEqual(r.status, 403);
    }
});

test('la ruta se normaliza: barras y mayusculas no la esquivan', () => {
    for (const ruta of ['/Api/Get', 'api/get/', 'API/GET']) {
        const r = politica.decidir({ metodo: 'GET', tangoPath: ruta, params: { process: '2117' } });
        assert.strictEqual(r.ok, true, `${ruta}: ${r.motivo}`);
        assert.strictEqual(r.tangoPath, 'Api/Get', 'se reenvia la forma canonica, no la que llego');
    }
});

// ── Metodo ───────────────────────────────────────────────────────────────

test('cada ruta acepta un solo metodo', () => {
    // Tango mira la ruta, no el verbo: sin este control un GET Api/Delete borra.
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Delete', params: { process: '2117', id: '6318' }, escritura: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 405);
});

test('el metodo correcto de cada ruta esta bien atado', () => {
    const esperado = { 'Api/Get': 'GET', 'Api/GetById': 'GET', 'Api/GetByFilter': 'GET', 'Api/Create': 'POST', 'Api/Update': 'PUT', 'Api/Delete': 'DELETE' };
    for (const [ruta, metodo] of Object.entries(esperado)) {
        const params = { process: '2117' };
        if (ruta === 'Api/GetById' || ruta === 'Api/Update' || ruta === 'Api/Delete') params.id = '6318';
        if (ruta === 'Api/GetByFilter') params.filtroSql = "WHERE COD_GVA14='000003'";
        const r = politica.decidir({ metodo, tangoPath: ruta, params, escritura: true, modo: 'relevamiento' });
        assert.strictEqual(r.ok, true, `${metodo} ${ruta}: ${r.motivo}`);
    }
});

// ── Escritura ────────────────────────────────────────────────────────────

test('las rutas que escriben estan apagadas por defecto', () => {
    for (const [metodo, ruta] of [['POST', 'Api/Create'], ['PUT', 'Api/Update'], ['DELETE', 'Api/Delete']]) {
        const r = politica.decidir({ metodo, tangoPath: ruta, params: { process: '2117', id: '6318' } });
        assert.strictEqual(r.ok, false, `${ruta} no deberia pasar sin TANGO_PROXY_ESCRITURA`);
        assert.strictEqual(r.status, 403);
        assert.match(r.motivo, /TANGO_PROXY_ESCRITURA/);
    }
});

test('con el interruptor de escritura se puede borrar un registro de prueba', () => {
    // El caso real: limpiar los clientes 9999xx del relevamiento del 18.
    const r = politica.decidir({ metodo: 'DELETE', tangoPath: 'Api/Delete', params: { process: '2117', id: '6318' }, escritura: true });
    assert.strictEqual(r.ok, true, r.motivo);
    assert.strictEqual(r.params.toString(), 'process=2117&id=6318');
});

// ── Process ──────────────────────────────────────────────────────────────

test('en modo cerrado solo pasan los process del catalogo', () => {
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: { process: '10348' } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
    assert.match(r.motivo, /relevamiento/, 'el mensaje tiene que decir como habilitarlo');
});

test('en modo relevamiento pasa cualquier process: para eso existe', () => {
    // Sin esto se rompe el metodo de 5.7 y no se consiguen los process que faltan.
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: { process: '99999' }, modo: 'relevamiento' });
    assert.strictEqual(r.ok, true, r.motivo);
});

test('el catalogo es la unica fuente de los process conocidos', () => {
    // Si manana aparece el process de precios, alcanza con cargarlo en el JSON.
    const desdeConfig = politica.procesosDelCatalogo();
    assert.ok(desdeConfig.has(2117), 'clientes');
    assert.ok(desdeConfig.has(19845), 'pedidos');
    assert.ok(!desdeConfig.has(10348), 'el process de listas que paso administracion no sirve y no esta cargado');
    assert.deepStrictEqual([...desdeConfig].sort((a, b) => a - b), [...politica.PROCESSES_CONOCIDOS].sort((a, b) => a - b));
});

test('un process que no es entero se rechaza', () => {
    for (const valor of ['2117 OR 1=1', '', 'abc', '-1', '21.17']) {
        const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: { process: valor }, modo: 'relevamiento' });
        assert.strictEqual(r.ok, false, `deberia rechazar process='${valor}'`);
        assert.strictEqual(r.status, 400);
    }
});

test('sin process no se reenvia nada', () => {
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: {} });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
});

// ── Query params ─────────────────────────────────────────────────────────

test('los params fuera de la allowlist se rechazan, no se descartan callados', () => {
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: { process: '2117', filtroSql: 'WHERE 1=1' } });
    assert.strictEqual(r.ok, false, 'Api/Get no acepta filtroSql');
    assert.strictEqual(r.status, 400);
    assert.match(r.motivo, /filtroSql/);
});

test('company no se puede pisar desde el request', () => {
    // La empresa la pone el proxy desde TANGO_COMPANY; si viajara desde afuera
    // se podria leer otra empresa del ERP.
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: { process: '2117', company: '2' } });
    assert.strictEqual(r.ok, false);
    assert.match(r.motivo, /company/);
});

test('la query que sale se reconstruye desde la allowlist', () => {
    const entrada = new URLSearchParams([['process', '2117'], ['pageSize', '10'], ['pages', '1']]);
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/Get', params: entrada });
    assert.strictEqual(r.ok, true, r.motivo);
    assert.deepStrictEqual([...r.params.keys()], ['process', 'pages', 'pageSize'], 'orden canonico, no el de llegada');
    assert.notStrictEqual(r.params, entrada, 'no se devuelve el objeto que llego');
});

// ── filtroSql ────────────────────────────────────────────────────────────

test('en modo cerrado filtroSql no se acepta ni bien formado', () => {
    // Es el agujero de fondo: aunque el process este en el catalogo, una
    // subconsulta lee cualquier tabla del ERP.
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/GetByFilter', params: { process: '2117', filtroSql: "WHERE COD_GVA14='000003'" } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
});

test('en modo relevamiento el filtro de lectura pasa, subconsulta incluida', () => {
    // El oraculo booleano que resolvio GVA10 y CATEGORIA_IVA es exactamente esto.
    const filtro = 'WHERE ID_GVA05 IN (SELECT TOP 1 ID_GVA14 FROM GVA14)';
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/GetByFilter', params: { process: '842', filtroSql: filtro }, modo: 'relevamiento' });
    assert.strictEqual(r.ok, true, r.motivo);
    assert.strictEqual(r.params.get('filtroSql'), filtro);
});

test('el filtro tiene que empezar con WHERE', () => {
    const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/GetByFilter', params: { process: '2117', filtroSql: "COD_GVA14='000003'" }, modo: 'relevamiento' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 400);
});

test('el filtro no puede encadenar sentencias ni escribir', () => {
    const ataques = [
        "WHERE 1=1; DROP TABLE GVA14",
        "WHERE 1=1 -- comentario",
        "WHERE 1=1 /* comentario */",
        "WHERE 1=1 AND 1=(UPDATE GVA14 SET COD_GVA14='x')",
        "WHERE 1=1; EXEC xp_cmdshell 'dir'",
        "WHERE 1=1; TRUNCATE TABLE GVA21",
    ];
    for (const filtro of ataques) {
        const r = politica.decidir({ metodo: 'GET', tangoPath: 'Api/GetByFilter', params: { process: '2117', filtroSql: filtro }, modo: 'relevamiento' });
        assert.strictEqual(r.ok, false, `deberia rechazar: ${filtro}`);
        assert.strictEqual(r.status, 403);
    }
});

// ── Interruptores ────────────────────────────────────────────────────────

test('sin variables de entorno la politica queda en lo mas cerrado', () => {
    const p = politica.politicaDelEntorno({});
    assert.strictEqual(p.modo, 'cerrado');
    assert.strictEqual(p.escritura, false);
});

test('un valor raro en las variables no abre nada', () => {
    for (const valor of ['RELEVAMIENTO ', 'Relevamiento']) {
        assert.strictEqual(politica.politicaDelEntorno({ TANGO_PROXY_MODO: valor }).modo, 'relevamiento', 'espacios y mayusculas si valen');
    }
    for (const valor of ['produccion', 'true', '1', 'abierto', '']) {
        assert.strictEqual(politica.politicaDelEntorno({ TANGO_PROXY_MODO: valor }).modo, 'cerrado', `'${valor}' no deberia abrir el modo`);
    }
    for (const valor of ['false', 'no', '0', 'quizas', '']) {
        assert.strictEqual(politica.politicaDelEntorno({ TANGO_PROXY_ESCRITURA: valor }).escritura, false, `'${valor}' no deberia habilitar escritura`);
    }
    assert.strictEqual(politica.politicaDelEntorno({ TANGO_PROXY_ESCRITURA: 'true' }).escritura, true);
});

test('decidir sin argumentos no explota: contesta que no', () => {
    const r = politica.decidir();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 403);
});

test('los dos interruptores son independientes', () => {
    // Relevamiento abre los process, no la escritura.
    const r = politica.decidir({ metodo: 'POST', tangoPath: 'Api/Create', params: { process: '2117' }, modo: 'relevamiento' });
    assert.strictEqual(r.ok, false, 'relevamiento no deberia habilitar el alta');
    assert.match(r.motivo, /TANGO_PROXY_ESCRITURA/);

    // Y escritura no abre los process desconocidos ni el filtro.
    const r2 = politica.decidir({ metodo: 'POST', tangoPath: 'Api/Create', params: { process: '99999' }, escritura: true });
    assert.strictEqual(r2.ok, false, 'escritura no deberia habilitar process fuera del catalogo');
    assert.match(r2.motivo, /catalogo/);
});
