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

/**
 * El owner del NEGOCIO ya no es opcional: sin vendedor equivalente el alta
 * frena (decision de Matias 2026-09-03). Los tests que no son sobre el vendedor
 * pasan uno valido, para poder ejercitar el resto del alta.
 */
const OWNER_VENDEDOR = 'jbutorac@ultraschall.com.ar'; // vendedor 24 -> ID 26

const verificar = (props, extra = {}) =>
    verificarEmpresa.verificar({ propiedades: props, mapper: m, lookups: lk, ownerId: OWNER_VENDEDOR, ...extra });

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

test('sin documento el alta SALE, con el tipo en SIN_IDENTIFICAR y un aviso', () => {
    // CAMBIO 2026-08-28: el CUIT frenaba el alta por suposicion. El sondeo
    // contra el ERP mostro que Tango NO lo exige (alta._sondeo), y la politica
    // es crear con lo minimo. Sigue avisandose: sin CUIT no se puede facturar.
    const r = verificar({ ...COMPANY, cuit: '', tipo_de_documento: '' });
    assert.strictEqual(r.valores.ID_TIPO_DOCUMENTO_GV, 41, 'SIN_IDENTIFICAR es una fila real de TIPO_DOCUMENTO_GV');
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.deepStrictEqual(r.avisos.map((a) => a.campo), ['CUIT'], 'no frena, pero no pasa en silencio');
    assert.match(r.avisos[0].comoSeArregla, /cuit/i);
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
    assert.ok(verificarEmpresa.ALTA.campos.length >= 18);
    assert.strictEqual(verificarEmpresa.ALTA._verificadoContraElERP, '2026-08-28', 'sondeado contra el ERP');
});

test('lo que frena el alta es lo que Tango exige, y nada mas', () => {
    // Sondeado contra el ERP el 2026-08-28 (alta._sondeo): de los 28 campos que
    // Tango pide, uno solo es un dato del negocio. Este test es la traduccion
    // de ese sondeo: si alguien vuelve a marcar el CUIT como obligatorio "por
    // las dudas", el circuito se frena entero otra vez.
    const sondeo = verificarEmpresa.ALTA._sondeo;
    const frenan = verificarEmpresa.ALTA.campos.filter((c) => c.obligatorio).map((c) => c.tango).sort();
    assert.deepStrictEqual(frenan, ['COD_GVA14', 'ID_CATEGORIA_IVA', 'RAZON_SOCI']);

    for (const campo of sondeo.NO_exigidos) {
        const def = verificarEmpresa.ALTA.campos.find((c) => c.tango === campo);
        if (def) assert.ok(!def.obligatorio, `${campo} no lo exige Tango y esta marcado obligatorio`);
    }
    for (const campo of frenan) {
        assert.ok(sondeo.exigidos.includes(campo), `${campo} frena el alta y el ERP no lo pide`);
    }
});

test('verificar no explota con una company vacia: informa', () => {
    // Una company COMPLETAMENTE vacia ya no frena por cinco campos: frena por
    // el unico que Tango exige de verdad y no se puede inventar.
    const r = verificarEmpresa.verificar({ propiedades: {}, mapper: m, lookups: lk, ownerId: OWNER_VENDEDOR });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.problemas.map((p) => p.campo).sort(), ['ID_CATEGORIA_IVA', 'RAZON_SOCI'],
        'los dos unicos que una persona tiene que decidir');
    assert.deepStrictEqual(
        r.avisos.map((a) => a.campo).sort(),
        ['CUIT', 'DOMICILIO'],
        'lo demas se crea con default y queda para completar'
    );
});

test('sin condicion de IVA el alta NO sale: la categoria fiscal se elige', () => {
    // DECISION DE MATIAS 2026-08-28, y es la unica excepcion a la politica del
    // alta minima: todo lo demas se completa con default, pero esto determina
    // COMO SE FACTURA. Un default equivocado no se nota hasta que sale mal una
    // factura. Llego a estar con RI por defecto y se saco.
    const r = verificarEmpresa.verificar({ propiedades: { razon_social: 'ACME SA' }, mapper: m, lookups: lk, ownerId: OWNER_VENDEDOR });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(r.problemas.map((p) => p.campo), ['ID_CATEGORIA_IVA']);
    assert.ok(!r.avisos.some((a) => a.campo === 'ID_CATEGORIA_IVA'), 'frena: no es un aviso');
});

test('el catalogo NO declara un default para la categoria de IVA', () => {
    // Si alguien le vuelve a poner codigoSiFalta, el alta empieza a inventar la
    // categoria fiscal en silencio. Esto es lo que lo impide.
    const campo = verificarEmpresa.ALTA.campos.find((c) => c.tango === 'ID_CATEGORIA_IVA');
    assert.strictEqual(campo.codigoSiFalta, undefined);
    assert.strictEqual(campo.obligatorio, true);
});

test('con la razon social y la condicion de IVA ya se puede dar de alta', () => {
    // Es la politica del 2026-08-28: si la empresa no tiene ID de Tango se crea
    // con lo minimo, y comercial completa despues.
    const r = verificarEmpresa.verificar({ propiedades: { razon_social: 'ACME SA', condicion_iva: 'Responsable Inscripto' }, mapper: m, lookups: lk, ownerId: OWNER_VENDEDOR });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.RAZON_SOCI, 'ACME SA');
    assert.strictEqual(r.valores.NOM_COM, 'ACME SA', 'el nombre de fantasia se cae a la razon social');
    assert.deepStrictEqual(r.avisos.map((a) => a.campo).sort(), ['CUIT', 'DOMICILIO'], 'lo que falta y no frena');
    for (const campo of verificarEmpresa.ALTA._sondeo.exigidos) {
        if (campo === 'COD_GVA14') continue; // lo pone lib/numeracion
        const esParametria = !verificarEmpresa.ALTA.campos.some((c) => c.tango === campo);
        if (esParametria) continue;          // sale de clientes.defaults
        assert.notStrictEqual(r.valores[campo], undefined, `${campo} lo exige Tango y quedo sin valor`);
    }
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

test('el vendedor sale del owner del negocio', () => {
    const r = verificar(COMPANY, { ownerId: 'jbutorac@ultraschall.com.ar' });
    assert.strictEqual(r.valores.ID_GVA23, 26, 'Juan Butorac es el codigo 24, que en GVA23 es el ID 26');
    assert.strictEqual(r.resueltos.ID_GVA23.codigo, '24');
    assert.strictEqual(r.resueltos.ID_GVA23.porOwner, 'jbutorac@ultraschall.com.ar');
});

test('el owner se puede resolver por id contra la tabla de owners', () => {
    // HubSpot guarda el ID del owner, no el mail: la tabla se lee aparte.
    const owners = { '90573355': 'jbutorac@ultraschall.com.ar' };
    const r = verificar(COMPANY, { ownerId: '90573355', owners });
    assert.strictEqual(r.valores.ID_GVA23, 26);
});

test('el mail del owner no distingue mayusculas', () => {
    const r = verificar(COMPANY, { ownerId: 'JButorac@Ultraschall.com.ar' });
    assert.strictEqual(r.valores.ID_GVA23, 26);
});

test('el owner de la COMPANY no decide nada: el vendedor sale del negocio', () => {
    // Decision de Matias (2026-09-03). Casi ninguna company tiene owner cargado
    // —la demo tampoco— asi que mirar ahi era mirar un campo vacio, y el
    // vendedor terminaba siendo el default sin que nada lo dijera.
    const r = verificar(
        { ...COMPANY, hubspot_owner_email: 'jgomez@ultraschall.com.ar' },
        { ownerId: 'jbutorac@ultraschall.com.ar' },
    );
    assert.strictEqual(r.valores.ID_GVA23, 26, 'el del negocio, no el de la company');
});

test('un owner sin vendedor en Tango FRENA el alta: no cae en FACUNDO', () => {
    // 23 de 27 owners no tienen vendedor, porque GVA23.E_MAIL esta vacio en 26
    // de 27 y el match hay que completarlo a mano. Antes esto caia en FACUNDO
    // —el 63% de la cartera— y el cliente quedaba con el vendedor de otro sin
    // que nadie se enterara hasta la comision (decision de Matias 2026-09-03).
    const r = verificar(COMPANY, { ownerId: 'pthaler@ultraschall.com.ar' });
    assert.strictEqual(r.ok, false);
    const p = r.problemas.find((x) => x.campo === 'ID_GVA23');
    assert.ok(p, `tendria que frenar por el vendedor: ${JSON.stringify(r.problemas)}`);
    assert.match(p.motivo, /pthaler@ultraschall\.com\.ar/, 'el mensaje dice QUE owner');
    assert.match(p.comoSeArregla, /porOwner/, 'y donde se arregla');
});

test('un negocio sin owner tambien frena, y lo dice distinto', () => {
    const r = verificar(COMPANY, { ownerId: null });
    assert.strictEqual(r.ok, false);
    const p = r.problemas.find((x) => x.campo === 'ID_GVA23');
    assert.match(p.motivo, /no tiene owner/);
});

test('un owner por ID sin la tabla de owners frena: no se puede resolver el mail', () => {
    // El estado real del worker hasta el 2026-09-03: `owners` llegaba null
    // porque solo se leia cuando el filtro traia mails.
    const r = verificar(COMPANY, { ownerId: '90573355', owners: null });
    assert.strictEqual(r.ok, false);
    assert.ok(r.problemas.some((x) => x.campo === 'ID_GVA23'));
});

test('la tabla de owners del catalogo apunta a vendedores que existen', () => {
    const campo = verificarEmpresa.ALTA.campos.find((c) => c.tango === 'ID_GVA23');
    for (const [mail, codigo] of Object.entries(campo.porOwner)) {
        assert.ok(lk.resolver('vendedores', codigo, mail).ok, `${mail} apunta al vendedor ${codigo}, que no existe`);
    }
    assert.strictEqual(campo.codigoPorDefecto, undefined,
        'el vendedor NO tiene default: sin equivalencia el alta frena (2026-09-03)');
});

// ── Lo que comercial elige en el desplegable (2026-09-01, §9.14) ──────────

test('lo que comercial elige en el desplegable llega al ERP', () => {
    // Hasta el 2026-09-01 estos cuatro campos eran texto libre y el alta ni los
    // miraba: siempre mandaba el default. Al volverlos desplegables pasaron a
    // INVITAR a elegir, y una eleccion descartada en silencio es peor que un
    // campo que no se puede tocar — comercial elige NOA y el cliente sale con
    // ZONA NO DEFINIDA sin que nada avise.
    const r = verificar({
        ...COMPANY,
        tango_zona: '04',              // NOA
        tango_transporte: '02',        // ULTRASCHALL
        tango_condicion_venta: '4',    // TARJETA DE CREDITO
        tango_lista_precios: '4',      // MEDICO SIN IVA $
    });
    assert.strictEqual(r.ok, true, JSON.stringify(r.problemas));
    assert.strictEqual(r.valores.ID_GVA05, 4, 'la zona elegida');
    assert.strictEqual(r.valores.ID_GVA24, 2, 'el transporte elegido');
    assert.strictEqual(r.valores.ID_GVA01, 4, 'la condicion de venta elegida');
    assert.strictEqual(r.valores.ID_GVA10, 4, 'la lista elegida');
    assert.strictEqual(r.resueltos.ID_GVA05.elegidoEn, 'tango_zona');
});

test('el codigo que se guarda no es el ID: elegir la zona 04 manda ID 4, no 4 por casualidad', () => {
    // La trampa de siempre (5.4). En transportes divergen 35 de 41: el codigo
    // '10' es el ID 15. Si alguien mandara el codigo como ID, el cliente
    // quedaria con OTRO transporte y nada fallaria.
    const fila = fixture('transportes').find((x) => x.COD_GVA24 === '10');
    assert.ok(fila && fila.ID_GVA24 !== 10, 'el fixture dejo de tener un caso donde divergen');
    const r = verificar({ ...COMPANY, tango_transporte: '10' });
    assert.strictEqual(r.valores.ID_GVA24, fila.ID_GVA24);
    assert.notStrictEqual(r.valores.ID_GVA24, 10);
});

test('sin elegir nada sigue yendo el default de siempre', () => {
    const r = verificar(COMPANY);
    assert.strictEqual(r.valores.ID_GVA05, 10, 'ZONA NO DEFINIDA');
    assert.strictEqual(r.valores.ID_GVA24, 1, 'RETIRA CLIENTE');
    assert.strictEqual(r.valores.ID_GVA01, 1, 'CONTADO');
    assert.strictEqual(r.resueltos.ID_GVA05.porDefecto, true);
});

test('una opcion que el ERP no resuelve FRENA el alta, no cae al default', () => {
    // Caer al default seria dar de alta el cliente en otra zona: valido, sin
    // que nada falle, y nadie se entera. Mismo criterio que el deposito (9.8).
    const r = verificar({ ...COMPANY, tango_zona: '99' });
    assert.strictEqual(r.ok, false);
    assert.ok(
        r.problemas.some((p) => p.campo === 'ID_GVA05' && /tango_zona/.test(p.motivo)),
        `deberia frenar por la zona: ${JSON.stringify(r.problemas)}`,
    );
    assert.strictEqual(r.valores.ID_GVA05, undefined, 'no se manda nada');
});

test('el ID que ya trae la company le gana al desplegable', () => {
    // Si la company vino del sync, tango_id_gva05 es el dato de Tango. El
    // desplegable esta para las que se cargan a mano.
    const r = verificar({ ...COMPANY, tango_id_gva05: 7, tango_zona: '04' });
    assert.strictEqual(r.valores.ID_GVA05, 7);
});

test('el vendedor NO lo decide el desplegable: sigue saliendo del owner', () => {
    // Decision de Matias (2026-09-01): tango_vendedor queda como espejo de
    // Tango. Por eso es el unico de los seis que guarda la descripcion y no el
    // codigo, y el unico sin `hubspotOpcion` en el catalogo.
    const r = verificar({ ...COMPANY, tango_vendedor: 'DAVID' });
    assert.strictEqual(r.valores.ID_GVA23, 26, 'Juan Butorac, el del owner del negocio');
    const campo = verificarEmpresa.ALTA.campos.find((c) => c.tango === 'ID_GVA23');
    assert.strictEqual(campo.hubspotOpcion, undefined);
});
