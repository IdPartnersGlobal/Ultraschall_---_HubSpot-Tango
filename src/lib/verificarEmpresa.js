'use strict';

const documento = require('./documento');
const enCastellano = require('./enCastellano');
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
 * Que campos son obligatorios sale de `config/defaults.tango.json`, no de aca.
 * Desde el 2026-08-28 ya NO es una suposicion: se sondeo el ERP mandando
 * Api/Create con {} y agregando de a uno lo que fuera pidiendo (`alta._sondeo`).
 *
 * El resultado cambio la doctrina de este modulo. De los 28 campos que Tango
 * exige, UNO SOLO es un dato del negocio: `RAZON_SOCI`. `CUIT`, `DOMICILIO`,
 * `NOM_COM` y el pais estaban marcados obligatorios POR SUPOSICION y frenaban
 * altas que el ERP habria aceptado sin chistar.
 *
 * Politica desde entonces (decision de Matias): **si la empresa no tiene ID de
 * Tango, se crea con lo minimo**. Lo que el ERP no exige no frena nada — va con
 * default o no va — y queda como AVISO para que comercial lo complete despues.
 *
 * Por eso un aviso no es un problema tibio: un problema es "esto no se puede
 * crear", un aviso es "se creo, y falta esto". Meter el CUIT en la primera
 * bolsa era lo que tenia el circuito entero parado.
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
            if (!digitos) return { motivo: `'${texto}' no tiene ningun digito`, comoSeArregla: 'cargar el CUIT o documento en la empresa' };

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
                return { motivo: `Tango no reconoce el tipo de documento '${tipo}'`, comoSeArregla: 'avisar a sistemas' };
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
                comoSeArregla: 'elegir el tipo de documento en la empresa, o corregir el CUIT',
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
                comoSeArregla: `elegir una opcion de '${enCastellano.etiqueta(campo.tango, campo.hubspot)}' que exista en Tango`,
            };
        }

        case 'opcionLookup': {
            // El desplegable guarda la etiqueta; Tango quiere el ID interno. El
            // codigo sale del mapa `opciones` leido al reves.
            if (vacio(crudo)) {
                // Sin elegir: si el catalogo declara un neutro, se usa y se avisa.
                //
                // ⚠️ HOY NINGUN CAMPO LO USA. Lo uso ID_CATEGORIA_IVA hasta que
                // Matias decidio (2026-08-28) que la categoria fiscal se elige y
                // no se adivina: determina como se factura, y un default
                // equivocado no se nota hasta que sale mal una factura. Queda el
                // mecanismo porque es la forma de que otro campo opte por el
                // desde config, sin tocar codigo.
                const alterno = porCodigo(campo, campo.codigoSiFalta, lookups);
                if (alterno) return { ...alterno, porDefecto: true };
                return {};
            }
            const codigo = codigoDesdeEtiqueta(campo.hubspot, crudo, m);
            if (!codigo) return { motivo: `la opcion '${crudo}' no tiene equivalencia en Tango`, comoSeArregla: `avisar a sistemas: '${enCastellano.etiqueta(campo.tango, campo.hubspot)}' tiene una opcion que Tango no reconoce` };
            const r = lookups.resolver(campo.lookup, codigo, campo.hubspot);
            if (r.ok) return { valor: r.id, codigo };
            return { motivo: r.motivo, comoSeArregla: 'avisar a sistemas: ese valor no existe en Tango' };
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
 * Mail del owner que decide el vendedor.
 *
 * Es el owner del NEGOCIO, no el de la company (decision de Matias 2026-09-03):
 * el vendedor es quien cerro la venta. La mayoria de las companies no tienen
 * owner —la demo tampoco— asi que mirar ahi era mirar un campo vacio.
 *
 * HubSpot guarda el ID y nunca el mail, asi que la tabla de owners hay que
 * leerla aparte (es una llamada de red). Se acepta tambien el mail ya resuelto,
 * para no obligar a leer owners en un test.
 */
function emailDelOwner(ownerId, owners) {
    if (vacio(ownerId)) return null;
    const v = String(ownerId).trim();
    if (v.includes('@')) return v;
    if (!owners) return null;
    return (typeof owners.get === 'function' ? owners.get(v) : owners[v]) || null;
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
 *                                el vendedor. Sin esto el alta FRENA.
 * @param {string} [p.ownerId]    owner del NEGOCIO (id o mail). Es lo que
 *                                decide el vendedor de Tango.
 * @returns {{ok, problemas, pendientes, avisos, valores, resueltos}}
 *
 * Nunca lanza. Una company incompleta es un informe, no una excepcion.
 */
function verificar({ propiedades = {}, mapper: m, lookups, decididos = {}, owners = null, ownerId = null } = {}) {
    if (!m) throw new Error('verificarEmpresa: falta el mapper');

    const problemas = [];
    const pendientes = [];
    const avisos = [];
    const valores = {};
    const resueltos = {};

    /** Se creo igual, pero falta esto. No frena: lo lee la nota del negocio (9.9). */
    const avisar = (campo, motivo, comoSeArregla) => avisos.push(problema(campo, motivo, comoSeArregla));

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

            // Lo que comercial ELIGIO en el desplegable de la ficha. Va despues
            // del ID que ya trae la company (ese vino del sync, o sea de Tango)
            // y antes del default.
            //
            // Existe desde el 2026-09-01. Hasta ese dia estos campos eran texto
            // libre, el alta no los miraba, y estaba bien porque nadie los
            // elegia. Al volverlos desplegables pasaron a INVITAR a elegir, y
            // una eleccion que se descarta en silencio es peor que un campo que
            // no se puede tocar: comercial elige NOA y el cliente sale con ZONA
            // NO DEFINIDA sin que nada avise.
            //
            // El desplegable guarda el CODIGO justamente para esto: `porCodigo`
            // lo traduce a ID interno contra la tabla auxiliar. Con la
            // descripcion no habria vuelta posible (§9.14).
            if (campo.hubspotOpcion) {
                const elegido = propiedades[campo.hubspotOpcion];
                if (!vacio(elegido)) {
                    const r = porCodigo(campo, elegido, lookups);
                    if (r) {
                        valores[campo.tango] = r.valor;
                        resueltos[campo.tango] = { codigo: r.codigo, elegidoEn: campo.hubspotOpcion };
                        continue;
                    }
                    // Eligio algo que el ERP no resuelve. NO se cae al default:
                    // seria mandar el cliente con otra zona, valido, sin que
                    // nada falle. Es el mismo criterio que el deposito (§9.8).
                    problemas.push(problema(
                        campo,
                        `la opcion '${elegido}' no existe en Tango`,
                        `elegir otra opcion de '${enCastellano.etiqueta(campo.tango, campo.hubspotOpcion)}' en la empresa. Si la opcion es correcta, avisar a sistemas`,
                    ));
                    continue;
                }
            }

            // El vendedor sale del owner del NEGOCIO. El match NO puede ser por
            // el mail de Tango: GVA23.E_MAIL esta vacio en 26 de 27 vendedores,
            // asi que la equivalencia vive en el catalogo (`porOwner`).
            //
            // ⚠️ Sin equivalencia esto FRENA el negocio (decision de Matias
            // 2026-09-03). Antes caia en FACUNDO, que tiene el 63% de la cartera
            // y por eso parecia razonable: el pedido del 2026-09-02 salio asi,
            // con `ok: true` y sin un solo aviso. Un cliente que queda con el
            // vendedor equivocado no lo descubre nadie hasta la comision.
            if (campo.origen === 'owner') {
                const mail = String(emailDelOwner(ownerId, owners) || '').trim().toLowerCase();
                const codigo = mail ? (campo.porOwner || {})[mail] : undefined;
                const r = porCodigo(campo, codigo, lookups);
                if (r) {
                    valores[campo.tango] = r.valor;
                    resueltos[campo.tango] = { codigo: r.codigo, porOwner: mail };
                    continue;
                }
                problemas.push(problema(
                    campo,
                    mail
                        ? `el responsable del negocio (${mail}) no es un vendedor de Tango`
                        : 'el negocio no tiene responsable asignado',
                    mail
                        ? 'asignar el negocio a un responsable que sea vendedor en Tango. Si el responsable es correcto, avisar a sistemas para que lo den de alta como vendedor'
                        : 'asignar un responsable al negocio en HubSpot',
                ));
                continue;
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
                problemas.push(problema(campo, 'falta', `cargar '${enCastellano.etiqueta(campo.tango, campo.hubspot)}' en la empresa`));
            } else if (campo.avisarSiFalta) {
                // Tango no lo exige, asi que el cliente se crea igual — pero
                // sin CUIT no se le puede facturar, y eso tiene que llegarle a
                // alguien.
                avisar(campo, 'esta vacio: el cliente se crea sin ese dato', `cargar '${enCastellano.etiqueta(campo.tango, campo.hubspot)}' en la empresa`);
            }
            continue;
        }

        if (r.porDefecto && campo.avisarSiFalta) {
            avisar(campo, `no estaba cargado: va '${r.codigo ?? r.valor}' por defecto`,
                `confirmar ${campo.hubspot} en la empresa`);
        }

        valores[campo.tango] = r.valor;
        if (r.tipo) resueltos.tipoDocumento = { tipo: r.tipo, inferido: !!r.inferido, porDefecto: !!r.porDefecto };
        if (r.codigo) resueltos[campo.tango] = { codigo: r.codigo, porDefecto: !!r.porDefecto };
        // Un documento raro no frena el alta, pero queda senalado: es lo que
        // deja que alguien lo revise despues sin tener que buscarlo.
        if (r.revisar) resueltos.documentoARevisar = { valor: r.valor, sinNormalizar: !!r.sinNormalizar };
    }

    return { ok: problemas.length === 0 && pendientes.length === 0, problemas, pendientes, avisos, valores, resueltos };
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

/**
 * Las propiedades de HubSpot que `verificar` necesita leer de la company.
 *
 * ⚠️ Existe porque mantener esa lista A MANO fallo, y fallo del peor modo
 * posible (2026-09-02). `dealToTango.PROPS_COMPANY` pedia 8 propiedades y
 * NINGUNA de las 12 con datos del negocio: `razon_social` y `condicion_iva`
 * llegaban `undefined` aunque estuvieran cargadas en el portal, y el alta las
 * reportaba como faltantes. Es decir que **ninguna empresa se podia dar de alta
 * desde un negocio**, el 100% de las veces, y el mensaje de error apuntaba
 * justo a los datos que si estaban — mandando a cargar lo que ya estaba cargado.
 *
 * Se deriva del catalogo (`defaults.tango.json → clientes.alta.campos`), asi que
 * agregar un campo al alta no puede volver a dejar la lectura corta.
 *
 * Es la misma leccion del precio (§9.12): *un fake que devuelve todo esconde el
 * bug de no pedir una propiedad*. Ahi fue `camposNoAutoritativos`; aca fue esto.
 */
function propiedadesQueNecesita() {
    const props = new Set();
    for (const campo of ALTA.campos) {
        if (campo.hubspot) props.add(campo.hubspot);
        // El desplegable que elige comercial (§9.14): se lee aparte del campo
        // donde el sync deja el ID, y los dos hacen falta.
        if (campo.hubspotOpcion) props.add(campo.hubspotOpcion);
    }
    // El owner NO va aca: el vendedor sale del owner del NEGOCIO, que se lee
    // del Deal (`PROPS_DEAL`) y llega por `ownerId`. La company casi nunca
    // tiene owner cargado, asi que pedirselo era pedir un campo vacio.
    return [...props];
}

module.exports = { verificar, buscarDuplicados, literalSeguro, propiedadesQueNecesita, ALTA, COD_SEGURO, DOC_SEGURO };
