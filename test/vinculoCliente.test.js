'use strict';

const test = require('node:test');
const assert = require('node:assert');

const v = require('../src/lib/vinculoCliente');

/**
 * ¿La empresa de HubSpot es el cliente de Tango que dice ser? (§7.14)
 *
 * Los casos salen del cruce de las 7.586 empresas importadas el 2026-09-03
 * contra el padron de Tango (2026-09-15). Los nombres y documentos son
 * inventados; la forma de cada problema es la real.
 */

const fila = (over = {}) => ({ COD_GVA14: '000466', RAZON_SOCI: 'Gomez, Marta', NOM_COM: 'Gomez, Marta', CUIT: '27-10000001-5', ...over });

// ── el codigo que declara la empresa ────────────────────────────────────────

test('la clave del sync gana sobre el codigo de la planilla', () => {
    assert.strictEqual(v.codigoDeclarado({ tango_codigo_cliente: '000466', codigo_tango: '999' }), '000466');
    assert.strictEqual(v.codigoDeclarado({ codigo_tango: ' 000466 ' }), '000466');
    assert.strictEqual(v.codigoDeclarado({ codigo_tango: '' }), null);
    assert.strictEqual(v.codigoDeclarado({}), null);
});

test('el codigo no se normaliza: los ceros a la izquierda son parte del codigo', () => {
    // 04078 y 004078 son dos clientes distintos en Tango (§7.5).
    assert.strictEqual(v.codigoDeclarado({ codigo_tango: '04078' }), '04078');
});

// ── el documento ────────────────────────────────────────────────────────────

test('mismo CUIT, aunque uno venga con guiones y el otro como numero', () => {
    const r = v.comparar({ cuit: 27100000015, name: 'Otro nombre' }, fila());
    assert.deepStrictEqual(r, { mismo: true, por: 'documento', documento: 'coincide' });
});

test('el DNI de un lado y el CUIT del otro son la misma persona', () => {
    // 2 de las 8 importadas que "no coincidian" eran esto.
    assert.strictEqual(v.comparar({ cuit: 20301234565 }, fila({ CUIT: '30123456' })).mismo, true);
    assert.strictEqual(v.comparar({ cuit: '30123456' }, fila({ CUIT: '20-30123456-5' })).mismo, true);
    assert.strictEqual(v.comparar({ cuit: 20301234565 }, fila({ CUIT: '30123457' })).mismo, false);
});

test('CUIT distinto NO es el mismo cliente, aunque el nombre sea identico', () => {
    // Caso real: una empresa con el nombre de fantasia de un cliente y otro CUIT.
    const r = v.comparar({ cuit: 30999999995, name: 'Gomez, Marta' }, fila());
    assert.deepStrictEqual(r, { mismo: false, por: null, documento: 'distinto' });
});

test('un documento que no es documento no se compara', () => {
    // En Tango hay un cliente real con CUIT `12.345.678`, y en HubSpot uno de 12 digitos.
    assert.strictEqual(v.documentoComparable('12.345.678'), null);
    assert.strictEqual(v.documentoComparable('11111111'), null);
    assert.strictEqual(v.documentoComparable('123'), null);
    assert.strictEqual(v.documentoComparable('150699160017'), null);
    assert.strictEqual(v.documentoComparable('27-10000001-5'), '27100000015');
});

// ── el nombre, solo cuando no hay documento ─────────────────────────────────

test('sin documento decide el nombre, sin importar orden, acentos ni forma juridica', () => {
    assert.strictEqual(v.comparar({ name: 'Marta Gomez' }, fila({ CUIT: '' })).mismo, true);
    assert.strictEqual(v.mismoNombre('Clínica Andina S.A.', 'CLINICA ANDINA'), true);
    assert.strictEqual(v.mismoNombre('Cardio Demo S.R.L.', 'Cardio Demo'), true);
    // La razon social de un lado y el nombre de fantasia del otro tambien vale.
    assert.strictEqual(v.comparar({ razon_social: 'Demo Medica S.A.', name: 'Lopez Carla' }, fila({ CUIT: '', RAZON_SOCI: 'DEMO MEDICA SA', NOM_COM: 'x' })).mismo, true);
});

test('por nombre se exige que sean LAS MISMAS palabras', () => {
    // La forma de los casos reales que un criterio de "se parecen" juntaba.
    assert.strictEqual(v.mismoNombre('Fernandez Ana Victoria', 'Fernandez Ana Virginia'), false, 'dos hermanas');
    assert.strictEqual(v.mismoNombre('Club Social Barrancas del Norte', 'Club Social Norte'), false, 'dos clubes');
    assert.strictEqual(v.mismoNombre('Rojas Pedro', 'Pedro Luis Diaz Rojas'), false, 'dos personas');
    assert.strictEqual(v.mismoNombre('Ministerio de Salud de la Provincia', 'Ministerio de Salud'), false);
});

test('sin documento y con otro nombre no es el mismo', () => {
    const r = v.comparar({ name: 'Fundacion de Apoyo' }, fila({ CUIT: '' }));
    assert.deepStrictEqual(r, { mismo: false, por: null, documento: 'sin-dato' });
});

test('un nombre vacio no coincide con nada', () => {
    assert.strictEqual(v.mismoNombre('', ''), false);
    assert.strictEqual(v.mismoNombre('S.A.', 'SRL'), false, 'solo forma juridica no identifica a nadie');
});

// ── contra Tango ────────────────────────────────────────────────────────────

const tangoCon = (filas) => {
    const t = { consultas: [] };
    t.getByFilter = async (process, filtro) => { t.consultas.push({ process, filtro }); return filas; };
    return t;
};

test('sin codigo no se consulta nada', async () => {
    const tango = tangoCon([]);
    const r = await v.buscar({ tango, props: { name: 'x' } });
    assert.strictEqual(r.estado, 'sin-codigo');
    assert.strictEqual(tango.consultas.length, 0);
});

test('el mismo cliente devuelve la fila, para no volver a leerla', async () => {
    const r = await v.buscar({ tango: tangoCon([fila()]), props: { codigo_tango: '000466', cuit: 27100000015 } });
    assert.strictEqual(r.estado, 'mismo');
    assert.strictEqual(r.fila.COD_GVA14, '000466');
    assert.strictEqual(r.problema, undefined);
});

test('si Tango devuelve una fila con OTRO codigo, no existe', async () => {
    // El filtro es por igualdad, pero no se da por hecho como compara el ERP.
    const r = await v.buscar({ tango: tangoCon([fila({ COD_GVA14: '00466' })]), props: { codigo_tango: '000466' } });
    assert.strictEqual(r.estado, 'no-existe');
});

test('no existe: el problema es para corregir, con las dos salidas', async () => {
    const r = await v.buscar({ tango: tangoCon([]), props: { codigo_tango: '002410', name: 'Hospital Rural' } });
    assert.strictEqual(r.estado, 'no-existe');
    assert.strictEqual(r.problema.campo, 'COD_GVA14');
    assert.strictEqual(r.problema.clase, 'corregir');
    assert.match(r.problema.motivo, /«Hospital Rural» tiene cargado el código 002410/);
    assert.match(r.problema.comoSeArregla, /corregirlo si está mal/);
    assert.match(r.problema.comoSeArregla, /borrar el código/);
});

test('otro cliente: dice de quien es el codigo y los dos CUIT', async () => {
    const r = await v.buscar({ tango: tangoCon([fila()]), props: { codigo_tango: '000466', name: 'Tienda Demo', cuit: 30999999995 } });
    assert.strictEqual(r.estado, 'otro-cliente');
    assert.match(r.problema.motivo, /es de otro cliente: en Tango es «Gomez, Marta», con CUIT 27-10000001-5/);
    assert.match(r.problema.motivo, /«Tienda Demo» tiene CUIT 30-99999999-5/);
});

test('otro cliente sin CUIT en la empresa: pide cargarlo para confirmar', async () => {
    const r = await v.buscar({ tango: tangoCon([fila()]), props: { codigo_tango: '000466', name: 'Za' } });
    assert.strictEqual(r.estado, 'otro-cliente');
    assert.match(r.problema.motivo, /la empresa no tiene CUIT cargado/);
    assert.match(r.problema.comoSeArregla, /cargar su CUIT en la empresa/);
});

test('otro cliente sin CUIT en TANGO: no le pide a comercial un dato que ya cargo', async () => {
    // Caso real: la importada tenia CUIT y el cliente de Tango no. Pedirle que
    // lo cargue en la empresa no destraba nada.
    const r = await v.buscar({ tango: tangoCon([fila({ CUIT: '' })]), props: { codigo_tango: '000466', name: 'Fundacion Demo', cuit: 30999999995 } });
    assert.strictEqual(r.estado, 'otro-cliente');
    assert.match(r.problema.motivo, /ese cliente no tiene CUIT cargado en Tango/);
    assert.doesNotMatch(r.problema.comoSeArregla, /cargar su CUIT en la empresa/);
    assert.match(r.problema.comoSeArregla, /administración/);
});

test('un codigo con forma invalida no llega al filtro SQL', async () => {
    const tango = tangoCon([fila()]);
    const r = await v.buscar({ tango, props: { codigo_tango: "1' OR '1'='1" } });
    assert.strictEqual(r.estado, 'codigo-invalido');
    assert.strictEqual(tango.consultas.length, 0);
});

test('si el ERP no contesta, se propaga: no es un codigo inexistente', async () => {
    const tango = { getByFilter: async () => { throw new Error('fetch failed'); } };
    await assert.rejects(() => v.buscar({ tango, props: { codigo_tango: '000466' } }), /fetch failed/);
});
