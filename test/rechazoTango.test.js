'use strict';

const test = require('node:test');
const assert = require('node:assert');

const rechazoTango = require('../src/lib/rechazoTango');
const { TangoError } = require('../src/lib/tangoClient');

/** El rechazo REAL que mato el primer alta, copiado del log de Azure. */
const RECHAZO_REAL = "Tango rechazo la consulta: El campo 'LOCALIDAD' debe ser menor o igual a 20 caracteres.";

test('el rechazo por largo se traduce a algo que comercial puede arreglar', () => {
    const p = rechazoTango.comoProblema(new TangoError(RECHAZO_REAL), {
        localidad: 'Ciudad Autonoma de Buenos Aires',
    });

    assert.strictEqual(p.campo, 'LOCALIDAD');
    assert.match(p.motivo, /20 caracteres/);
    assert.match(p.motivo, /31/, 'dice cuanto mide de mas, que es la mitad de la respuesta');
    assert.match(p.motivo, /localidad/i, 'nombra la propiedad de HubSpot, no la columna del ERP');
    assert.match(p.comoSeArregla, /acortar/i);
    assert.match(p.comoSeArregla, /Cierre ganado/, 'y como se reintenta: mover la etapa ES el disparador');
});

test('el limite lo dice Tango, no lo adivina el codigo', () => {
    // Si manana Tango cambia LOCALIDAD a 40, el mensaje tiene que decir 40 sin
    // que nadie toque nada. Declarar largos aca seria adivinar: el maximo
    // observado en el padron es una cota inferior, y un limite de menos frena
    // datos validos.
    const p = rechazoTango.comoProblema(
        new TangoError("Tango rechazo la consulta: El campo 'RAZON_SOCI' debe ser menor o igual a 60 caracteres."), {});
    assert.strictEqual(p.campo, 'RAZON_SOCI');
    assert.match(p.motivo, /60 caracteres/);
});

test('una regla del ERP que no se entiende igual sale como dato, con el texto tal cual', () => {
    const p = rechazoTango.comoProblema(
        new TangoError('Tango rechazo la consulta: El cliente ya posee una cuenta corriente activa'), {});
    assert.ok(p, 'sigue siendo un problema de datos');
    assert.match(p.motivo, /cuenta corriente activa/, 'el texto del ERP va sin parafrasear');
});

test('el ERP CAIDO no es un problema de datos: se propaga para reintentar', () => {
    // La distincion entera. Confundirlas en un sentido reintenta lo que nunca
    // va a andar; en el otro, se come una caida real sin reintentar.
    for (const e of [
        new TangoError('fetch failed'),
        new TangoError('The operation was aborted due to timeout'),
        new TangoError('Tango respondio 500', { status: 500 }),
        new TangoError("La ruta 'Api/Create' no existe en el ERP (devolvio el HTML de la SPA)"),
        new Error('cualquier otra cosa'),
    ]) {
        assert.strictEqual(rechazoTango.comoProblema(e, {}), null, `no deberia ser dato: ${e.message}`);
    }
});

test('no recorta el valor: eso dejaria el domicilio mal para siempre', () => {
    // "Ciudad Autonoma de Buenos Aires" recortado a 20 da "Ciudad Autonoma de B".
    // El alta saldria "bien" y el dato quedaria roto sin que nadie se entere.
    const p = rechazoTango.comoProblema(new TangoError(RECHAZO_REAL), { localidad: 'Ciudad Autonoma de Buenos Aires' });
    assert.doesNotMatch(JSON.stringify(p), /Ciudad Autonoma de B"/, 'no propone el valor recortado como solucion');
    assert.match(p.comoSeArregla, /acortar/, 'lo tiene que decidir una persona');
});
