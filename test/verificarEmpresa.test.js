'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const verificarEmpresa = require('../src/lib/verificarEmpresa');
const { crear } = require('../src/lib/mapper');
const { Lookups } = require('../src/lib/lookups');
const mapeoClientes = require('../config/mapeo.clientes.json');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

const lk = Lookups.desdeRegistros({
    condicionesVenta: fixture('condicionesVenta'),
    vendedores: fixture('vendedores'),
    transportes: fixture('transportes'),
    provincias: fixture('provincias'),
    zonas: fixture('zonas'),
    alicuotasIva: fixture('alicuotasIva'),
});
const m = crear(mapeoClientes, lk);

/** Una company como la carga comercial en HubSpot: sin ningun campo tango_*. */
const COMPANY = {
    name: 'Clinica Prueba',
    razon_social: 'CLINICA PRUEBA S.A.',
    cuit: '30-70985931-1',
    tipo_de_documento: 'CUIT',
    condicion_iva: 'Responsable Inscripto',
    domicilio_del_consultorio: 'Av. Corrientes 1234',
    localidad: 'CABA',
    zip: '1000',
    provincia: 'caba',
    country: 'ARGENTINA',
    phone: '11 4333-2222',
    correo_electronico: 'contacto@prueba.com',
};

/** Lo que administracion todavia no definio, resuelto a mano para los tests. */
const DECIDIDOS = { ID_GVA01: 1, ID_GVA10: 3, ID_GVA23: 10, ID_GVA24: 1, ID_GVA05: 1 };

const verificar = (props, decididos = DECIDIDOS) =>
    verificarEmpresa.verificar({ propiedades: props, mapper: m, lookups: lk, decididos });

// ── El caso feliz ────────────────────────────────────────────────────────

test('una company completa pasa, y deja los campos de Tango resueltos', () => {
    const r = verificar(COMPANY);
    assert.strictEqual(r.ok, true, JSON.stringify([r.problemas, r.pendientes]));
    assert.strictEqual(r.valores.RAZON_SOCI, 'CLINICA PRUEBA S.A.');
    assert.strictEqual(r.valores.NOM_COM, 'Clinica Prueba');
    assert.strictEqual(r.valores.CUIT, '30-70985931-1');
    assert.strictEqual(r.valores.GVA133_NOM_PAIS, 'ARGENTINA');
});

test('los desplegables se resuelven al ID interno, no al codigo', () => {
    // Es la regla de 5.4: el codigo NO es el ID, y el alta pide el ID.
    const r = verificar(COMPANY);
    assert.strictEqual(r.valores.ID_TIPO_DOCUMENTO_GV, 26, 'C.U.I.T. es el 26, no el 80 ni el 1');
    assert.strictEqual(r.valores.ID_CATEGORIA_IVA, 1, 'RI');
    assert.strictEqual(typeof r.valores.ID_GVA18, 'number');
    assert.strictEqual(r.resueltos.ID_GVA18, '00', 'y deja a la vista el codigo del que salio');
});

test('el CUIT sale con guiones aunque venga sin ellos', () => {
    // Tango los exige en el alta (2026-08-18).
    const r = verificar({ ...COMPANY, cuit: '30709859311' });
    assert.strictEqual(r.valores.CUIT, '30-70985931-1');
});

// ── Lo que puede arreglar una persona ────────────────────────────────────

test('falta la razon social: es un problema, y dice donde cargarla', () => {
    const r = verificar({ ...COMPANY, razon_social: '   ' });
    assert.strictEqual(r.ok, false);
    const p = r.problemas.find((x) => x.campo === 'RAZON_SOCI');
    assert.ok(p, 'tiene que senalar RAZON_SOCI');
    assert.strictEqual(p.propiedad, 'razon_social');
    assert.match(p.comoSeArregla, /razon_social/);
});

test('sin nombre de fantasia se cae a la razon social en vez de frenar', () => {
    // NOM_COM es obligatorio para Tango pero no es un dato que comercial tenga
    // que inventar: la razon social alcanza.
    const r = verificar({ ...COMPANY, name: '' });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.NOM_COM, 'CLINICA PRUEBA S.A.');
});

test('una provincia sin equivalencia en Tango se reporta, no se adivina', () => {
    const r = verificar({ ...COMPANY, provincia: 'ushuaia_centro' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'ID_GVA18'));
});

test('una condicion de IVA que no esta en el catalogo se reporta', () => {
    const r = verificar({ ...COMPANY, condicion_iva: 'Responsable Sustituto' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'ID_CATEGORIA_IVA'));
});

test('sin tipo de documento se infiere del numero, como en la lectura', () => {
    // El 54% del padron tiene el tipo sin definir (7.2). Frenar el alta por eso
    // seria pedirle a comercial un dato que el propio ERP no tiene.
    const r = verificar({ ...COMPANY, tipo_de_documento: '' });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.ID_TIPO_DOCUMENTO_GV, 26);
    assert.strictEqual(r.resueltos.tipoDocumento.inferido, true, 'queda constancia de que fue inferido');
});

test('sin documento y sin tipo no se puede inventar el ID: es problema', () => {
    const r = verificar({ ...COMPANY, cuit: '', tipo_de_documento: '' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'ID_TIPO_DOCUMENTO_GV'));
    assert.ok(r.problemas.some((p) => p.campo === 'CUIT'), 'y tambien falta el CUIT');
});

test('telefono y mail no frenan el alta', () => {
    const r = verificar({ ...COMPANY, phone: '', correo_electronico: '' });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.TELEFONO_1, undefined);
});

test('sin pais se manda ARGENTINA', () => {
    const r = verificar({ ...COMPANY, country: '' });
    assert.strictEqual(r.valores.GVA133_NOM_PAIS, 'ARGENTINA');
});

// ── Lo que NO puede arreglar nadie desde HubSpot ─────────────────────────

test('lo que falta definir va a `pendientes`, separado de los problemas', () => {
    // El punto de la separacion: mandar a comercial a buscar la lista de
    // precios de un cliente nuevo es mandarlo a buscar un dato que no existe.
    const r = verificar(COMPANY, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.problemas.length, 0, 'la company esta completa: no hay nada que arreglar en HubSpot');
    assert.deepStrictEqual(
        r.pendientes.map((p) => p.campo).sort(),
        ['ID_GVA01', 'ID_GVA05', 'ID_GVA10', 'ID_GVA23', 'ID_GVA24']
    );
    assert.ok(r.pendientes.every((p) => p.quienLoDefine === 'administracion'));
    assert.ok(r.pendientes.every((p) => p.queFalta), 'cada pendiente dice que falta decidir');
});

test('lo que administracion ya decidio deja de ser pendiente', () => {
    const r = verificar(COMPANY, { ...DECIDIDOS });
    assert.strictEqual(r.pendientes.length, 0);
    assert.strictEqual(r.valores.ID_GVA10, 3);
});

test('si la company ya trae el dato del sync, no hace falta la decision', () => {
    // Una company que vino del timer tiene los tango_id_* cargados.
    const r = verificar({ ...COMPANY, tango_id_gva01: '14', tango_id_gva10: '2', tango_id_gva23: '7', tango_id_gva24: '3', tango_id_gva05: '1' }, {});
    assert.strictEqual(r.pendientes.length, 0);
    assert.strictEqual(r.valores.ID_GVA01, 14, 'y llega como numero, no como el texto de HubSpot');
});

// ── Duplicados ───────────────────────────────────────────────────────────

test('busca duplicados por codigo Y por documento', () => {
    // "Verificar empresa" mirando solo el codigo deja pasar el duplicado justo
    // en el caso que importa: la company que cargo comercial no tiene codigo.
    const consultas = [];
    const tangoFalso = {
        async getByFilter(process, condicion) {
            consultas.push(condicion);
            return condicion.startsWith('CUIT') ? [{ COD_GVA14: '000123' }, { COD_GVA14: '004567' }] : [];
        },
    };
    return verificarEmpresa.buscarDuplicados({ tango: tangoFalso, codigo: '007611', documento: '30-70985931-1' })
        .then((r) => {
            assert.deepStrictEqual(consultas, ["COD_GVA14 = '007611'", "CUIT = '30-70985931-1'"]);
            assert.strictEqual(r.porCodigo, null);
            assert.strictEqual(r.porDocumento.length, 2, 'un CUIT repetido devuelve varios: no es clave');
        });
});

test('sin codigo igual busca por documento', () => {
    const consultas = [];
    const tangoFalso = { async getByFilter(_p, c) { consultas.push(c); return []; } };
    return verificarEmpresa.buscarDuplicados({ tango: tangoFalso, documento: '30709859311' })
        .then(() => assert.deepStrictEqual(consultas, ["CUIT = '30709859311'"]));
});

test('un valor que no tiene forma de codigo o documento no entra al filtro', () => {
    // filtroSql es SQL concatenado del lado del ERP (10.0) y el dato puede
    // venir de un webhook. Se valida la forma antes de concatenar.
    const consultas = [];
    const tangoFalso = { async getByFilter(_p, c) { consultas.push(c); return []; } };
    return verificarEmpresa.buscarDuplicados({ tango: tangoFalso, codigo: "007611' OR '1'='1", documento: '30;DROP' })
        .then((r) => {
            assert.deepStrictEqual(consultas, [], 'no se consulto nada');
            assert.deepStrictEqual(r.consultado, { codigo: null, documento: null });
        });
});

test('literalSeguro acepta lo valido y rechaza lo que no tiene esa forma', () => {
    assert.strictEqual(verificarEmpresa.literalSeguro('007611', verificarEmpresa.COD_SEGURO), '007611');
    assert.strictEqual(verificarEmpresa.literalSeguro('30-70985931-1', verificarEmpresa.DOC_SEGURO), '30-70985931-1');
    for (const malo of ["a'--", 'x y', '', null, undefined, '30-7098-5931-1-99999']) {
        assert.strictEqual(verificarEmpresa.literalSeguro(malo, verificarEmpresa.DOC_SEGURO), null, `deberia rechazar ${malo}`);
    }
});

// ── El catalogo ──────────────────────────────────────────────────────────

test('el catalogo de campos del alta vive en config, no en el codigo', () => {
    // Cuando se sondee contra el ERP hay que poder corregirlo editando un JSON.
    assert.ok(verificarEmpresa.ALTA.campos.length >= 18);
    assert.strictEqual(verificarEmpresa.ALTA._verificadoContraElERP, false,
        'sigue sin sondearse: si esto cambia a true, revisar que los obligatorios sean los reales');
});

test('verificar no explota con una company vacia: informa', () => {
    const r = verificarEmpresa.verificar({ propiedades: {}, mapper: m, lookups: lk });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.length > 0);
    assert.ok(r.pendientes.length > 0);
});
