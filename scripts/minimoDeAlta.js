#!/usr/bin/env node
'use strict';

/**
 * Que exige Tango DE VERDAD para dar de alta un cliente.
 *
 *   node scripts/minimoDeAlta.js            # sondea con el codigo 999950
 *   node scripts/minimoDeAlta.js 999951     # con otro codigo de prueba
 *
 * POR QUE EXISTE
 * --------------
 * La lista de campos obligatorios de `config/defaults.tango.json` fue durante
 * dos semanas una SUPOSICION copiada del payload de ejemplo de Postman. Con esa
 * suposicion, `CUIT`, `DOMICILIO`, `NOM_COM` y el pais frenaban el alta — y eso
 * dejaba el circuito entero parado por datos que el ERP nunca pidio.
 *
 * EL METODO
 * ---------
 * Tango contesta el alta incompleta con "El campo X es requerido", UNO por vez,
 * y **sin crear nada**. Entonces: mandar `{}`, leer que pide, agregarlo, repetir.
 * Termina cuando el alta entra — y ese es el payload minimo. El unico registro
 * que se crea es el ultimo, y se borra al terminar.
 *
 * ⚠️ Los valores que se van agregando tienen que ser IDs INTERNOS, no codigos.
 * El sondeo del 2026-08-28 se cayo justo ahi: `ID_GVA05 = 9` (el codigo de ZONA
 * NO DEFINIDA) fue rechazado con "no existe el valor correspondiente en Zonas".
 * El ID interno es 10. Por eso los IDs se resuelven con `lookups` contra las
 * tablas vivas y no se escriben a mano (5.4).
 *
 * ⚠️ ESCRIBE EN TANGO. Crea un cliente y lo borra. El entorno es una COPIA del
 * ERP (5.9), asi que es barato, pero no es de solo lectura como los otros
 * scripts. Necesita salida hacia Tango (5.6) y, si se corre por el proxy,
 * TANGO_PROXY_ESCRITURA.
 */

const fs = require('node:fs');
const path = require('node:path');
const tangoClient = require('../src/lib/tangoClient');
const lookupsLib = require('../src/lib/lookups');
const procesos = require('../config/tango.processes.json');
const defaults = require('../config/defaults.tango.json');

const PROCESS = procesos.entidades.clientes.process;
const MAX_INTENTOS = 80;

/** Textos con los que Tango pide un campo. El codigo lo pide con otra frase. */
const PIDE_CAMPO = /El campo (\w+) es requerido/;
const PIDE_CODIGO = /El c.digo es requerido/i;

function cargarConfigLocal() {
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
}

/**
 * Valor para un campo que Tango acaba de pedir. El orden importa: primero lo
 * que ya esta decidido en el catalogo, despues los IDs resueltos contra el ERP,
 * y solo al final una heuristica por el nombre.
 */
function valorPara(campo, lookups) {
    if (campo in defaults.clientes.defaults) return defaults.clientes.defaults[campo];

    const delCatalogo = defaults.clientes.alta.campos.find((c) => c.tango === campo);
    if (delCatalogo) {
        const codigo = delCatalogo.codigoPorDefecto ?? delCatalogo.codigoSiFalta;
        if (codigo && delCatalogo.lookup && lookups) {
            const r = lookups.resolver(delCatalogo.lookup, codigo, campo);
            // El ID interno, NO el codigo. Es la trampa de 5.4.
            if (r.ok) return r.id;
        }
        if (delCatalogo.valorSiFalta !== undefined) return delCatalogo.valorSiFalta;
    }

    if (campo === 'RAZON_SOCI' || campo === 'NOM_COM') return 'ZZ PRUEBA MINIMO - BORRAR';
    if (campo === 'ID_CATEGORIA_IVA') return 1;      // RI, verificado 7.7
    if (campo === 'ID_TIPO_DOCUMENTO_GV') return 26; // C.U.I.T., verificado 5.8
    if (/^ID_/.test(campo)) return 1;
    if (/^(PORC|IMP|CUPO|NRO|CANT|EQUIV)/.test(campo)) return 0;
    if (/^(USA_|GEN_|ES_|EXPORTA|CLAUSULA)/.test(campo)) return false;
    return ' ';
}

(async () => {
    const env = { ...cargarConfigLocal(), ...process.env };
    const codigo = process.argv[2] || '999950';

    const log = { paso: () => {}, aviso: () => {} };
    const tango = tangoClient.crear({
        baseUrl: env.TANGO_API_URL,
        apiKey: env.TANGO_API_KEY,
        company: env.TANGO_COMPANY || '1',
        log,
    });

    console.log('Cargando las tablas auxiliares (los IDs internos salen de ahi)...');
    const lookups = await lookupsLib.cargar(tango, log);

    // El codigo ya se sabe obligatorio (7.6, verificado 2026-08-21): va desde
    // el arranque para que el sondeo no se trabe en una frase distinta.
    const payload = { COD_GVA14: codigo };
    const exigidos = ['COD_GVA14'];

    console.log(`\nSondeando el alta con el codigo ${codigo}...\n`);

    for (let i = 1; i <= MAX_INTENTOS; i++) {
        let respuesta;
        try {
            respuesta = await tango.create(PROCESS, payload);
        } catch (e) {
            respuesta = e.cuerpo ?? { exceptionInfo: { messages: [e.message] } };
        }

        const mensajes = respuesta?.exceptionInfo?.messages ?? [];
        const entro = respuesta?.succeeded === true || (!mensajes.length && respuesta);

        if (entro) {
            console.log(`\n✅ Aceptado. Tango exige ${exigidos.length} campos:\n`);
            exigidos.forEach((c, n) => console.log(`  ${String(n + 1).padStart(2)}. ${c.padEnd(34)} = ${JSON.stringify(payload[c])}`));

            const delNegocio = exigidos.filter((c) => defaults.clientes.alta.campos.some((x) => x.tango === c && x.origen === 'hubspot'));
            console.log(`\nDe esos, los que son un dato del NEGOCIO: ${delNegocio.join(', ') || '(ninguno)'}`);
            console.log('El resto es parametria con default, mas el codigo que asignamos nosotros.\n');

            const filas = await tango.getByFilter(PROCESS, `COD_GVA14 = '${codigo}'`);
            const id = filas[0]?.ID_GVA14;
            if (id) {
                await tango.borrar?.(PROCESS, id);
                console.log(`cliente de prueba ${codigo} (ID_GVA14 ${id}): borrarlo si el cliente sigue ahi.`);
            }
            console.log('\nPAYLOAD MINIMO:\n' + JSON.stringify(payload, null, 2));
            return;
        }

        const m = mensajes.map((x) => PIDE_CAMPO.exec(x)).find(Boolean);
        const campo = m ? m[1] : (mensajes.some((x) => PIDE_CODIGO.test(x)) ? 'COD_GVA14' : null);

        if (!campo) {
            // Ya no pide campos: o es una clave foranea que no existe (un ID mal
            // resuelto) o algo que este script no sabe arreglar.
            console.log(`\n⛔ Tango dejo de pedir campos y rechazo por otra cosa:\n  ${JSON.stringify(mensajes)}`);
            console.log(`\nCampos que exigio hasta aca (${exigidos.length}):`);
            exigidos.forEach((c, n) => console.log(`  ${String(n + 1).padStart(2)}. ${c.padEnd(34)} = ${JSON.stringify(payload[c])}`));
            process.exitCode = 1;
            return;
        }

        payload[campo] = valorPara(campo, lookups);
        exigidos.push(campo);
        console.log(`${String(i).padStart(2)}. pide ${campo.padEnd(34)} -> ${JSON.stringify(payload[campo])}`);
    }

    console.log('\nSe agoto el limite de intentos sin que Tango aceptara el alta.');
    process.exitCode = 1;
})().catch((e) => {
    console.error('\nFallo:', e.message);
    process.exit(1);
});
