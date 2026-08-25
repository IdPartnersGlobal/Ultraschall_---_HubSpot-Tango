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

const verificar = (props, extra = {}) =>
    verificarEmpresa.verificar({ propiedades: props, mapper: m, lookups: lk, ...extra });

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
    assert.deepStrictEqual(r.resueltos.ID_GVA18, { codigo: '00', porDefecto: false }, 'deja a la vista el codigo del que salio');
    assert.strictEqual(r.valores.ID_GVA05, 10, 'zona: el codigo 09 es el ID 10, no el 9');
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

test('una provincia sin equivalencia en Tango cae en Desconocido, no frena', () => {
    // Decision de Matias 2026-08-25: default neutro en vez de bloquear. Y el
    // neutro no se inventa: 'Desconocido' es una fila propia de GVA18.
    const r = verificar({ ...COMPANY, provincia: 'ushuaia_centro' });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.ID_GVA18, 32);
    assert.deepStrictEqual(r.resueltos.ID_GVA18, { codigo: '31', porDefecto: true }, 'queda dicho que salio del default');
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

test('sin documento el tipo va SIN_IDENTIFICAR, pero el CUIT sigue haciendo falta', () => {
    const r = verificar({ ...COMPANY, cuit: '', tipo_de_documento: '' });
    assert.strictEqual(r.valores.ID_TIPO_DOCUMENTO_GV, 41, 'SIN_IDENTIFICAR es una fila real de TIPO_DOCUMENTO_GV');
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.problemas.map((p) => p.campo), ['CUIT'], 'lo unico que falta es el documento');
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

test('la parametria sale del default por moda y ya no frena el alta', () => {
    // Decision de Matias 2026-08-25: para lo que faltaba definir se usa el
    // valor que mas se repite en el padron. Los codigos viven en el catalogo
    // y el ID se resuelve contra la tabla viva.
    const r = verificar(COMPANY);
    assert.strictEqual(r.pendientes.length, 0);
    assert.strictEqual(r.valores.ID_GVA01, 1, 'CONTADO');
    assert.strictEqual(r.valores.ID_GVA10, 3, 'CON IVA EN $');
    assert.strictEqual(r.valores.ID_GVA24, 1, 'RETIRA CLIENTE');
    assert.strictEqual(r.valores.ID_GVA05, 10, 'ZONA NO DEFINIDA');
    for (const c of ['ID_GVA01', 'ID_GVA10', 'ID_GVA24', 'ID_GVA05']) {
        assert.strictEqual(r.resueltos[c].porDefecto, true, c + ' tiene que quedar marcado como default');
    }
});

test('lo que administracion decida despues pisa al default', () => {
    const r = verificar(COMPANY, { decididos: { ID_GVA10: 5 } });
    assert.strictEqual(r.valores.ID_GVA10, 5);
});

test('si la company ya trae el dato del sync, gana sobre el default', () => {
    // Una company que vino del timer tiene los tango_id_* cargados: son los del
    // cliente real, no un valor generico.
    const r = verificar({ ...COMPANY, tango_id_gva01: '14', tango_id_gva10: '2', tango_id_gva23: '7', tango_id_gva24: '3', tango_id_gva05: '1' });
    assert.strictEqual(r.pendientes.length, 0);
    assert.strictEqual(r.valores.ID_GVA01, 14, 'y llega como numero, no como el texto de HubSpot');
    assert.strictEqual(r.valores.ID_GVA10, 2);
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
    assert.deepStrictEqual(
        r.problemas.map((p) => p.campo).sort(),
        ['CUIT', 'DOMICILIO', 'ID_CATEGORIA_IVA', 'NOM_COM', 'RAZON_SOCI'],
        'solo lo que una persona tiene que cargar'
    );
});

// ── Neutros: lo que no frena el alta pero igual viaja ────────────────────

test('sin codigo postal ni localidad va un neutro, no un problema', () => {
    // MEDIDO 2026-08-25: 137 de 300 clientes del ERP no tienen codigo postal y
    // 9 no tienen localidad, ULTRASCHALL S.A. entre ellos. Si Tango los
    // exigiera, esos registros no podrian existir.
    const r = verificar({ ...COMPANY, zip: '', localidad: null });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.C_POSTAL, ' ');
    assert.strictEqual(r.valores.LOCALIDAD, ' ');
});

// ── Documento mal tipeado ────────────────────────────────────────────────

test('un documento mal tipeado viaja TAL CUAL y queda marcado', () => {
    // Decision de Matias 2026-08-25. Normalizarlo seria inventar un documento
    // que nadie cargo, y taparia el error justo cuando conviene que se vea.
    const r = verificar({ ...COMPANY, cuit: '30-6959420-3', tipo_de_documento: '' });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.CUIT, '30-6959420-3', 'ni se le sacan los guiones ni se completa');
    assert.strictEqual(r.valores.ID_TIPO_DOCUMENTO_GV, 41, 'SIN_IDENTIFICAR');
    assert.strictEqual(r.resueltos.documentoARevisar.sinNormalizar, true);
});

test('un CUIT de 11 digitos con el verificador mal tambien se marca', () => {
    // Caso real: 000576 Angeloni, Italo Domingo, CUIT 20-17627556-7.
    const r = verificar({ ...COMPANY, cuit: '20-17627556-7', tipo_de_documento: '' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.valores.CUIT, '20-17627556-7');
    assert.ok(r.resueltos.documentoARevisar);
});

test('un DNI de 7 u 8 digitos es normal: no se marca nada', () => {
    for (const dni of ['38.901.611', '33835690', '4548032']) {
        const r = verificar({ ...COMPANY, cuit: dni, tipo_de_documento: '' });
        assert.strictEqual(r.valores.CUIT, dni, 'viaja como lo escribieron');
        assert.strictEqual(r.resueltos.documentoARevisar, undefined, `${dni} no deberia marcarse`);
    }
});

test('un documento sin ningun digito si es problema', () => {
    const r = verificar({ ...COMPANY, cuit: 'a definir' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((p) => p.campo === 'CUIT'));
});

// ── Vendedor por owner ───────────────────────────────────────────────────

test('el vendedor sale del owner de la company', () => {
    const r = verificar({ ...COMPANY, hubspot_owner_email: 'jbutorac@ultraschall.com.ar' });
    assert.strictEqual(r.valores.ID_GVA23, 26, 'Juan Butorac es el codigo 24, que en GVA23 es el ID 26');
    assert.strictEqual(r.resueltos.ID_GVA23.codigo, '24');
    assert.strictEqual(r.resueltos.ID_GVA23.porOwner, 'jbutorac@ultraschall.com.ar');
});

test('el owner se puede resolver por id contra la tabla de owners', () => {
    // HubSpot guarda el ID del owner, no el mail: la tabla se lee aparte.
    const owners = { '90573355': 'jbutorac@ultraschall.com.ar' };
    const r = verificar({ ...COMPANY, hubspot_owner_id: '90573355' }, { owners });
    assert.strictEqual(r.valores.ID_GVA23, 26);
});

test('el mail del owner no distingue mayusculas', () => {
    const r = verificar({ ...COMPANY, hubspot_owner_email: 'JButorac@Ultraschall.com.ar' });
    assert.strictEqual(r.valores.ID_GVA23, 26);
});

test('un owner sin vendedor en Tango cae en FACUNDO y lo deja dicho', () => {
    // 23 de 27 vendedores no tienen owner: el match no se puede completar solo
    // porque GVA23.E_MAIL esta vacio en 26 de 27. Hasta que se complete a mano,
    // el default es el vendedor con el 63% de la cartera.
    const r = verificar({ ...COMPANY, hubspot_owner_email: 'pthaler@ultraschall.com.ar' });
    assert.strictEqual(r.valores.ID_GVA23, 10, 'FACUNDO');
    assert.strictEqual(r.resueltos.ID_GVA23.porDefecto, true);
    assert.strictEqual(r.resueltos.ID_GVA23.ownerSinEquivalencia, 'pthaler@ultraschall.com.ar');
});

test('una company sin owner tambien cae en el default', () => {
    const r = verificar(COMPANY);
    assert.strictEqual(r.valores.ID_GVA23, 10);
    assert.strictEqual(r.resueltos.ID_GVA23.ownerSinEquivalencia, null);
});

test('la tabla de owners del catalogo apunta a vendedores que existen', () => {
    const campo = verificarEmpresa.ALTA.campos.find((c) => c.tango === 'ID_GVA23');
    for (const [mail, codigo] of Object.entries(campo.porOwner)) {
        assert.ok(lk.resolver('vendedores', codigo, mail).ok, `${mail} apunta al vendedor ${codigo}, que no existe`);
    }
    assert.ok(lk.resolver('vendedores', campo.codigoPorDefecto, 'default').ok);
});
