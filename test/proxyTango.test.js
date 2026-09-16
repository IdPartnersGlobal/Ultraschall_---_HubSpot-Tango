'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { fetchPorProxy, ProxyBloqueado } = require('../src/lib/proxyTango');
const tangoClient = require('../src/lib/tangoClient');

// Como la copia el portal de Azure: con la clave de funcion en la query.
// El proxy dejo de ser anonimo el 2026-09-16 (10.0).
const CLAVE = 'clave-de-funcion-de-prueba';
const URL_BASE = 'https://ejemplo.azurewebsites.net/api/testTangoConnection';
const URL_PROXY = `${URL_BASE}?code=${CLAVE}`;

/** fetch de mentira: registra lo que le pidieron y contesta lo que se le diga. */
function espia(responder) {
    const llamadas = [];
    const fake = async (url, opciones) => {
        llamadas.push({ url, opciones });
        return responder(url, opciones);
    };
    return { llamadas, fake };
}

const sobre = (result, extra = {}) =>
    new Response(JSON.stringify({ status: 'success', proxyTarget: 'x', result, ...extra }), { status: 200 });

test('la ruta de Tango viaja como tangoPath y los params se conservan', async () => {
    const { llamadas, fake } = espia(() => sobre({ resultData: { list: [] } }));
    const f = fetchPorProxy(URL_PROXY, { fetchImpl: fake });

    await f('http://138.99.6.77:17000/Api/Get?process=2941&pages=1&pageSize=200');

    const u = new URL(llamadas[0].url);
    assert.strictEqual(u.origin + u.pathname, URL_BASE);
    assert.strictEqual(u.searchParams.get('tangoPath'), 'Api/Get');
    assert.strictEqual(u.searchParams.get('process'), '2941');
    assert.strictEqual(u.searchParams.get('pageSize'), '200');
});

test('la API key de Tango NO se reenvia al proxy', async () => {
    const { llamadas, fake } = espia(() => sobre({ value: null }));
    const f = fetchPorProxy(URL_PROXY, { fetchImpl: fake });

    await f('http://138.99.6.77:17000/Api/Get?process=2117', {
        headers: { ApiAuthorization: 'la-clave-del-erp', company: '1' },
    });

    const enviados = Object.keys(llamadas[0].opciones.headers).map((k) => k.toLowerCase());
    assert.ok(!enviados.includes('apiauthorization'), 'la credencial del ERP no puede viajar a un endpoint anonimo');
    assert.ok(!enviados.includes('company'));
});

test('devuelve el result pelado, asi tangoClient no se entera del proxy', async () => {
    const registros = [{ ID_STA22: 1, COD_STA22: '01' }];
    const { fake } = espia(() => sobre({ resultData: { list: registros, totalCount: 1, hasNextPage: false } }));

    const tango = tangoClient.crear({
        baseUrl: 'http://138.99.6.77:17000',
        apiKey: 'no-se-usa',
        fetchImpl: fetchPorProxy(URL_PROXY, { fetchImpl: fake }),
    });

    const { registros: leidos, total } = await tango.get(2941);
    assert.deepStrictEqual(leidos, registros);
    assert.strictEqual(total, 1);
});

test('un POST llega como POST y con su cuerpo', async () => {
    const { llamadas, fake } = espia(() => sobre({ succeeded: true }));
    const f = fetchPorProxy(URL_PROXY, { fetchImpl: fake });

    await f('http://138.99.6.77:17000/Api/Create?process=2117', {
        method: 'POST',
        body: JSON.stringify({ RAZON_SOCI: 'X' }),
    });

    assert.strictEqual(llamadas[0].opciones.method, 'POST');
    assert.strictEqual(llamadas[0].opciones.body, '{"RAZON_SOCI":"X"}');
    assert.strictEqual(new URL(llamadas[0].url).searchParams.get('tangoPath'), 'Api/Create');
});

test('si la politica bloquea, el error lo dice y no se confunde con un error de Tango', async () => {
    const { fake } = espia(() =>
        new Response(JSON.stringify({ status: 'blocked', motivo: 'process fuera del catalogo', modo: 'seguro' }), { status: 403 }),
    );
    const f = fetchPorProxy(URL_PROXY, { fetchImpl: fake });

    await assert.rejects(
        () => f('http://138.99.6.77:17000/Api/Get?process=2941'),
        (e) => e instanceof ProxyBloqueado && /fuera del catalogo/.test(e.motivo),
    );
});

test('un error DE TANGO conserva su cuerpo y su status: lo tiene que ver tangoClient', async () => {
    // Sin pasar por tangoClient a proposito: ahi el 400 dispara los reintentos
    // con espera exponencial y el test tardaria seis segundos en probar esto.
    const { fake } = espia(() =>
        new Response(JSON.stringify({ status: 'fail', statusCode: 400, tangoRawResponse: '{"succeeded":false,"message":"El campo X es requerido"}' }), { status: 400 }),
    );
    const f = fetchPorProxy(URL_PROXY, { fetchImpl: fake });

    const res = await f('http://138.99.6.77:17000/Api/Get?process=2941');
    assert.strictEqual(res.status, 400);
    assert.match(await res.text(), /El campo X es requerido/);
});

test('el 504 de Azure (HTML) no se hace pasar por una respuesta de Tango', async () => {
    const { fake } = espia(() => new Response('<html>504 Gateway Timeout</html>', { status: 504 }));

    const tango = tangoClient.crear({
        baseUrl: 'http://138.99.6.77:17000',
        apiKey: 'no-se-usa',
        fetchImpl: fetchPorProxy(URL_PROXY, { fetchImpl: fake }),
    });

    await assert.rejects(() => tango.get(2941));
});

// ── La clave de la funcion (2026-09-16) ─────────────────────────────────────

test('la clave sale de la URL y viaja en el header, no en la query', async () => {
    // Que no quede escrita en la URL de cada request: la URL viaja entera a los
    // logs de red, de Azure y de cualquier intermediario.
    const { llamadas, fake } = espia(() => sobre({ resultData: { list: [] } }));
    const tango = tangoClient.crear({ baseUrl: 'http://tango:17000', apiKey: 'k', fetchImpl: fetchPorProxy(URL_PROXY, { fetchImpl: fake }) });
    await tango.get({ process: 2941, pages: 1 });

    const { url, opciones } = llamadas[0];
    assert.strictEqual(opciones.headers['x-functions-key'], CLAVE);
    assert.ok(!url.includes('code='), `la clave no va en la URL: ${url}`);
    assert.ok(!url.includes(CLAVE), 'ni suelta por ahi');
    assert.ok(url.includes('tangoPath=Api%2FGet') || url.includes('tangoPath=Api/Get'), url);
});

test('sin clave falla al armarlo, antes de salir a la red', async () => {
    // Azure contestaria 401 y el error se leeria como un fallo de Tango, que
    // manda a buscar el problema al lado equivocado.
    const { llamadas, fake } = espia(() => sobre({}));
    assert.throws(
        () => fetchPorProxy(URL_BASE, { fetchImpl: fake }),
        /falta la clave de la funcion/,
    );
    assert.strictEqual(llamadas.length, 0, 'no se salio a la red');
});

test('contra localhost no se exige clave: el runtime local no las valida', () => {
    assert.doesNotThrow(() => fetchPorProxy('http://localhost:7071/api/testTangoConnection'));
    assert.doesNotThrow(() => fetchPorProxy('http://127.0.0.1:7071/api/testTangoConnection'));
});

test('la clave tambien puede venir por opcion o por TANGO_PROXY_KEY', async () => {
    const sinCode = URL_BASE;
    const { llamadas, fake } = espia(() => sobre({ resultData: { list: [] } }));

    const tango = tangoClient.crear({ baseUrl: 'http://tango:17000', apiKey: 'k', fetchImpl: fetchPorProxy(sinCode, { fetchImpl: fake, clave: 'por-opcion' }) });
    await tango.get({ process: 2941, pages: 1 });
    assert.strictEqual(llamadas[0].opciones.headers['x-functions-key'], 'por-opcion');

    process.env.TANGO_PROXY_KEY = 'por-entorno';
    try {
        assert.doesNotThrow(() => fetchPorProxy(sinCode, { fetchImpl: fake }));
    } finally {
        delete process.env.TANGO_PROXY_KEY;
    }
});

test('la clave de la URL no se lleva puestos los otros params del proxy', async () => {
    const { llamadas, fake } = espia(() => sobre({ resultData: { list: [] } }));
    const conExtra = `${URL_BASE}?code=${CLAVE}&traza=1`;
    const tango = tangoClient.crear({ baseUrl: 'http://tango:17000', apiKey: 'k', fetchImpl: fetchPorProxy(conExtra, { fetchImpl: fake }) });
    await tango.get({ process: 2941, pages: 1 });
    assert.ok(llamadas[0].url.includes('traza=1'), llamadas[0].url);
});
