'use strict';

const mapeoClientes = require('../../config/mapeo.clientes.json');
const enCastellano = require('./enCastellano');

/**
 * Traduce un rechazo de Tango a un problema que comercial pueda arreglar.
 *
 * Por que existe (2026-09-02, §9.17)
 * ----------------------------------
 * El primer alta real murio asi:
 *
 *     Tango rechazo la consulta: El campo 'LOCALIDAD' debe ser menor o igual
 *     a 20 caracteres.
 *
 * Eso es **un dato que comercial arregla en diez segundos**, pero salia por el
 * camino de las fallas tecnicas: la excepcion se propagaba desde `procesarDeal`,
 * la COLA la reintentaba —at-least-once, y cada intento cuesta ~113 s porque
 * relee el padron— y despues de agotarse caia en veneno con una nota que dice
 * *"no hay nada que cargar en el negocio, avisar a sistemas"*.
 *
 * Las tres cosas estan mal a la vez: es reintentar lo que **nunca** va a andar,
 * gastando dos minutos por vuelta, para terminar mandando a la persona
 * equivocada a arreglar algo que no esta roto.
 *
 * `tangoClient` ya distingue el error de negocio del tecnico y no lo reintenta
 * (`esDeNegocio`), pero esa distincion **se perdia al salir**: arriba, un throw
 * es un throw.
 *
 * Que NO hace
 * -----------
 * No adivina limites ni los tiene hardcodeados. **Los dice Tango**, en el mismo
 * mensaje: el campo y el numero. Declarar aca un largo maximo sacado del padron
 * seria adivinar —el maximo observado es una cota inferior, no el limite— y un
 * limite declarado de menos frena datos validos.
 *
 * Tampoco recorta el valor. Recortar "Ciudad Autonoma de Buenos Aires" a 20 da
 * "Ciudad Autonoma de B": el alta saldria bien y el domicilio quedaria mal para
 * siempre. Es el mismo criterio que la opcion que el ERP no resuelve (§9.14):
 * frena, no adivina.
 */

/** Cuando Tango no responde o responde mal, no es un problema de datos. */
function esRechazoDeDatos(e) {
    if (!e || e.name !== 'TangoError') return false;
    // Mismo criterio que `tangoClient`: sin status HTTP y sin pinta de red.
    if (e.status !== undefined) return false;
    if (/timeout|fetch failed|no existe en el ERP|no es JSON/i.test(e.message || '')) return false;
    return /Tango rechazo la consulta/i.test(e.message || '');
}

/** El texto que manda Tango, sin el prefijo que le pone `tangoClient`. */
function motivoCrudo(e) {
    return String(e?.message || '').replace(/^Tango rechazo la consulta:\s*/i, '').trim();
}

/**
 * `El campo 'LOCALIDAD' debe ser menor o igual a 20 caracteres.`
 *   -> { campo: 'LOCALIDAD', maximo: 20 }
 *
 * Es el unico patron que se parsea, y a proposito: es el que aparecio. Lo que
 * no matchea igual se reporta, con el texto tal cual lo dijo el ERP.
 */
function largoExcedido(texto) {
    const m = /El campo '([^']+)' debe ser menor o igual a (\d+) caracteres/i.exec(texto || '');
    return m ? { campo: m[1], maximo: Number(m[2]) } : null;
}

/**
 * De `LOCALIDAD` a la propiedad de HubSpot que comercial tiene que tocar.
 *
 * La etiqueta la resuelve `enCastellano`, no este modulo: la planilla de
 * Ultraschall a veces la pone en `etiqueta` y a veces en `label`, y mirar una
 * sola hacia que la nota dijera "el campo 'localidad'" en minuscula, o sea el
 * nombre interno otra vez.
 */
function propiedadDeHubSpot(campoTango) {
    const c = (mapeoClientes.campos || []).find((x) => x.tango === campoTango);
    return c ? { hubspot: c.hubspot, etiqueta: enCastellano.etiqueta(campoTango, c.hubspot) } : null;
}

/**
 * @param {Error}  e            el error que tiro `tango.create`
 * @param {object} propiedades  properties de la company, para poder decir
 *                              cuanto mide de mas el valor que se mando
 * @returns {{campo, motivo, comoSeArregla}|null} null si NO es un problema de
 *          datos: eso se propaga como siempre y la cola lo reintenta.
 */
function comoProblema(e, propiedades = {}, contexto = 'alta') {
    if (!esRechazoDeDatos(e)) return null;

    // De que operacion se trata. Sin esto la nota decia SIEMPRE "el alta de la
    // empresa", tambien cuando lo que fallo era el PEDIDO — y mandaba a
    // comercial a corregir la ficha del cliente por un problema de las lineas
    // de producto. Se vio en el negocio de prueba el 2026-09-03: el ERP decia
    // "No hay existencias para RENGLON_DTO[1]" y la nota lo llamaba alta.
    const queFallo = contexto === 'pedido' ? 'el pedido' : 'el alta de la empresa';
    const donde = contexto === 'pedido' ? 'en el negocio' : 'en la empresa';

    const texto = motivoCrudo(e);
    const largo = largoExcedido(texto);

    if (largo) {
        const prop = propiedadDeHubSpot(largo.campo);
        const valor = prop ? String(propiedades[prop.hubspot] ?? '') : '';
        const cuanto = valor ? ` Ahora tiene ${valor.length}.` : '';
        const donde = prop ? `'${prop.etiqueta}'` : `'${largo.campo}'`;

        return {
            campo: largo.campo,
            motivo: `el campo ${donde} no entra en Tango: admite ${largo.maximo} caracteres.${cuanto}`,
            // Se dice que NO lo recorte el sistema: recortar una localidad la
            // deja mal para siempre y el alta saldria "bien".
            comoSeArregla: prop
                ? `acortar ${donde} en la empresa a ${largo.maximo} caracteres o menos (por ejemplo "CABA" en lugar de "Ciudad Autonoma de Buenos Aires") y volver a mover el negocio a Cierre ganado`
                : `acortar ${donde} a ${largo.maximo} caracteres o menos en la empresa y volver a mover el negocio a Cierre ganado`,
        };
    }

    // Cualquier otra regla del ERP. No se entiende el detalle, pero se sabe dos
    // cosas que alcanzan: que es un dato y no una caida, y que reintentar no
    // sirve. El texto del ERP va tal cual — es mas util que una parafrasis.
    return {
        campo: 'Tango',
        motivo: `no aceptó ${queFallo}: ${texto}`,
        comoSeArregla: `corregir ${donde} el dato que menciona el mensaje y volver a mover el negocio a Cierre ganado. Si no se entiende, avisar a sistemas`,
    };
}

module.exports = { comoProblema, esRechazoDeDatos, largoExcedido, motivoCrudo };
