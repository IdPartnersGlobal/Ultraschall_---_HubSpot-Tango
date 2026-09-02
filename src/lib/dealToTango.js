'use strict';

const firmaHubSpot = require('./firmaHubSpot');
const etapas = require('./etapas');
const verificarPedido = require('./verificarPedido');
const altaCliente = require('./altaCliente');
const verificarEmpresa = require('./verificarEmpresa');
const notaProblema = require('./notaProblema');
const soloOwner = require('./soloOwner');
const { silencioso } = require('./logger');
const procesos = require('../../config/tango.processes.json');
const mapeoPedidos = require('../../config/mapeo.pedidos.json');
const defaults = require('../../config/defaults.tango.json');

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
const PROPS_DEAL = ['dealname', 'dealstage', 'pipeline', 'closedate', 'hs_object_id', 'hubspot_owner_id', PROP_NRO];
/**
 * Lo que hay que leer de la company. NO se escribe a mano: la parte del alta se
 * DERIVA del catalogo (`verificarEmpresa.propiedadesQueNecesita`).
 *
 * ⚠️ Escrita a mano, esta lista tenia 8 propiedades y ninguna de las 12 con
 * datos del negocio. `razon_social` y `condicion_iva` llegaban `undefined`
 * aunque estuvieran cargadas, asi que NINGUN negocio podia dar de alta su
 * empresa — el 100% frenaba con "RAZON_SOCI: falta", apuntando a un dato que si
 * estaba. Ver §9.16.
 */
const PROPS_COMPANY = [...new Set([
    // Lo que necesita el circuito del PEDIDO: el vinculo con el cliente de Tango.
    'codigo_tango', 'tango_codigo_cliente', 'tango_id_gva14',
    // Lo que necesita el ALTA, derivado del catalogo para que no se desfase.
    ...verificarEmpresa.propiedadesQueNecesita(),
])];
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
 *   avisos: cosas que el pedido lleva y hay que saber, no cosas que falten
 */
async function procesarDeal({ dealId, hs, tango, lookups, estrategiaNumeracion, filtroOwner = null, owners = null, log = silencioso, dryRun = true, ahora = new Date() }) {
    // 4. Idempotencia. Es lo primero que se lee: un Deal que ya tiene pedido no
    //    justifica ninguna otra llamada.
    const deal = await hs.objeto('deals', dealId, PROPS_DEAL);
    if (!deal) return { dealId, estado: 'incompleto', motivo: 'el negocio no existe en HubSpot' };

    // 4b. El freno de las pruebas (lib/soloOwner). Va ACA —despues de leer el
    //     Deal, que es lo unico que hace falta para decidir, y antes de TODO lo
    //     demas— porque el riesgo no es gastar red: es que un negocio ajeno e
    //     incompleto reciba una nota y vuelva una etapa atras (§9.9). Un
    //     negocio que no entra se descarta sin tocarlo.
    const permitido = soloOwner.admite({ filtro: filtroOwner, ownerId: deal.properties?.hubspot_owner_id, owners });
    if (!permitido.admite) {
        log.paso('DEAL', `${dealId} no se toca: ${permitido.motivo}`);
        return { dealId, estado: 'ajeno', motivo: permitido.motivo };
    }

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

    // Los avisos no frenan nada, pero tienen que verse: hoy el unico es que el
    // renglon va con el articulo de prueba (§9.6), y un pedido que sale con un
    // articulo que no es el que se vendio no puede pasar en silencio.
    for (const a of v.avisos || []) log.aviso('PEDIDO', `${dealId}: ${a.motivo}`);

    // El cliente todavia no existe en el ERP: se crea antes del pedido y la
    // company queda con su COD_GVA14, asi que la proxima vez ya no hace falta.
    let cliente = v.cliente;
    let avisosDelAlta = [];
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
            if (dryRun) {
                const motivo = `(dry-run) la empresa se habria creado como ${alta.codigo}`;
                return { dealId, estado: 'dry-run', motivo, problemas: alta.problemas };
            }
            // Los campos que le faltan a la EMPRESA se reportan igual que los
            // del negocio: la persona que los tiene que cargar es la misma y no
            // tiene por que saber de que lado del circuito falto el dato.
            const r = await reportarIncompleto({
                hs, dealId, etapaActual: deal.properties?.dealstage,
                problemas: alta.problemas, log, dryRun, ahora,
            });
            return { dealId, estado: 'incompleto', motivo: r.motivo, problemas: alta.problemas, retroceso: r.retroceso };
        }

        cliente = { idGva14: alta.idGva14, codigo: alta.codigo, faltaAlta: false };
        v.payload.ID_GVA14 = alta.idGva14;
        avisosDelAlta = alta.avisos || [];
    }

    if (!v.ok) {
        const r = await reportarIncompleto({
            hs, dealId, etapaActual: deal.properties?.dealstage,
            problemas: v.problemas, log, dryRun, ahora,
        });
        log.aviso('DEAL', `${dealId} incompleto -> ${r.motivo}`);
        return { dealId, estado: 'incompleto', motivo: r.motivo, problemas: v.problemas, retroceso: r.retroceso };
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

    // El cliente se creo con lo minimo (9.10): lo que quedo con un default o
    // sin cargar tiene que llegarle a alguien. NO frena ni mueve la etapa: el
    // pedido ya esta en el ERP.
    if (avisosDelAlta.length) {
        await anotarACompletar({ hs, dealId, avisos: avisosDelAlta, cliente, log, ahora });
    }

    log.paso('DEAL-OK', `${dealId} -> pedido ${nroPedido} en Tango (cliente ${cliente.codigo})`);
    return { dealId, estado: 'creado', nroPedido, cliente: cliente.codigo, avisos: v.avisos, aCompletar: avisosDelAlta };
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
/**
 * Un negocio que no se puede mandar a Tango: se deja dicho QUE falta y se
 * devuelve el negocio una etapa atras (§9.9, pedido de Matias 2026-08-28).
 *
 * Tres escrituras, en este orden y por este motivo:
 *
 *   1. `tango_pedido_problema` — la marca que lee el circuito y que se limpia
 *      sola cuando el pedido finalmente sale.
 *   2. La NOTA — lo que ve comercial. Va ANTES de mover la etapa, para que el
 *      negocio nunca se mueva antes de que exista la explicacion.
 *   3. La etapa. Se mueve AUNQUE la nota haya fallado: el motivo ya quedo en
 *      `tango_pedido_problema` (paso 1), y dejar el negocio en "Cierre ganado"
 *      sin pedido es peor — parece cerrado y no lo esta.
 *
 * ⚠️ Mover la etapa DISPARA EL WEBHOOK otra vez: esta suscripto a `dealstage`.
 * No es un bucle porque se retrocede a una etapa abierta y el control 3 la
 * descarta sin gastar red. `etapas.anterior` ademas se saltea las ganadas.
 *
 * ⚠️ La cola es at-least-once (§9.5). La guarda contra duplicar la nota y
 * retroceder DOS etapas no es un flag propio: es que el negocio ya no esta en
 * una etapa ganada. En la re-entrega, `procesarDeal` relee el Deal y lo ve.
 *
 * Ninguna de las tres puede tumbar el proceso: el problema ya esta logueado, y
 * fallar al reportar no puede convertirse en un problema mayor.
 */
async function reportarIncompleto({ hs, dealId, etapaActual, problemas = [], tipo = 'datos', log = silencioso, dryRun = true, ahora = new Date() }) {
    const motivo = notaProblema.resumen({ problemas });

    if (dryRun) {
        log.aviso('DRY-RUN', `${dealId}: no se anota ni se retrocede la etapa. Falta: ${motivo}`);
        return { motivo, nota: false, retroceso: null };
    }

    await marcarProblema(hs, dealId, motivo, log, dryRun);

    // De los embudos salen las dos cosas: cuales son las etapas ganadas y cual
    // es la anterior. Una sola llamada, y solo en el camino de error.
    let pipelines = [];
    try {
        pipelines = await hs.pipelines('deals');
    } catch (e) {
        log.aviso('DEAL', `no se pudieron leer los embudos: ${e.message}. El negocio queda donde esta.`);
    }
    const ganadas = etapas.desdePipelines(pipelines);

    if (!etapas.esGanada(etapaActual, ganadas)) {
        // O alguien ya lo movio a mano, o este mensaje es una re-entrega. En
        // los dos casos ya se reporto: duplicar la nota y retroceder otra etapa
        // seria peor que no hacer nada.
        log.paso('DEAL', `${dealId} ya no esta en una etapa ganada; no se anota de nuevo`);
        return { motivo, nota: false, retroceso: null, yaReportado: true };
    }

    const retroceso = etapas.anterior(etapaActual, pipelines, ganadas);
    const etapaGanada = etapas.etiqueta(etapaActual, pipelines) || 'Cierre ganado';

    let nota = false;
    try {
        await hs.crearNota('deals', dealId, notaProblema.cuerpo({ problemas, retroceso, etapaGanada, tipo }), { cuando: ahora });
        nota = true;
    } catch (e) {
        log.aviso('DEAL', `no se pudo crear la nota en el negocio ${dealId}: ${e.message}`);
    }

    if (!retroceso) {
        log.aviso('DEAL', `${dealId}: no hay etapa anterior a la que volver; queda en '${etapaGanada}'`);
        return { motivo, nota, retroceso: null };
    }

    try {
        await hs.actualizarObjeto('deals', dealId, { dealstage: retroceso.id });
        log.paso('DEAL', `${dealId} vuelve a '${retroceso.label}' hasta que este completo`);
        return { motivo, nota, retroceso };
    } catch (e) {
        log.aviso('DEAL', `no se pudo mover el negocio ${dealId} a '${retroceso.label}': ${e.message}`);
        return { motivo, nota, retroceso: null };
    }
}

/**
 * Un negocio que agoto los reintentos (cola de veneno, §9.9).
 *
 * Vive ACA y no en `functions/dealWorker` por una razon concreta: lo que hace
 * es una decision —anotar y retroceder la etapa de un negocio— y `src/functions`
 * no tiene tests, son envoltorios de Azure. La fuga que esto cierra es que
 * `dealVeneno` escribe POR SU CUENTA, sin pasar por `procesarDeal`, asi que el
 * freno de las pruebas tenia ahi una puerta de atras: la que le mueve la etapa
 * a un negocio de comercial cuando el ERP se cae.
 *
 * No reintenta nada. Solo deja constancia, y solo si el negocio entra.
 */
async function procesarVeneno({ hs, dealId, filtroOwner = null, owners = null, log = silencioso, dryRun = true, ahora = new Date() }) {
    // ⚠️ El texto viejo decia "volver a guardar el negocio para reintentar". Es
    // FALSO: el webhook escucha el cambio de ETAPA y nada mas.
    const problemas = [{
        campo: 'Tango',
        motivo: 'el pedido no se pudo crear despues de varios intentos: el ERP no respondio, o rechazo la operacion',
        comoSeArregla: 'no hay nada que cargar en el negocio. Avisar a sistemas y, cuando Tango vuelva, mover el negocio a la etapa de ganado otra vez',
    }];

    // Hace falta la etapa actual: es lo que evita retroceder dos veces si el
    // mismo negocio cae en veneno mas de una vez. Y el owner, para el freno.
    const deal = await hs.objeto('deals', dealId, ['dealstage', 'hubspot_owner_id']);

    const permitido = soloOwner.admite({ filtro: filtroOwner, ownerId: deal?.properties?.hubspot_owner_id, owners });
    if (!permitido.admite) {
        log.paso('VENENO', `${dealId} no se toca: ${permitido.motivo}`);
        return { dealId, estado: 'ajeno', motivo: permitido.motivo };
    }

    const r = await reportarIncompleto({
        hs, dealId,
        etapaActual: deal?.properties?.dealstage,
        problemas,
        tipo: 'tecnico',
        log,
        // Se respeta el dry-run: en ese modo no se mando nada a Tango, asi que
        // tampoco se toca el negocio. La senal queda en el log.
        dryRun, ahora,
    });
    return { dealId, estado: 'reportado', ...r };
}

/**
 * El cliente se creo, el pedido salio, y hay datos que quedaron con un default
 * o vacios (§9.10). Eso NO es un error: es trabajo pendiente de comercial.
 *
 * Por eso deja SOLO una nota. No escribe `tango_pedido_problema` —no hubo
 * problema— y sobre todo no mueve la etapa: el negocio se gano y el pedido
 * existe. Mover un negocio ya facturado seria mentirle al embudo.
 */
async function anotarACompletar({ hs, dealId, avisos, cliente, log = silencioso, ahora = new Date() }) {
    try {
        await hs.crearNota('deals', dealId, notaProblema.cuerpoACompletar({ avisos, cliente }), { cuando: ahora });
        log.paso('DEAL', `${dealId}: quedan ${avisos.length} datos por completar en la empresa`);
    } catch (e) {
        log.aviso('DEAL', `no se pudo dejar la nota de datos a completar en ${dealId}: ${e.message}`);
    }
}

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
        // La estrategia ya no es una pregunta abierta: Matias eligio
        // `correlativo` el 2026-08-27 y la decision vive en el catalogo, que
        // esta versionado. El entorno la puede pisar sin desplegar (§7.6).
        TANGO_NUMERACION: env.TANGO_NUMERACION || defaults.clientes.numeracion.estrategia,
        DRY_RUN: String(env.SYNC_DRY_RUN ?? 'true').toLowerCase() !== 'false',
        // El freno de las pruebas. Vacio = todos los negocios, que es el estado
        // final; puesto = solo los de esos owners (lib/soloOwner). Lo lee el
        // WORKER y no el webhook: el evento de HubSpot no trae el owner, asi
        // que para filtrar en la puerta habria que leer el Deal, y eso es
        // exactamente lo que el hook no puede hacer (riesgo 5).
        SOLO_OWNER: soloOwner.leer(env),
    };
    const faltan = ['TANGO_API_URL', 'TANGO_API_KEY', 'HUBSPOT_TOKEN', 'HUBSPOT_CLIENT_SECRET'].filter((k) => !cfg[k]);
    if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
    return cfg;
}

module.exports = {
    admitir, procesarDeal, procesarVeneno, eventosGanados, numeroDePedido, reportarIncompleto, anotarACompletar, leerConfig, leerConfigWebhook,
    soloOwner,
    PROP_NRO, PROP_CREADO, PROP_PROBLEMA, PROP_CLIENTE,
    PROPS_DEAL, PROPS_COMPANY, PROPS_LINEA, PROPS_PRODUCTO,
};
