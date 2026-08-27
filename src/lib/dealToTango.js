'use strict';

const firmaHubSpot = require('./firmaHubSpot');
const etapas = require('./etapas');
const verificarPedido = require('./verificarPedido');
const altaCliente = require('./altaCliente');
const { silencioso } = require('./logger');
const procesos = require('../../config/tango.processes.json');
const mapeoPedidos = require('../../config/mapeo.pedidos.json');

/**
 * Fase 4 — negocio ganado en HubSpot -> pedido en Tango.
 *
 * La logica vive aca y no en la funcion HTTP para poder testear el circuito
 * entero sin levantar Azure ni tocar la red: todo lo que sale afuera entra por
 * `hs` y `tango`, que en los tests son dobles.
 *
 * El orden de los controles es el de ARQUITECTURA.md 10.2 y va de mas barato a
 * mas caro. Importa: la funcion es anonima y llegan peticiones por TODO cambio
 * de etapa, asi que rechazar lo que no corresponde tiene que costar casi nada.
 *
 *   1. firma v3          -> 401. Un HMAC, sin red.      ┐ `admitir`, en el
 *   2. timestamp < 5 min -> 401. Anti-replay, sin red.  │ webhook: contesta
 *   3. etapa ganada      -> 204. Filtra el volumen.     ┘ y encola (riesgo 5)
 *   4. ya tiene pedido   -> Idempotencia (9.3).         ┐ `procesarDeal`, en
 *   5. recien aca se trabaja.                           ┘ el worker de la cola
 *
 * El corte entre 3 y 4 no es casual: hasta el 3 no hay una sola llamada de red,
 * y del 4 en adelante son todas. Ahi entra la cola (`lib/cola`).
 */

const PROP_NRO = mapeoPedidos._meta.claveIdempotencia.hubspot;
const PROP_CREADO = 'tango_pedido_creado';
const PROP_PROBLEMA = 'tango_pedido_problema';
const PROP_CLIENTE = 'tango_pedido_cliente';

/** Lo que hace falta leer del Deal, la company y cada linea. */
const PROPS_DEAL = ['dealname', 'dealstage', 'pipeline', 'closedate', 'hs_object_id', PROP_NRO];
const PROPS_COMPANY = ['codigo_tango', 'tango_id_gva14', 'tango_id_gva01', 'tango_id_gva10', 'tango_id_gva23', 'tango_id_gva24', 'tango_id_gva05', 'hubspot_owner_id'];
const PROPS_LINEA = ['name', 'quantity', 'price', 'hs_product_id', 'hs_discount_percentage'];
const PROPS_PRODUCTO = ['name', 'hs_sku', 'tango_id_sta11'];

/**
 * Los eventos de un cuerpo de webhook que son un cambio de etapa a ganada.
 * HubSpot manda un array y puede traer varios eventos juntos.
 */
function eventosGanados(cuerpo, ganadas) {
    const lista = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
    return lista.filter((e) => e && e.propertyName === 'dealstage' && etapas.esGanada(e.propertyValue, ganadas));
}

/**
 * Valida la peticion. Devuelve que hacer con ella, sin tocar la red.
 *
 * @returns {{status:number, motivo?:string, eventos?:Array}}
 *   401 firma o timestamp; 204 nada que hacer; 200 hay trabajo.
 */
function admitir({ metodo, uri, cuerpoCrudo, headers, secreto, ahora = Date.now(), ganadas }) {
    const f = firmaHubSpot.validar({ metodo, uri, cuerpo: cuerpoCrudo, headers, secreto, ahora });
    if (!f.ok) return { status: 401, motivo: f.motivo };

    let cuerpo;
    try {
        cuerpo = JSON.parse(cuerpoCrudo);
    } catch {
        // La firma ya dio bien, asi que esto vino de HubSpot: no es un ataque,
        // es un cuerpo que no entendemos. No se reintenta.
        return { status: 204, motivo: 'el cuerpo no es JSON' };
    }

    const eventos = eventosGanados(cuerpo, ganadas);
    if (!eventos.length) return { status: 204, motivo: 'ningun cambio de etapa a ganado' };

    return { status: 200, eventos };
}

/**
 * Procesa UN negocio ganado.
 *
 * Nunca lanza por un problema de datos: eso se escribe en el Deal
 * (`tango_pedido_problema`) para que comercial lo vea sin entrar a los logs de
 * Azure. Solo se propaga lo que es una falla de verdad —el ERP caido, HubSpot
 * rechazando— porque eso si conviene que HubSpot lo reintente.
 *
 * @returns {Promise<{dealId, estado, nroPedido?, motivo?, problemas?}>}
 *   estado: 'creado' | 'ya-tenia' | 'incompleto' | 'dry-run'
 */
async function procesarDeal({ dealId, hs, tango, lookups, estrategiaNumeracion, log = silencioso, dryRun = true, ahora = new Date() }) {
    // 4. Idempotencia. Es lo primero que se lee: un Deal que ya tiene pedido no
    //    justifica ninguna otra llamada.
    const deal = await hs.objeto('deals', dealId, PROPS_DEAL);
    if (!deal) return { dealId, estado: 'incompleto', motivo: 'el negocio no existe en HubSpot' };

    const yaTiene = deal.properties?.[PROP_NRO];
    if (yaTiene && String(yaTiene).trim()) {
        log.paso('DEAL', `${dealId} ya tiene el pedido ${yaTiene}; no se manda de nuevo`);
        return { dealId, estado: 'ya-tenia', nroPedido: String(yaTiene).trim() };
    }

    // 5. Recien aca se gasta en lecturas.
    const [idsCompany, idsLinea] = await Promise.all([
        hs.asociaciones('deals', dealId, 'companies'),
        hs.asociaciones('deals', dealId, 'line_items'),
    ]);

    const [companies, lineItems] = await Promise.all([
        idsCompany.length ? hs.objetos('companies', [idsCompany[0]], PROPS_COMPANY) : [],
        hs.objetos('line_items', idsLinea, PROPS_LINEA),
    ]);

    const idsProducto = [...new Set(lineItems.map((l) => l.properties?.hs_product_id).filter(Boolean).map(String))];
    const productos = new Map(
        (await hs.objetos('products', idsProducto, PROPS_PRODUCTO)).map((p) => [String(p.id), p.properties || {}])
    );

    const company = companies[0] || null;
    const companyProps = company?.properties || null;

    const v = verificarPedido.verificar({
        deal: { ...deal.properties, id: dealId },
        company: companyProps,
        lineItems,
        productos,
        lookups,
    });

    // El cliente todavia no existe en el ERP: se crea antes del pedido y la
    // company queda con su COD_GVA14, asi que la proxima vez ya no hace falta.
    let cliente = v.cliente;
    if (v.cliente.faltaAlta) {
        log.paso('DEAL', `la empresa ${company.id} no esta creada en Tango; se da de alta antes del pedido`);
        const alta = await altaCliente.crear({
            tango, hs, lookups,
            companyId: company.id,
            propiedades: companyProps,
            estrategia: estrategiaNumeracion,
            log, dryRun, ahora,
        });

        if (!alta.creado) {
            const motivo = dryRun
                ? `(dry-run) la empresa se habria creado como ${alta.codigo}`
                : `no se pudo crear la empresa en Tango: ${alta.problemas.map((p) => `${p.campo} ${p.motivo}`).join('; ')}`;
            if (!dryRun) await marcarProblema(hs, dealId, motivo, log, dryRun);
            return { dealId, estado: dryRun ? 'dry-run' : 'incompleto', motivo, problemas: alta.problemas };
        }

        cliente = { idGva14: alta.idGva14, codigo: alta.codigo, faltaAlta: false };
        v.payload.ID_GVA14 = alta.idGva14;
    }

    if (!v.ok) {
        const motivo = v.problemas.map((p) => `${p.campo}: ${p.motivo}`).join(' | ');
        log.aviso('DEAL', `${dealId} incompleto -> ${motivo}`);
        await marcarProblema(hs, dealId, motivo, log, dryRun);
        return { dealId, estado: 'incompleto', motivo, problemas: v.problemas };
    }

    if (dryRun) {
        log.aviso('DRY-RUN', `no se crea el pedido. Payload: ${JSON.stringify(v.payload).slice(0, 400)}`);
        return { dealId, estado: 'dry-run', payload: v.payload };
    }

    // 6. El pedido.
    const respuesta = await tango.create(procesos.entidades.pedidos.process, v.payload);
    const nroPedido = numeroDePedido(respuesta) ?? String(deal.properties.hs_object_id ?? dealId);

    // 7. Escritura de vuelta. Va SIEMPRE que el alta haya salido bien: es la
    //    unica marca de que este Deal ya se mando.
    await hs.actualizarObjeto('deals', dealId, {
        [PROP_NRO]: nroPedido,
        [PROP_CREADO]: Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()),
        [PROP_CLIENTE]: cliente.codigo || '',
        [PROP_PROBLEMA]: '',
    });

    log.paso('DEAL-OK', `${dealId} -> pedido ${nroPedido} en Tango (cliente ${cliente.codigo})`);
    return { dealId, estado: 'creado', nroPedido, cliente: cliente.codigo };
}

/**
 * El numero que devuelve Tango al crear el pedido. La respuesta de Api/Create
 * no tiene una forma unica documentada, asi que se buscan los nombres vistos y
 * si no aparece ninguno se cae al ID del Deal, que ya es unico y no colisiona
 * (decision de Matias 2026-08-25).
 */
function numeroDePedido(respuesta) {
    const r = respuesta?.value ?? respuesta?.resultData ?? respuesta ?? {};
    for (const k of ['NRO_PEDIDO', 'NRO_COMP', 'ID_GVA21', 'id']) {
        if (r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '') return String(r[k]).trim();
    }
    return null;
}

/** Deja escrito en el Deal por que no se pudo, para que se vea sin logs. */
async function marcarProblema(hs, dealId, motivo, log, dryRun) {
    if (dryRun) return;
    try {
        await hs.actualizarObjeto('deals', dealId, { [PROP_PROBLEMA]: String(motivo).slice(0, 600) });
    } catch (e) {
        // Que no se pueda anotar el problema no puede convertirse en un
        // problema mayor: ya esta logueado.
        log.aviso('DEAL', `no se pudo escribir el problema en el negocio ${dealId}: ${e.message}`);
    }
}

/**
 * Lo que necesita el WEBHOOK, que es mucho menos que lo que necesita el worker.
 *
 * Desde que el trabajo se encola (riesgo 5), el hook no habla con Tango: valida
 * la firma y encola. Pedirle igual las variables de Tango lo haria fallar con
 * 500 —y HubSpot reintentaria— por una configuracion que no iba a usar.
 *
 * `HUBSPOT_TOKEN` es opcional a proposito: solo sirve para leer los pipelines y
 * descubrir etapas ganadas nuevas. Sin el se usan las conocidas (`etapas.GANADAS`)
 * y el hook sigue contestando, que es su unica obligacion.
 */
function leerConfigWebhook(env = process.env) {
    if (!env.HUBSPOT_CLIENT_SECRET) throw new Error('Faltan variables de entorno: HUBSPOT_CLIENT_SECRET');
    return {
        HUBSPOT_CLIENT_SECRET: env.HUBSPOT_CLIENT_SECRET,
        HUBSPOT_TOKEN: env.HUBSPOT_TOKEN || null,
        // El interruptor esta en la puerta y en un solo lugar: si esta apagado
        // no se encola nada. El worker NO lo mira — apagarlo con mensajes ya en
        // la cola los borraria en silencio.
        HABILITADO: String(env.DEAL_TO_TANGO_ENABLED || 'false').toLowerCase() === 'true',
    };
}

function leerConfig(env = process.env) {
    const cfg = {
        TANGO_API_URL: env.TANGO_API_URL,
        TANGO_API_KEY: env.TANGO_API_KEY,
        TANGO_COMPANY: env.TANGO_COMPANY || '1',
        HUBSPOT_TOKEN: env.HUBSPOT_TOKEN,
        HUBSPOT_CLIENT_SECRET: env.HUBSPOT_CLIENT_SECRET,
        TANGO_NUMERACION: env.TANGO_NUMERACION,
        DRY_RUN: String(env.SYNC_DRY_RUN ?? 'true').toLowerCase() !== 'false',
    };
    const faltan = ['TANGO_API_URL', 'TANGO_API_KEY', 'HUBSPOT_TOKEN', 'HUBSPOT_CLIENT_SECRET'].filter((k) => !cfg[k]);
    if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    return cfg;
}

module.exports = {
    admitir, procesarDeal, eventosGanados, numeroDePedido, leerConfig, leerConfigWebhook,
    PROP_NRO, PROP_CREADO, PROP_PROBLEMA, PROP_CLIENTE,
    PROPS_DEAL, PROPS_COMPANY, PROPS_LINEA, PROPS_PRODUCTO,
};
