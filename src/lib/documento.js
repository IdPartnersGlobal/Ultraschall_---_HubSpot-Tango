'use strict';

/**
 * Tipo y formato del documento del cliente.
 *
 * El campo `CUIT` de Tango es en realidad un campo GENERICO de documento:
 * segun COD_TIPO_DOCUMENTO_GV puede traer un CUIT, un CUIL o un DNI.
 *
 * Codigos de Tango, verificados sobre los 5670 clientes (2026-08-18).
 * No son suposiciones: la respuesta trae COD_TIPO_DOCUMENTO_GV y
 * DESC_TIPO_DOCUMENTO_GV juntos, y la correspondencia es 1 a 1 en todo el
 * padron. Ademas se cruzo con dos fuentes independientes que no conocen la
 * etiqueta (digito verificador y prefijos AFIP) y coinciden.
 */
const CODIGOS = {
    80: 'CUIT',
    96: 'DNI',
    86: 'CUIL',
    91: 'CI_EXTRANJERA',
    99: 'SIN_IDENTIFICAR',
    // Tango lo etiqueta "C.I. POLICIA FEDERAL", pero en los hechos es el valor
    // por defecto de un campo sin cargar: 583 de esos 681 clientes tienen un
    // CUIT con digito verificador valido.
    0: 'SIN_DEFINIR',
};

/** Prefijos que AFIP asigna. 20/23/24/27 personas fisicas, 30/33/34 juridicas. */
const PREFIJOS_AFIP = new Set(['20', '23', '24', '27', '30', '33', '34']);

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * Digito verificador de CUIT/CUIL (modulo 11).
 * OJO: CUIT y CUIL usan el mismo algoritmo y comparten prefijos, asi que
 * esto NO distingue uno de otro.
 */
function digitoVerificadorOk(valor) {
    const d = soloDigitos(valor);
    if (!/^\d{11}$/.test(d)) return false;
    const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let suma = 0;
    for (let i = 0; i < 10; i++) suma += Number(d[i]) * pesos[i];
    let v = 11 - (suma % 11);
    if (v === 11) v = 0;
    if (v === 10) return false;
    return v === Number(d[10]);
}

function prefijoValido(valor) {
    const d = soloDigitos(valor);
    return d.length === 11 && PREFIJOS_AFIP.has(d.slice(0, 2));
}

/** Un numero que aprueba las dos verificaciones independientes. */
function esCuitPlausible(valor) {
    return digitoVerificadorOk(valor) && prefijoValido(valor);
}

/**
 * Formato unico acordado con Ultraschall (2026-08-18): TEXTO con guiones.
 * Tango los exige en el alta. A un DNI no se le aplica la mascara de CUIT.
 */
function formatear(valor) {
    const d = soloDigitos(valor);
    if (!d) return null;
    if (d.length === 11) return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
    return d;
}

/**
 * Resuelve el tipo de documento de un cliente.
 *
 * Regla: si Tango trae un tipo con sentido se respeta. Si trae SIN_DEFINIR
 * o SIN_IDENTIFICAR, se infiere del valor — y se deja constancia de que fue
 * inferido, para que nadie tome una deduccion por un dato del ERP.
 *
 * @returns {{ tipo, origen: 'tango'|'inferido'|'desconocido', numero, dvValido, revisar }}
 */
function resolver(registro) {
    const cod = Number(registro.COD_TIPO_DOCUMENTO_GV);
    const declarado = CODIGOS[cod];
    const numero = formatear(registro.CUIT);
    const d = soloDigitos(registro.CUIT);
    const dvValido = digitoVerificadorOk(d);

    // Tango declara un tipo util: se respeta, aunque el valor sea dudoso.
    if (declarado && declarado !== 'SIN_DEFINIR' && declarado !== 'SIN_IDENTIFICAR') {
        const coherente =
            (declarado === 'CUIT' || declarado === 'CUIL') ? dvValido :
            (declarado === 'DNI') ? d.length >= 7 && d.length <= 8 : true;
        return { tipo: declarado, origen: 'tango', numero, dvValido, revisar: !coherente };
    }

    // Tango no lo declara: se infiere.
    if (!d) return { tipo: null, origen: 'desconocido', numero: null, dvValido: false, revisar: true };
    if (esCuitPlausible(d)) {
        // No se puede distinguir CUIT de CUIL desde el numero.
        return { tipo: 'CUIT', origen: 'inferido', numero, dvValido: true, revisar: false };
    }
    if (d.length === 7 || d.length === 8) {
        return { tipo: 'DNI', origen: 'inferido', numero, dvValido: false, revisar: false };
    }
    return { tipo: null, origen: 'desconocido', numero, dvValido, revisar: true };
}

module.exports = {
    CODIGOS, PREFIJOS_AFIP,
    digitoVerificadorOk, prefijoValido, esCuitPlausible, formatear, resolver, soloDigitos,
};
