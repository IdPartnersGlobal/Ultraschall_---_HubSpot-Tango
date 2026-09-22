'use strict';

const documento = require('./documento');
const verificarEmpresa = require('./verificarEmpresa');
const procesos = require('../../config/tango.processes.json');

/**
 * ¿La empresa de HubSpot es el cliente de Tango que dice ser? (§7.14)
 *
 * POR QUE EXISTE
 * --------------
 * El 2026-09-03 Ultraschall importo ~41.200 empresas al portal. 7.586 traen
 * `codigo_tango` —el nombre de su planilla— pero ninguna trae la vinculacion
 * que usa el circuito: `tango_codigo_cliente` y `tango_id_gva14`.
 *
 * Y el circuito decidia "esta empresa no existe en Tango" mirando SOLO
 * `tango_id_gva14`. Con una empresa importada que ya es cliente, un negocio
 * ganado **creaba un cliente nuevo en el ERP** y despues le pisaba el codigo
 * importado con el nuevo. En Tango no hay camino de vuelta.
 *
 * La regla, desde el 2026-09-15: **una empresa que tiene codigo de Tango nunca
 * se da de alta.** Se busca ese codigo en el ERP y:
 *
 *   - es el mismo cliente  -> se vincula y el pedido sale con ese cliente.
 *   - no existe            -> FRENA.
 *   - es de otro cliente   -> FRENA.
 *
 * Los dos frenos son decision de Matias (2026-09-15): "si podemos detectar que
 * un codigo no existe o es de otro cliente, tenemos que frenar". Crear un
 * cliente nuevo seria duplicarlo; usar el del codigo seria facturarle a otro.
 * Los dos errores salen del sistema sin que nada falle.
 *
 * COMO SE DECIDE "EL MISMO"
 * -------------------------
 * El codigo solo no alcanza, y se midio: sobre las 7.586 importadas, 18
 * comparten codigo de a pares (una clinica privada y un ministerio con el
 * mismo) y en total 13 tienen el codigo de un cliente que no son. Por eso se
 * confirma con el documento, y si no hay documento para comparar, con el
 * nombre.
 *
 * ⚠️ El codigo NUNCA se normaliza: ni ceros a la izquierda ni numero. `04078` y
 * `004078` son dos clientes distintos en Tango (§7.5).
 */

/** Lo que este modulo lee de la empresa. `PROPS_COMPANY` lo incluye. */
const PROPIEDADES = ['codigo_tango', 'tango_codigo_cliente', 'tango_id_gva14', 'cuit', 'razon_social', 'name'];

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * El codigo con el que la empresa dice ser cliente de Tango, o null.
 *
 * `tango_codigo_cliente` primero: es la clave del sync y la escribe el circuito.
 * `codigo_tango` es el que carga la gente y el que trajo la importacion.
 */
function codigoDeclarado(props = {}) {
    for (const p of ['tango_codigo_cliente', 'codigo_tango']) {
        if (!vacio(props[p])) return String(props[p]).trim();
    }
    return null;
}

// ─────────────────────────────────────────────────────────── el documento

/**
 * Un documento que sirve para comparar: CUIT (11 digitos) o DNI (7 u 8).
 *
 * Los de relleno no sirven, y en Tango los hay: `12.345.678` en un cliente real.
 * Compararlos daria "coincide" entre dos personas que no se conocen.
 */
function documentoComparable(valor) {
    const d = documento.soloDigitos(valor);
    if (d.length !== 11 && d.length !== 7 && d.length !== 8) return null;
    if (/^(\d)\1+$/.test(d)) return null;
    if ('1234567890'.includes(d) || '98765432109'.includes(d)) return null;
    return d;
}

/**
 * Mismo documento. Contempla que un lado tenga el CUIT y el otro el DNI de la
 * misma persona: el CUIT de una persona fisica es prefijo + DNI + verificador.
 * Medido: 2 de las 8 importadas que "no coincidian" eran exactamente eso.
 */
function mismoDocumento(a, b) {
    if (a === b) return true;
    const [cuit, dni] = a.length === 11 ? [a, b] : [b, a];
    if (cuit.length !== 11 || dni.length === 11) return false;
    return cuit.slice(2, 10) === dni.padStart(8, '0');
}

// ────────────────────────────────────────────────────────────── el nombre

/**
 * Palabras que no identifican a nadie. La forma juridica y los conectores:
 * "Clinica Lujan SA" y "Clinica Lujan" son la misma empresa.
 */
const RUIDO = new Set([
    'SA', 'SRL', 'SAS', 'SH', 'SAIC', 'SACI', 'SAU', 'SOCIEDAD', 'ANONIMA', 'RESPONSABILIDAD', 'LIMITADA', 'SOC', 'CIA',
    'DE', 'DEL', 'LA', 'LAS', 'EL', 'LOS', 'Y', 'E', 'EN', 'PARA', 'DR', 'DRA',
]);

function palabras(texto) {
    const limpio = String(texto ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        // "S.A." y "S.R.L." se juntan antes de partir, si no quedan letras sueltas.
        .replace(/\b([A-Z])\.(?=[A-Z]\.)/g, '$1')
        .replace(/[^A-Z0-9]+/g, ' ');
    return new Set(limpio.split(' ').filter((p) => p.length > 1 && !RUIDO.has(p)));
}

/**
 * Dos nombres son del mismo cliente si tienen LAS MISMAS palabras, en
 * cualquier orden: "Peña Sandra" y "Sandra Peña", "Clinica Lujan SA" y
 * "CLINICA LUJAN".
 *
 * Es el criterio mas estricto posible, y se eligio midiendo (2026-09-15). Por
 * nombre solo se decide cuando NO hay documento para comparar, y equivocarse
 * es mandarle el pedido a otro cliente:
 *
 *   - Las 94 importadas que se confirman por nombre tienen exactamente las
 *     mismas palabras que su cliente. Exigir igualdad no pierde ninguna.
 *   - "Todas las palabras del corto estan en el largo" juntaba, contra el
 *     padron entero, dos clubes distintos ("Club X" y "Club X Barrancas") y
 *     dos personas distintas ("Apellido Nombre" y "Nombre Segundo Otro
 *     Apellido"). Y "dos de tres palabras" juntaba a dos hermanas.
 *
 * Si no alcanza, la nota pide cargar el CUIT: cuesta un dato, no un pedido.
 */
function mismoNombre(a, b) {
    const A = palabras(a);
    const B = palabras(b);
    return A.size > 0 && A.size === B.size && [...A].every((p) => B.has(p));
}

/**
 * ¿La empresa es este cliente de Tango?
 *
 * @param {object} props  propiedades de la empresa en HubSpot
 * @param {object} fila   el cliente, tal como lo devuelve Tango (process 2117)
 * @returns {{ mismo: boolean, por: 'documento'|'nombre'|null, documento: 'coincide'|'distinto'|'sin-dato' }}
 *
 * ⚠️ Si los dos documentos existen y NO coinciden, no es el mismo aunque el
 * nombre sea identico. Medido: una importada tenia el codigo de un cliente con
 * su mismo nombre de fantasia y otra razon social y otro CUIT.
 */
function comparar(props = {}, fila = {}) {
    const docH = documentoComparable(props.cuit);
    const docT = documentoComparable(fila.CUIT);

    if (docH && docT) {
        return mismoDocumento(docH, docT)
            ? { mismo: true, por: 'documento', documento: 'coincide' }
            : { mismo: false, por: null, documento: 'distinto' };
    }

    const nombresH = [props.razon_social, props.name].filter((v) => !vacio(v));
    const nombresT = [fila.RAZON_SOCI, fila.NOM_COM].filter((v) => !vacio(v));
    const coincide = nombresH.some((h) => nombresT.some((t) => mismoNombre(h, t)));
    return { mismo: coincide, por: coincide ? 'nombre' : null, documento: 'sin-dato' };
}

// ─────────────────────────────────────────── una empresa SIN codigo (§7.16)

/**
 * La forma de un nombre que se usa de indice: sus palabras, ordenadas. Dos
 * nombres tienen la misma clave si y solo si `mismoNombre` los da iguales.
 */
function claveDeNombre(texto) {
    const p = [...palabras(texto)].sort();
    return p.length ? p.join(' ') : null;
}

/** Los clientes de Tango por `claveDeNombre`, de la razon social y del nombre de fantasia. */
function indiceDeNombres(registros = []) {
    const indice = new Map();
    for (const fila of registros) {
        for (const k of new Set([claveDeNombre(fila?.RAZON_SOCI), claveDeNombre(fila?.NOM_COM)])) {
            if (k) (indice.get(k) || indice.set(k, []).get(k)).push(fila);
        }
    }
    return indice;
}

/**
 * Los clientes de Tango que una empresa SIN codigo parece ser (2026-09-22).
 *
 * Por que: el sync creaba una ficha nueva para cada cliente nuevo de Tango, y
 * 8 de los 71 que creo ya estaban en HubSpot como prospecto sin codigo. Y el
 * circuito, con una empresa sin codigo, da de alta: si esa empresa ya era
 * cliente, lo duplica en Tango. Decision de Matias: "si la ficha no trae
 * codigo, hay que marcarlas para no hacerlas de vuelta".
 *
 * La regla es mas estricta que `comparar`, a proposito: aca no hay un codigo
 * que diga "soy este cliente", hay que encontrarlo entre 5.800.
 *
 *   - Las MISMAS palabras en el nombre o la razon social (`mismoNombre`).
 *   - Y que el documento no lo contradiga: dos CUIT distintos no son el mismo.
 *
 * El documento SOLO nunca alcanza: en Tango los CUIT se repiten (decision de
 * Matias, 2026-08-31). Medido: el 30-62698339-8 del Ministerio de Salud
 * bonaerense lo comparten mas de diez hospitales distintos.
 *
 * @param {object} props  la empresa de HubSpot
 * @param {Map|Array} fuente  `indiceDeNombres(...)`, o el padron directamente
 * @returns {Array<object>} las filas de Tango, sin repetir
 */
function gemelas(props = {}, fuente = []) {
    const indice = fuente instanceof Map ? fuente : indiceDeNombres(fuente);
    const docH = documentoComparable(props?.cuit);
    const vistas = new Set();
    const salida = [];
    for (const nombre of [props?.razon_social, props?.name]) {
        const k = claveDeNombre(nombre);
        for (const fila of (k && indice.get(k)) || []) {
            if (vistas.has(fila)) continue;
            vistas.add(fila);
            const docT = documentoComparable(fila.CUIT);
            if (docH && docT && !mismoDocumento(docH, docT)) continue;
            salida.push(fila);
        }
    }
    return salida;
}

/**
 * Como se deshace un "parece el mismo" que no lo es. Lo que lo decide es un
 * CUIT distinto; si ya tienen el mismo, no hay nada que deshacer.
 *
 * @returns {'mismo-cuit'|'cargar-cuit'|'cuit-en-tango'}
 */
function comoDescartar(props = {}, filas = []) {
    const docH = documentoComparable(props?.cuit);
    if (docH && filas.some((f) => documentoComparable(f.CUIT))) return 'mismo-cuit';
    return filas.every((f) => documentoComparable(f.CUIT)) ? 'cargar-cuit' : 'cuit-en-tango';
}

/** «007678 («Farmapos E.E», CUIT 30-71701607-2)», para los textos que lee comercial. */
function describirCliente(fila) {
    const cuit = documento.formatear(fila?.CUIT);
    return `${String(fila?.COD_GVA14 ?? '').trim()} («${String(fila?.RAZON_SOCI ?? '').trim()}»${cuit ? `, CUIT ${cuit}` : ''})`;
}

// ───────────────────────────────────────────────────────── contra Tango

/**
 * Busca en Tango el codigo que declara la empresa y dice que es.
 *
 * Es una LECTURA (1,6 s). Corre tambien en dry-run: el ensayo tiene que poder
 * mostrar que negocios frenarian por esto.
 *
 * Si el ERP no contesta se PROPAGA: es una caida, no un dato, y la cola tiene
 * que reintentar. Tratarlo como "no existe" frenaria el negocio con una nota
 * que culpa a comercial por un codigo que esta bien.
 *
 * @returns {Promise<{estado, codigo, fila?, comparacion?, problema?}>}
 *   estado: 'sin-codigo' | 'mismo' | 'no-existe' | 'otro-cliente' | 'codigo-invalido'
 */
async function buscar({ tango, props = {} }) {
    const codigo = codigoDeclarado(props);
    if (!codigo) return { estado: 'sin-codigo', codigo: null };

    const nombre = nombreDeLaEmpresa(props);

    // El codigo entra a un filtro SQL del ERP (§10.0) y viene de una ficha que
    // edita cualquiera: se valida la forma ANTES de preguntar.
    if (!verificarEmpresa.literalSeguro(codigo, verificarEmpresa.COD_SEGURO)) {
        return { estado: 'codigo-invalido', codigo, problema: problemas.codigoInvalido({ codigo, nombre }) };
    }

    const filas = await tango.getByFilter(procesos.entidades.clientes.process, `COD_GVA14 = '${codigo}'`);
    // El filtro es por igualdad, pero se vuelve a mirar el codigo: `04078` y
    // `004078` son clientes distintos y no se puede dar por hecho como compara
    // el ERP.
    const fila = (filas || []).find((f) => String(f?.COD_GVA14 ?? '').trim() === codigo) || null;

    if (!fila) return { estado: 'no-existe', codigo, problema: problemas.noExiste({ codigo, nombre }) };

    const comparacion = comparar(props, fila);
    if (comparacion.mismo) return { estado: 'mismo', codigo, fila, comparacion };

    return { estado: 'otro-cliente', codigo, fila, comparacion, problema: problemas.otroCliente({ codigo, nombre, props, fila, comparacion }) };
}

function nombreDeLaEmpresa(props) {
    return String((!vacio(props.name) ? props.name : props.razon_social) ?? '').trim() || null;
}

// ────────────────────────────────────────────────────────── las notas

/**
 * Los textos que lee COMERCIAL (§9.21). Cada uno dice que paso, con los datos
 * para verlo, y que hacer. `clase: 'corregir'` le avisa a la nota que esto no
 * es un dato que falta sino uno que esta mal.
 *
 * Las dos salidas se dicen siempre, porque desde la ficha no se sabe cual es:
 * si el codigo esta mal, se corrige; si la empresa nunca fue cliente, se borra
 * y el proximo intento la da de alta.
 */
const CAMPO = 'COD_GVA14';
const SI_NO_ES_CLIENTE = 'Si la empresa todavía no es cliente en Tango, borrar el código: la próxima vez que el negocio pase a Cierre ganado se la da de alta como cliente nueva';

const problemas = {
    noExiste({ codigo, nombre }) {
        return {
            campo: CAMPO,
            clase: 'corregir',
            motivo: `${deLaEmpresa(nombre)} tiene cargado el código ${codigo}, pero en Tango no existe ningún cliente con ese código`,
            comoSeArregla: `revisar el código en la ficha de la empresa y corregirlo si está mal. ${SI_NO_ES_CLIENTE}`,
        };
    },

    otroCliente({ codigo, nombre, props, fila, comparacion }) {
        const deTango = `«${String(fila.RAZON_SOCI ?? '').trim()}»`;
        if (comparacion.documento === 'distinto') {
            return {
                campo: CAMPO,
                clase: 'corregir',
                motivo: `el código ${codigo} es de otro cliente: en Tango es ${deTango}, con CUIT ${documento.formatear(fila.CUIT)}, y ${deLaEmpresa(nombre)} tiene CUIT ${documento.formatear(props.cuit)}`,
                comoSeArregla: `poner en la empresa el código de Tango que le corresponde. ${SI_NO_ES_CLIENTE}`,
            };
        }
        // Sin documento para comparar, el nombre no alcanzo. Puede ser el mismo
        // cliente con otro nombre en cada lado, y lo que lo confirma es el CUIT
        // — pero hay que decir DE QUE LADO falta. Si falta en Tango, pedirle a
        // comercial que lo cargue en la empresa no destraba nada: ya esta.
        if (!documentoComparable(props.cuit)) {
            return {
                campo: CAMPO,
                clase: 'corregir',
                motivo: `el código ${codigo} es de otro cliente: en Tango es ${deTango}, que no coincide con ${deLaEmpresa(nombre)}, y la empresa no tiene CUIT cargado para confirmar que sean el mismo`,
                comoSeArregla: `si es el mismo cliente con otro nombre, cargar su CUIT en la empresa para confirmarlo. Si no, poner el código de Tango que le corresponde. ${SI_NO_ES_CLIENTE}`,
            };
        }
        return {
            campo: CAMPO,
            clase: 'corregir',
            motivo: `el código ${codigo} es de otro cliente: en Tango es ${deTango}, que no coincide con ${deLaEmpresa(nombre)}, y ese cliente no tiene CUIT cargado en Tango para confirmar que sean el mismo`,
            comoSeArregla: `poner en la empresa el código de Tango que le corresponde. Si es el mismo cliente con otro nombre, pedirle a administración que le cargue el CUIT en Tango. ${SI_NO_ES_CLIENTE}`,
        };
    },

    codigoInvalido({ codigo, nombre }) {
        return {
            campo: CAMPO,
            clase: 'corregir',
            motivo: `${deLaEmpresa(nombre)} tiene cargado «${codigo}» como código de Tango, y un código de Tango sólo lleva letras y números`,
            comoSeArregla: `corregirlo en la ficha de la empresa. ${SI_NO_ES_CLIENTE}`,
        };
    },

    /**
     * El cliente ya esta vinculado a OTRA empresa de HubSpot: hay dos fichas
     * para el mismo cliente. No se vincula esta —la propiedad es unica y HubSpot
     * lo rechazaria— y el pedido no sale colgado de la ficha equivocada.
     */
    yaVinculado({ codigo, nombre, otra }) {
        return {
            campo: CAMPO,
            clase: 'corregir',
            motivo: `el cliente ${codigo} de Tango ya está vinculado a otra empresa de HubSpot, «${otra}»: hay dos fichas para el mismo cliente y ${deLaEmpresa(nombre)} es la que no está vinculada`,
            comoSeArregla: `asociar el negocio a «${otra}», o fusionar las dos empresas en HubSpot`,
        };
    },

    /**
     * La empresa no tiene codigo pero parece un cliente que Tango ya tiene
     * (§7.16). Darla de alta lo duplicaria, y en Tango no hay camino de vuelta.
     * Las dos salidas se dicen: si es, el codigo; si no, el CUIT que lo descarta.
     *
     * `fichas` (codigo -> nombre de la empresa de HubSpot vinculada a ese
     * cliente) cambia que se pide si es el mismo. Si el cliente ya tiene su
     * ficha, cargarle el codigo a esta no alcanza: el proximo intento frena con
     * `yaVinculado` —"asociar el negocio a la otra, o fusionar"—. Se dice eso de
     * entrada y es una vuelta en vez de dos. Pasa en 345 de las 366 que marco
     * la simulacion del 2026-09-22.
     */
    posibleDuplicado({ nombre, props = {}, filas, fichas = new Map() }) {
        const uno = filas.length === 1;
        const codigoDe = (f) => String(f.COD_GVA14 ?? '').trim();
        const conFicha = (f) => (fichas.get(codigoDe(f)) ? `${describirCliente(f)}, que ya está en la empresa «${fichas.get(codigoDe(f))}»` : describirCliente(f));
        const quien = uno
            ? `el cliente ${describirCliente(filas[0])} de Tango`
            : `uno de estos clientes de Tango: ${filas.slice(0, 3).map(conFicha).join('; ')}${filas.length > 3 ? ` y ${filas.length - 3} más` : ''}`;
        let siEs;
        if (uno && fichas.get(codigoDe(filas[0]))) {
            siEs = `si es el mismo cliente, asociar el negocio a «${fichas.get(codigoDe(filas[0]))}», que ya está vinculada al ${codigoDe(filas[0])}, o fusionar las dos empresas`;
        } else if (uno) {
            siEs = `si es el mismo cliente, cargarle el código ${codigoDe(filas[0])} en la ficha de la empresa`;
        } else if (filas.every((f) => fichas.get(codigoDe(f)))) {
            siEs = 'si es uno de ellos, asociar el negocio a su empresa, o fusionar las dos empresas';
        } else if (filas.some((f) => fichas.get(codigoDe(f)))) {
            siEs = 'si es uno de ellos, asociar el negocio a su empresa (o fusionarlas); si ese cliente todavía no tiene empresa, cargarle su código en la ficha de esta';
        } else {
            siEs = 'si es uno de ellos, cargarle ese código en la ficha de la empresa';
        }
        const siNo = {
            'mismo-cuit': '',
            'cargar-cuit': '. Si es otra empresa, cargarle su CUIT: con un CUIT distinto se la da de alta como cliente nueva',
            'cuit-en-tango': '. Si es otra empresa, cargarle su CUIT y pedirle a administración que cargue en Tango el CUIT del cliente, que no lo tiene',
        }[comoDescartar(props, filas)];
        return {
            campo: CAMPO,
            clase: 'corregir',
            motivo: `${deLaEmpresa(nombre)} no tiene código de Tango, pero parece ser ${quien}. Darla de alta dejaría el mismo cliente dos veces en Tango`,
            comoSeArregla: `${siEs}${siNo}`,
        };
    },
};

function deLaEmpresa(nombre) {
    return nombre ? `la empresa «${nombre}»` : 'la empresa del negocio';
}

module.exports = {
    PROPIEDADES, codigoDeclarado, comparar, buscar, problemas,
    documentoComparable, mismoDocumento, mismoNombre, palabras,
    claveDeNombre, indiceDeNombres, gemelas, comoDescartar, describirCliente,
};
