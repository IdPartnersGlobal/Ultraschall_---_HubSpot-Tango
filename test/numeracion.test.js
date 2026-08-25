'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const numeracion = require('../src/lib/numeracion');

const clientes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clientes-muestra.json'), 'utf8'));
const codigosReales = clientes.map((c) => c.COD_GVA14);

// ------------------------------------------------------------------ ocupados

test('el indice de ocupados va por numero, no por texto', () => {
    // En la cartera conviven codigos de largo 5 y de largo 6 (750 de largo 5).
    // '07611' y '007611' son dos strings distintos que Tango aceptaria como dos
    // clientes distintos; para elegir un codigo nuevo cuentan como el mismo.
    const set = numeracion.ocupados(['07611', '000003', 3, '  000004  ']);
    assert.ok(set.has(7611));
    assert.strictEqual(set.size, 3, 'el 3 y el 000003 son el mismo numero');
});

test('un codigo no numerico no compite por el espacio de numeros', () => {
    const set = numeracion.ocupados(['ABC', null, undefined, '', '000010']);
    assert.deepStrictEqual([...set], [10]);
});

// --------------------------------------------------------------- correlativo

test('correlativo: sigue despues del maximo de la cartera', () => {
    const { codigos, piso } = numeracion.planificar(['000003', '007610', '000900'], { estrategia: 'correlativo', cantidad: 2 });
    assert.strictEqual(piso, 7611);
    assert.deepStrictEqual(codigos, ['007611', '007612']);
});

test('correlativo: NO rellena los huecos de la cartera', () => {
    // Hay 1.943 huecos entre 1 y 7610. Son codigos que administracion dio de
    // baja: reusarlos mezclaria el historial de dos clientes distintos.
    const { codigos } = numeracion.planificar(['000003', '007610'], { estrategia: 'correlativo', cantidad: 1 });
    assert.deepStrictEqual(codigos, ['007611'], 'no debe proponer 000004, que esta libre pero es un hueco');
});

test('correlativo: los registros de prueba 999998/999999 no arrastran el correlativo', () => {
    // Es la trampa de esta funcion. Si el maximo se calculara sobre TODO el
    // padron, el siguiente codigo seria 1000000 — siete digitos, fuera de
    // formato — solo por dos registros de prueba del relevamiento (7.6).
    const { codigos } = numeracion.planificar([...codigosReales, '999998', '999999'], { estrategia: 'correlativo', cantidad: 1 });
    assert.strictEqual(codigos[0].length, 6);
    assert.ok(Number(codigos[0]) < 900000, `propuso ${codigos[0]}, que cayo en el rango reservado`);
});

test('correlativo sobre la muestra real arranca despues de su maximo', () => {
    const max = Math.max(...codigosReales.map(Number));
    const { codigos } = numeracion.planificar(codigosReales, { estrategia: 'correlativo', cantidad: 1 });
    assert.strictEqual(Number(codigos[0]), max + 1);
});

// ----------------------------------------------------------------- reservado

test('reservado: arranca en 900001 aunque la cartera llegue a 007610', () => {
    const { codigos, piso } = numeracion.planificar(codigosReales, { estrategia: 'reservado', cantidad: 3 });
    assert.strictEqual(piso, 900001);
    assert.deepStrictEqual(codigos, ['900001', '900002', '900003']);
});

test('reservado: saltea lo que ya esta ocupado dentro del rango', () => {
    const { codigos } = numeracion.planificar(['900001', '900002', '900004'], { estrategia: 'reservado', cantidad: 2 });
    assert.deepStrictEqual(codigos, ['900003', '900005']);
});

// --------------------------------------------------------- padding y colision

test('una variante de padding bloquea el candidato', () => {
    // '07611' ya existe: proponer '007611' seria legal para Tango y un desastre
    // para cualquiera que despues mire las dos fichas.
    const { codigos } = numeracion.planificar(['007610', '07611'], { estrategia: 'correlativo', cantidad: 1 });
    assert.deepStrictEqual(codigos, ['007612']);
});

test('devuelve varios candidatos para poder reintentar una colision', () => {
    // Si un operador da de alta en Tango en el mismo momento, el alta falla y
    // se reintenta con el siguiente sin volver a leer el padron entero.
    const { codigos } = numeracion.planificar(['007610'], { estrategia: 'correlativo', cantidad: 5 });
    assert.strictEqual(codigos.length, 5);
    assert.strictEqual(new Set(codigos).size, 5);
});

// -------------------------------------------------------------------- bordes

test('la estrategia es obligatoria y el error nombra la decision pendiente', () => {
    assert.throws(
        () => numeracion.planificar(codigosReales, { estrategia: undefined }),
        /decision de administracion/i
    );
    assert.throws(() => numeracion.planificar(codigosReales, { estrategia: 'lo-que-sea' }), /correlativo, reservado/);
});

test('un numero que no entra en 6 digitos falla en vez de escribirse mal', () => {
    assert.throws(() => numeracion.formatear(1234567), /se agoto/);
    assert.strictEqual(numeracion.formatear(7611), '007611');
});

test('padron vacio: el correlativo arranca en 000001', () => {
    const { codigos } = numeracion.planificar([], { estrategia: 'correlativo', cantidad: 1 });
    assert.deepStrictEqual(codigos, ['000001']);
});
