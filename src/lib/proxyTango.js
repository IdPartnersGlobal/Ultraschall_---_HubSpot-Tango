'use strict';

/**
 * Deja que los scripts corran contra el proxy desplegado, desde cualquier
 * maquina.
 *
 * Tango solo acepta trafico desde la IP de la Function App (ARQUITECTURA.md
 * 5.6), asi que todo script que use tangoClient tiene que correr DENTRO de
 * Azure... o pegarle al proxy, que si esta ahi adentro. Hasta ahora eso se
 * hacia a mano con curl, una consulta por vez.
 *
 * Esto es un `fetchImpl` que traduce. tangoClient sigue creyendo que le habla
 * a Tango:
 *
 *     http://138.99.6.77:17000/Api/Get?process=2941&pages=1
 *     -> https://<funcion>/api/testTangoConnection?tangoPath=Api/Get&process=2941&pages=1
 *
 * Dos detalles que hay que respetar para que tangoClient no se entere:
 *
 *   1. El proxy ENVUELVE la respuesta en { status, proxyTarget, result }.
 *      Se devuelve `result` pelado, que es lo que contesto Tango.
 *   2. La API key la pone el proxy con la suya. La de aca no viaja: mandarla
 *      seria filtrar la credencial del ERP en la query de otro endpoint (10.0).
 *
 * La clave de la funcion
 * ----------------------
 * Desde el 2026-09-16 el proxy pide clave (`authLevel: 'function'`). Se pasa de
 * las dos formas de siempre y las dos terminan igual:
 *
 *   - En la URL, tal cual la copia el portal: `...?code=<clave>`. Se la saca de
 *     la query y se manda como header `x-functions-key`, para que la credencial
 *     no quede escrita en la URL de cada request ni en los logs de red.
 *   - Como opcion `clave`, o en `TANGO_PROXY_KEY`.
 *
 * Sin clave Azure contesta 401 y eso se lee como un fallo de Tango, que manda a
 * buscar el problema al lado equivocado: por eso falta la clave falla al armar
 * el fetch, antes de salir a la red. Contra localhost no se exige — el runtime
 * local no valida claves y ahi el proxy se usa para depurar.
 *
 * Lo que el proxy bloquea por politica (lib/politicaProxy) sigue bloqueado:
 * esto no es una puerta de atras, es el mismo endpoint con otra sintaxis. Un
 * process fuera del catalogo necesita TANGO_PROXY_MODO=relevamiento igual.
 */

const TIMEOUT_MS = 240000; // Azure corta la funcion en 230s; esperamos un poco mas para ver el 504.

/** Respuesta del proxy cuando la politica no deja pasar la consulta. */
class ProxyBloqueado extends Error {
    constructor(motivo, modo) {
        super(`El proxy no reenvio la consulta: ${motivo}${modo ? ` (modo=${modo})` : ''}`);
        this.name = 'ProxyBloqueado';
        this.motivo = motivo;
        this.modo = modo;
    }
}

/**
 * @param {string} urlProxy  URL completa de la funcion testTangoConnection.
 * @returns {Function} fetchImpl para pasarle a tangoClient.crear().
 */
function fetchPorProxy(urlProxy, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, clave = null } = {}) {
    if (!urlProxy) throw new Error('proxyTango: falta la URL del proxy');

    // La clave puede venir en la URL (`?code=`), como opcion o en el entorno.
    // Se resuelve UNA vez, aca, y no en cada request.
    const base = new URL(urlProxy);
    const claveDeLaUrl = base.searchParams.get('code');
    base.searchParams.delete('code');
    const claveFuncion = clave || claveDeLaUrl || process.env.TANGO_PROXY_KEY || null;
    if (!claveFuncion && !esLocal(base)) {
        throw new Error(
            'proxyTango: falta la clave de la funcion. El proxy dejo de ser anonimo el 2026-09-16 (10.0): '
            + 'pasa la URL con su `?code=...` (portal de Azure -> la funcion -> "Obtener URL") o pone TANGO_PROXY_KEY.',
        );
    }

    return async function fetchTraducido(urlTango, opciones = {}) {
        const origen = new URL(urlTango);

        // De '/Api/Get' sale 'Api/Get'. El proxy lo espera sin la barra.
        const tangoPath = origen.pathname.replace(/^\/+/, '');

        const destino = new URL(base);
        destino.searchParams.set('tangoPath', tangoPath);
        for (const [k, v] of origen.searchParams) destino.searchParams.append(k, v);

        // La credencial de Tango NO se reenvia: la pone el proxy. La que si
        // viaja es la de la funcion, y va en el header y no en la URL.
        const headers = { 'Content-Type': 'application/json' };
        if (claveFuncion) headers['x-functions-key'] = claveFuncion;

        const res = await fetchImpl(destino.toString(), {
            method: opciones.method || 'GET',
            headers,
            body: opciones.body,
            signal: opciones.signal || AbortSignal.timeout(timeoutMs),
        });

        const texto = await res.text();

        let sobre;
        try {
            sobre = JSON.parse(texto);
        } catch {
            // El 504 de Azure es HTML. Que llegue tal cual: tangoClient lo reporta.
            return new Response(texto, { status: res.status, headers: { 'Content-Type': 'text/html' } });
        }

        if (sobre && sobre.status === 'blocked') throw new ProxyBloqueado(sobre.motivo, sobre.modo);

        // 'fail' es Tango contestando fuera de 2xx: se devuelve su cuerpo y su codigo.
        if (sobre && sobre.status === 'fail') {
            return new Response(sobre.tangoRawResponse ?? texto, {
                status: sobre.statusCode || res.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // 'error' es el proxy sin poder llegar a Tango. No es una respuesta de Tango.
        if (sobre && sobre.status === 'error') {
            throw new Error(`El proxy no pudo llegar a Tango: ${sobre.details || sobre.message}`);
        }

        const cuerpo = Object.prototype.hasOwnProperty.call(sobre || {}, 'result') ? sobre.result : sobre;

        return new Response(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo), {
            status: res.status,
            headers: { 'Content-Type': 'application/json' },
        });
    };
}

/** El runtime local no valida claves de funcion; Azure si. */
function esLocal(url) {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

module.exports = { fetchPorProxy, ProxyBloqueado, TIMEOUT_MS };
