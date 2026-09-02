'use strict';

/**
 * El freno de las pruebas: que el circuito de negocios actue SOLO sobre los
 * negocios de determinados owners (pedido de Matias, 2026-09-02).
 *
 * Por que existe
 * --------------
 * El webhook esta suscripto a `dealstage` del PORTAL ENTERO. El dia que se
 * haga `hs project upload`, cualquier negocio que un comercial mueva a "Cierre
 * ganado" entra al circuito. Y entrar al circuito no es inofensivo: un negocio
 * incompleto recibe una nota y **vuelve una etapa atras** (§9.9). Es decir que
 * la primera prueba punta a punta, sin este freno, le movería el embudo a gente
 * que no sabe que hay una prueba corriendo.
 *
 * `DEAL_TO_TANGO_ENABLED` no alcanza: es todo o nada. Esto es el equivalente de
 * `SYNC_PRODUCTOS_SOLO` para la Fase 4 — encendido de a poco, empezando por los
 * negocios de uno mismo.
 *
 * Que NO es
 * ---------
 * No es seguridad ni permisos: es una valvula de despliegue. Vacia (lo que
 * viene por defecto) el circuito se comporta como siempre y toma todos los
 * negocios, que es el estado final deseado.
 *
 * Donde se aplica
 * ---------------
 * En los DOS lugares que escriben en un negocio, no en uno:
 *
 *   - `dealToTango.procesarDeal`, apenas se lee el Deal y antes de la primera
 *     escritura, de la primera lectura cara y de `reportarIncompleto`.
 *   - `dealVeneno` (functions/dealWorker), que anota y retrocede la etapa por
 *     su cuenta, sin pasar por `procesarDeal`.
 *
 * Un negocio ajeno se descarta sin tocar nada: ni propiedad, ni nota, ni etapa.
 *
 * Formato: lista separada por comas de IDs de owner y/o mails, indistinto.
 *   DEAL_TO_TANGO_SOLO_OWNER=83855505
 *   DEAL_TO_TANGO_SOLO_OWNER=matias.tari@idpartners.ar,83714552
 */

const VARIABLE = 'DEAL_TO_TANGO_SOLO_OWNER';

const vacio = (v) => v === undefined || v === null || String(v).trim() === '';

/** Un id de owner de HubSpot es siempre numerico; un mail nunca lo es. */
const esId = (v) => /^\d+$/.test(String(v).trim());

/**
 * Lee el filtro del entorno.
 *
 * @returns {{activo:boolean, ids:Set<string>, mails:Set<string>, crudo:string}}
 *   `activo: false` = sin filtro = se procesan todos los negocios.
 */
function leer(env = process.env) {
    const crudo = String(env[VARIABLE] ?? '').trim();
    const partes = crudo.split(',').map((s) => s.trim()).filter(Boolean);

    return {
        activo: partes.length > 0,
        ids: new Set(partes.filter(esId)),
        mails: new Set(partes.filter((p) => !esId(p)).map((p) => p.toLowerCase())),
        crudo,
    };
}

/**
 * ¿Este negocio entra?
 *
 * @param {object}   p
 * @param {object}   p.filtro     lo que devuelve `leer`
 * @param {string}   p.ownerId    `hubspot_owner_id` del Deal
 * @param {Map|object} [p.owners] id de owner -> mail, para los mails del filtro
 * @returns {{admite:boolean, motivo?:string}}
 */
function admite({ filtro, ownerId, owners = null } = {}) {
    if (!filtro || !filtro.activo) return { admite: true };

    // Un negocio sin owner NO entra cuando el filtro esta puesto. Es la
    // decision conservadora y la unica coherente: el filtro dice "solo los
    // mios", y uno sin dueño no es de nadie. Al revés —dejarlo pasar— es
    // exactamente el negocio huerfano de comercial que no se quiere tocar.
    if (vacio(ownerId)) {
        return { admite: false, motivo: `el negocio no tiene owner y ${VARIABLE} esta puesto` };
    }

    const id = String(ownerId).trim();
    if (filtro.ids.has(id)) return { admite: true };

    if (filtro.mails.size) {
        const mail = String(mailDe(owners, id) || '').trim().toLowerCase();
        if (mail && filtro.mails.has(mail)) return { admite: true };
    }

    return { admite: false, motivo: `el owner ${id} no esta en ${VARIABLE}` };
}

/** La tabla de owners se acepta como Map o como objeto, igual que en verificarEmpresa. */
function mailDe(owners, id) {
    if (!owners) return null;
    return (typeof owners.get === 'function' ? owners.get(String(id)) : owners[String(id)]) || null;
}

/**
 * ¿Hace falta leer la tabla de owners para resolver este filtro?
 *
 * Solo si tiene mails. Con IDs sueltos —lo normal— el filtro no gasta una sola
 * llamada de red, y eso importa: corre en el camino caliente de cada mensaje.
 */
function necesitaOwners(filtro) {
    return Boolean(filtro && filtro.activo && filtro.mails.size);
}

/** Una linea para el log de arranque, que diga con que quedo configurado. */
function descripcion(filtro) {
    if (!filtro || !filtro.activo) return 'todos los negocios';
    return `SOLO los negocios de: ${filtro.crudo}`;
}

module.exports = { leer, admite, necesitaOwners, descripcion, VARIABLE };
