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
 *      seria filtrar la credencial del ERP a un endpoint anonimo (10.0).
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
function fetchPorProxy(urlProxy, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
    if (!urlProxy) throw new Error('proxyTango: falta la URL del proxy');

    return async function fetchTraducido(urlTango, opciones = {}) {
        const origen = new URL(urlTango);

        // De '/Api/Get' sale 'Api/Get'. El proxy lo espera sin la barra.
        const tangoPath = origen.pathname.replace(/^\/+/, '');

        const destino = new URL(urlProxy);
        destino.searchParams.set('tangoPath', tangoPath);
        for (const [k, v] of origen.searchParams) destino.searchParams.append(k, v);

        // La credencial de Tango NO se reenvia: la pone el proxy.
        const headers = { 'Content-Type': 'application/json' };

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

module.exports = { fetchPorProxy, ProxyBloqueado, TIMEOUT_MS };
