'use strict';

const documento = require('./documento');
const defaults = require('../../config/defaults.tango.json');

/**
 * Verificacion previa del alta de un cliente en Tango.
 *
 * Es el riesgo 3 del circuito. "Verificar empresa" no es preguntar si existe
 * el COD_GVA14: es contestar si esta company se puede dar de alta, y si no,
 * QUE falta. La alternativa es mandar el alta y comerse el rechazo del ERP,
 * que llega como un mensaje suelto sin decir cual de los 18 campos fallo, y
 * para entonces ya se gasto el numero de la numeracion.
 *
 * Devuelve tres cosas, y la distincion entre las dos primeras es el punto:
 *
 *   problemas   lo puede arreglar una persona en HubSpot ahora mismo (falta la
 *               razon social, el CUIT esta mal, la provincia no tiene
 *               equivalencia en Tango).
 *   pendientes  no lo puede arreglar nadie desde HubSpot: falta una DECISION
 *               de administracion (que lista de precios lleva un cliente
 *               nuevo). Mezclarlo con lo anterior manda a comercial a buscar
 *               un dato que no existe.
 *   valores     los campos de Tango ya resueltos, listos para mezclar sobre
 *               los defaults. Verificar y armar el payload son la misma
 *               pasada: si fueran dos, se desincronizarian.
 *
 * ⚠️ Que campos son obligatorios sale de `config/defaults.tango.json`, no de
 * aca, y hoy es una SUPOSICION tomada del payload de ejemplo: mientras
 * `alta._verificadoContraElERP` sea false, el catalogo no fue sondeado contra
 * Tango. Vive en config a proposito, para que confirmarlo sea editar un JSON.
 *
 * No hace red. La busqueda de duplicados, que si la hace, va aparte.
 */

const ALTA = defaults.clientes.alta;

/** Vacio a los efectos del ERP: null, undefined, '' o solo espacios. */
function vacio(v) {
    return v === null || v === undefined || String(v).trim() === '';
}

function problema(campo, motivo, comoSeArregla) {
    return { campo: campo.tango, propiedad: campo.hubspot ?? null, motivo, comoSeArregla };
}

/**
 * Resuelve un campo. Devuelve { valor } si pudo, { motivo, comoSeArregla } si no,
 * o {} si no hay nada que poner y tampoco es un problema.
 */
function resolverCampo(campo, props, m, lookups) {
    const crudo = campo.hubspot ? props[campo.hubspot] : undefined;

    switch (campo.resolucion) {
        case 'texto': {
            if (!vacio(crudo)) return { valor: String(crudo).trim() };
            // Dos escapes distintos: copiar otra propiedad, o un valor fijo.
            const alterno = campo.siFalta ? props[campo.siFalta] : undefined;
            if (!vacio(alterno)) return { valor: String(alterno).trim() };
            if (campo.valorSiFalta !== undefined) return { valor: campo.valorSiFalta };
            return {};
        }

        case 'documento': {
            if (vacio(crudo)) return {};
            const texto = String(crudo).trim();
            const digitos = documento.soloDigitos(texto);

            // Un documento de 11 digitos va al formato canonico con guiones,
            // que es lo que Tango exige (decision 2026-08-18).
            if (digitos.length === 11) return { valor: documento.formatear(texto), revisar: !documento.digitoVerificadorOk(digitos) };

            // Cualquier otra cosa viaja TAL CUAL la escribieron. Decision de
            // Matias (2026-08-25): si esta mal tipeado se deja mal tipeado.
            // Normalizarlo seria inventar un documento que nadie cargo, y
            // ademas taparia el error justo cuando conviene que se vea.
            //
            // ⚠️ Va en la direccion contraria a `transforms.documentoConGuiones`,
            // que SI normaliza — pero esa corre en la lectura, donde el dato ya
            // es de Tango. Aca el dato lo tipeo una persona hace un minuto.
            if (!digitos) return { motivo: `'${texto}' no tiene ningun digito`, comoSeArregla: 'cargar el CUIT o documento en la company' };

            // Un DNI de 7 u 8 digitos es normal y no hay nada que revisar. Lo
            // que se marca es lo que no cierra como ningun documento: 10
            // digitos, o 11 con el verificador mal. El criterio es el mismo que
            // usa la lectura, asi que vive en lib/documento y no se duplica.
            const { revisar } = documento.resolver({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: texto });
            return { valor: texto, revisar, sinNormalizar: true };
        }

        case 'tipoDocumento': {
            // documento.idParaAlta piensa en registros de Tango. Una company de
            // HubSpot trae la etiqueta del desplegable, no el codigo, asi que se
            // traduce a tipo logico y de ahi al ID.
            const tipo = tipoLogicoDesdeEtiqueta(crudo, m);
            if (tipo) {
                const id = documento.TIPO_A_ID[tipo];
                if (id) return { valor: id, tipo };
                return { motivo: `no se conoce el ID_TIPO_DOCUMENTO_GV para '${tipo}'`, comoSeArregla: 'agregar el tipo a lib/documento' };
            }
            // Sin tipo elegido se infiere del numero, igual que en la lectura.
            const r = documento.idParaAlta({ COD_TIPO_DOCUMENTO_GV: 0, CUIT: props.cuit });
            if (r.ok) return { valor: r.id, tipo: r.tipo, inferido: true };

            // Ni declarado ni inferible: el numero esta mal tipeado o no es un
            // documento. NO se corrige y NO se frena el alta (decision de Matias
            // 2026-08-25): el documento viaja tal cual y el tipo va
            // SIN_IDENTIFICAR, que es una fila real de TIPO_DOCUMENTO_GV.
            if (campo.tipoSiFalta) {
                const id = documento.TIPO_A_ID[campo.tipoSiFalta];
                if (id) return { valor: id, tipo: campo.tipoSiFalta, porDefecto: true };
            }
            return {
                motivo: vacio(crudo) ? 'sin tipo de documento, y no se pudo inferir del numero' : `tipo de documento '${crudo}' desconocido`,
                comoSeArregla: 'elegir el tipo de documento en la company, o corregir el CUIT',
            };
        }

        case 'opcionInversa': {
            if (!vacio(crudo)) {
                const r = m.desdeOpcion(campo.hubspot, crudo);
                if (r.ok && r.id !== null) return { valor: r.id, codigo: r.codigo };
            }
            // La opcion no existe en Tango, o no hay opcion elegida. Antes de
            // frenar el alta se prueba el neutro que declara el catalogo — para
            // la provincia es 'Desconocido', una fila propia de GVA18.
            const alterno = porCodigo(campo, campo.codigoSiFalta, lookups);
            if (alterno) return { ...alterno, porDefecto: true };
            return {
                motivo: vacio(crudo) ? 'sin valor' : `la opcion '${crudo}' no tiene equivalencia en Tango`,
                comoSeArregla: `elegir una opcion de ${campo.hubspot} que exista en Tango`,
            };
        }

        case 'opcionLookup': {
            // El desplegable guarda la etiqueta; Tango quiere el ID interno. El
            // codigo sale del mapa `opciones` leido al reves.
            if (vacio(crudo)) return {};
            const codigo = codigoDesdeEtiqueta(campo.hubspot, crudo, m);
            if (!codigo) return { motivo: `la opcion '${crudo}' no tiene equivalencia en Tango`, comoSeArregla: `revisar las opciones de ${campo.hubspot} en el mapeo` };
            const r = lookups.resolver(campo.lookup, codigo, campo.hubspot);
            if (r.ok) return { valor: r.id, codigo };
            return { motivo: r.motivo, comoSeArregla: `revisar la tabla ${campo.lookup} en el ERP` };
        }

        default:
            // origen 'numeracion' o 'sinDefinir': no se resuelven desde la company.
            return {};
    }
}

/**
 * Codigo de Tango -> ID interno, contra la tabla viva. Devuelve null si el
 * campo no declara codigo o si la tabla no lo tiene.
 *
 * Se guarda el CODIGO en el catalogo y no el ID a proposito: el ID se resuelve
 * contra el ERP en cada corrida, asi no queda hardcodeado un numero que puede
 * cambiar (5.4). `zonas` es el ejemplo: el codigo '09' es el ID 10.
 */
function porCodigo(campo, codigo, lookups) {
    if (vacio(codigo) || !campo.lookup || !lookups) return null;
    const r = lookups.resolver(campo.lookup, codigo, campo.tango);
    return r.ok ? { valor: r.id, codigo: String(codigo) } : null;
}

/** Etiqueta del desplegable -> codigo de Tango, leyendo `opciones` al reves. */
function codigoDesdeEtiqueta(nombreHubSpot, etiqueta, m) {
    const campo = m.campos.find((c) => c.hubspot === nombreHubSpot && c.opciones);
    if (!campo) return null;
    const buscada = String(etiqueta).trim();
    for (const [codigo, valor] of Object.entries(campo.opciones)) {
        if (String(valor).trim() === buscada) return codigo;
    }
    return null;
}

/**
 * Mail del owner de la company. HubSpot guarda el ID, no el mail, asi que la
 * tabla de owners hay que leerla aparte (es una llamada de red). Se acepta
 * tambien el mail ya resuelto, para no obligar a leer owners en un test.
 */
function emailDelOwner(props, owners) {
    if (!vacio(props.hubspot_owner_email)) return props.hubspot_owner_email;
    const id = props.hubspot_owner_id;
    if (vacio(id) || !owners) return null;
    return (typeof owners.get === 'function' ? owners.get(String(id)) : owners[String(id)]) || null;
}

/** Etiqueta de `tipo_de_documento` -> tipo logico de lib/documento. */
function tipoLogicoDesdeEtiqueta(etiqueta, m) {
    if (vacio(etiqueta)) return null;
    const codigo = codigoDesdeEtiqueta('tipo_de_documento', etiqueta, m);
    // Aca el "codigo" del mapa `opciones` ES el tipo logico (CUIT, DNI, ...).
    return codigo && documento.TIPO_A_ID[codigo] ? codigo : null;
}

/**
 * @param {object} p
 * @param {object} p.propiedades  properties de la company de HubSpot
 * @param {object} p.mapper       mapper.crear(mapeoClientes, lookups)
 * @param {object} p.lookups      tablas auxiliares ya cargadas
 * @param {object} [p.decididos]  valores que administracion ya definio, por
 *                                campo de Tango: { ID_GVA10: 3, ... }
 * @param {object} [p.owners]     id de owner de HubSpot -> mail, para resolver
 *                                el vendedor. Sin esto el vendedor cae al default.
 * @returns {{ok, problemas, pendientes, valores, resueltos}}
 *
 * Nunca lanza. Una company incompleta es un informe, no una excepcion.
 */
function verificar({ propiedades = {}, mapper: m, lookups, decididos = {}, owners = null } = {}) {
    if (!m) throw new Error('verificarEmpresa: falta el mapper');

    const problemas = [];
    const pendientes = [];
    const valores = {};
    const resueltos = {};

    for (const campo of ALTA.campos) {
        // El codigo lo elige lib/numeracion, no se verifica desde la company.
        if (campo.origen === 'numeracion') continue;

        // Los campos de parametria que no vienen de HubSpot. En los tres casos
        // gana lo mas especifico que haya: lo que la company ya trae cargado
        // (vino del sync), despues lo que se pase por `decididos`, y recien al
        // final el default del catalogo.
        if (campo.origen === 'sinDefinir' || campo.origen === 'default' || campo.origen === 'owner') {
            const yaCargado = campo.hubspot ? propiedades[campo.hubspot] : undefined;
            const decidido = decididos[campo.tango];
            const explicito = !vacio(decidido) ? decidido : yaCargado;
            if (!vacio(explicito)) { valores[campo.tango] = Number(explicito); continue; }

            // El vendedor sale del owner de la company. El match NO puede ser
            // por el mail de Tango: GVA23.E_MAIL esta vacio en 26 de 27
            // vendedores, asi que la equivalencia vive en el catalogo.
            if (campo.origen === 'owner') {
                const mail = String(emailDelOwner(propiedades, owners) || '').trim().toLowerCase();
                const codigo = mail ? (campo.porOwner || {})[mail] : undefined;
                const r = porCodigo(campo, codigo, lookups);
                if (r) {
                    valores[campo.tango] = r.valor;
                    resueltos[campo.tango] = { codigo: r.codigo, porOwner: mail };
                    continue;
                }
                // Owner sin equivalencia: se sigue con el default, pero queda
                // dicho de donde salio para que no parezca un dato del owner.
                const d = porCodigo(campo, campo.codigoPorDefecto, lookups);
                if (d) {
                    valores[campo.tango] = d.valor;
                    resueltos[campo.tango] = { codigo: d.codigo, porDefecto: true, ownerSinEquivalencia: mail || null };
                    continue;
                }
            } else {
                const d = porCodigo(campo, campo.codigoPorDefecto, lookups);
                if (d) { valores[campo.tango] = d.valor; resueltos[campo.tango] = { codigo: d.codigo, porDefecto: true }; continue; }
            }

            if (campo.obligatorio) {
                pendientes.push({ campo: campo.tango, queFalta: campo.queFalta, quienLoDefine: campo.quienLoDefine || 'administracion' });
            }
            continue;
        }

        const r = resolverCampo(campo, propiedades, m, lookups);

        if (r.motivo) {
            problemas.push(problema(campo, r.motivo, r.comoSeArregla));
            continue;
        }
        if (r.valor === undefined) {
            if (campo.obligatorio) {
                problemas.push(problema(campo, 'falta', `cargar ${campo.hubspot} en la company`));
            }
            continue;
        }

        valores[campo.tango] = r.valor;
        if (r.tipo) resueltos.tipoDocumento = { tipo: r.tipo, inferido: !!r.inferido, porDefecto: !!r.porDefecto };
        if (r.codigo) resueltos[campo.tango] = { codigo: r.codigo, porDefecto: !!r.porDefecto };
        // Un documento raro no frena el alta, pero queda senalado: es lo que
        // deja que alguien lo revise despues sin tener que buscarlo.
        if (r.revisar) resueltos.documentoARevisar = { valor: r.valor, sinNormalizar: !!r.sinNormalizar };
    }

    return { ok: problemas.length === 0 && pendientes.length === 0, problemas, pendientes, valores, resueltos };
}

// ---------------------------------------------------------------- duplicados

/**
 * Un valor que va a entrar a `filtroSql` — SQL concatenado del lado del ERP
 * (ARQUITECTURA.md 10.0) — y que viene de un webhook, o sea de afuera. La
 * regla es que el filtro se arma en el codigo; esto es lo que la hace cumplir
 * cuando el dato no es nuestro.
 */
function literalSeguro(valor, patron) {
    const v = String(valor ?? '').trim();
    if (!v || !patron.test(v)) return null;
    return v;
}

const COD_SEGURO = /^[A-Za-z0-9]{1,15}$/;
const DOC_SEGURO = /^[0-9-]{7,15}$/;

/**
 * Busca en Tango si el cliente ya existe. Por codigo Y por documento: una
 * company creada a mano en HubSpot no tiene codigo, asi que mirar solo eso
 * deja pasar el duplicado justo en el caso que importa.
 *
 * El CUIT NO es clave (142 valores se repiten en 267 clientes). Por eso esto
 * devuelve coincidencias para que decida una persona, y no un veredicto.
 *
 * @returns {{porCodigo: object|null, porDocumento: array, consultado: object}}
 */
async function buscarDuplicados({ tango, codigo, documento: doc } = {}) {
    if (!tango) throw new Error('verificarEmpresa.buscarDuplicados: falta el cliente de Tango');

    const process = defaults.clientes.process;
    const cod = literalSeguro(codigo, COD_SEGURO);
    const num = literalSeguro(doc, DOC_SEGURO);
    const salida = { porCodigo: null, porDocumento: [], consultado: { codigo: cod, documento: num } };

    if (cod) {
        const filas = await tango.getByFilter(process, `COD_GVA14 = '${cod}'`);
        salida.porCodigo = filas[0] || null;
    }
    if (num) {
        salida.porDocumento = await tango.getByFilter(process, `CUIT = '${num}'`);
    }
    return salida;
}

module.exports = { verificar, buscarDuplicados, literalSeguro, ALTA, COD_SEGURO, DOC_SEGURO };
