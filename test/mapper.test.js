'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { crear, transforms, castear } = require('../src/lib/mapper');
const documento = require('../src/lib/documento');
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

const clientes = fixture('clientes-muestra');
const mapper = crear(mapeoClientes, lk);

// ------------------------------------------------------------------ transforms

test('documentoConGuiones: un solo formato, texto con guiones', () => {
    // Decision de Ultraschall 2026-08-18. Tango exige los guiones en el alta.
    assert.strictEqual(transforms.documentoConGuiones('30-70985931-1'), '30-70985931-1');
    assert.strictEqual(transforms.documentoConGuiones('30709859311'), '30-70985931-1', 'normaliza al mismo formato');
    assert.strictEqual(transforms.documentoConGuiones(''), null);
    assert.strictEqual(transforms.documentoConGuiones(null), null);
});

test('documentoConGuiones no le pone mascara de CUIT a un DNI', () => {
    // El campo CUIT de Tango tambien trae DNIs segun el tipo de documento.
    assert.strictEqual(transforms.documentoConGuiones('38.901.611'), '38901611');
    assert.strictEqual(transforms.documentoConGuiones('33835690'), '33835690');
});

test('documentoSoloDigitos: numero, sin guiones', () => {
    // DECISION 2026-08-27: la propiedad `cuit` del portal es `number` y no se
    // borra para recrearla como texto (7.2), asi que se adapta el valor.
    assert.strictEqual(transforms.documentoSoloDigitos('30-70985931-1'), 30709859311);
    assert.strictEqual(transforms.documentoSoloDigitos('38.901.611'), 38901611);
    assert.strictEqual(transforms.documentoSoloDigitos(''), null);
    assert.strictEqual(transforms.documentoSoloDigitos(null), null);
    assert.strictEqual(transforms.documentoSoloDigitos('sin numeros'), null);
});

test('un documento con cero adelante se omite y se reporta, no se trunca', () => {
    // '01234567' guardado como numero es 1234567, que es OTRO documento.
    const r = transforms.documentoSoloDigitos('01234567');
    assert.strictEqual(r.omitir, true);
    assert.match(r.motivo, /cero/);
});

test('el CUIT llega a HubSpot como numero, sin guiones', () => {
    const c = clientes.find((x) => /^\d{2}-\d{8}-\d$/.test(String(x.CUIT || '')));
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(typeof propiedades.cuit, 'number');
    assert.strictEqual(propiedades.cuit, Number(String(c.CUIT).replace(/\D/g, '')));
});

test('los guiones no desaparecen del circuito: vuelven en la ida a Tango', () => {
    // Guardar y mandar dejan de tener el mismo formato a proposito. Tango sigue
    // exigiendo los guiones en el alta, y se los repone documento.formatear.
    const c = clientes.find((x) => /^\d{2}-\d{8}-\d$/.test(String(x.CUIT || '')));
    const { propiedades } = mapper.aHubSpot(c);
    assert.match(documento.formatear(propiedades.cuit), /^\d{2}-\d{8}-\d$/);
});

test('ningun documento de la muestra empieza con cero', () => {
    // Es lo que hace que la decision de guardar el CUIT como numero no rompa
    // nada HOY. Si esto se pone en rojo, el campo numerico dejo de alcanzar.
    const conCero = clientes.filter((c) => String(c.CUIT ?? '').replace(/\D/g, '').startsWith('0'));
    assert.deepStrictEqual(conCero.map((c) => c.CUIT), []);
});

test('normalizarTelefono conserva el + internacional', () => {
    assert.strictEqual(transforms.normalizarTelefono('(0376)4434782'), '03764434782');
    assert.strictEqual(transforms.normalizarTelefono('+54 11 4444-5555'), '+541144445555');
    assert.strictEqual(transforms.normalizarTelefono('   '), null);
});

test('normalizarUrl agrega esquema y descarta basura', () => {
    assert.strictEqual(transforms.normalizarUrl('www.ejemplo.com'), 'http://www.ejemplo.com/');
    assert.strictEqual(transforms.normalizarUrl('https://a.com/x'), 'https://a.com/x');
    assert.strictEqual(transforms.normalizarUrl('sin punto'), null);
    assert.strictEqual(transforms.normalizarUrl(''), null);
});

test('fechaTangoAEpoch da medianoche UTC', () => {
    const e = transforms.fechaTangoAEpoch('2018-08-29T00:00:00');
    assert.strictEqual(e, Date.UTC(2018, 7, 29));
    assert.strictEqual(new Date(e).toISOString(), '2018-08-29T00:00:00.000Z');
    assert.strictEqual(transforms.fechaTangoAEpoch(null), null);
});

test('castear no convierte string vacio en 0 ni en ""', () => {
    assert.strictEqual(castear('', 'string'), null);
    assert.strictEqual(castear('', 'number'), null);
    assert.strictEqual(castear('abc', 'number'), null);
    assert.strictEqual(castear('5', 'number'), 5);
    assert.strictEqual(castear('S', 'bool'), true);
    assert.strictEqual(castear('N', 'bool'), false);
});

// --------------------------------------------------------------------- mapeo

test('los campos con lookup guardan el ID interno, no el codigo', () => {
    // Cliente real con vendedor codigo 24 (Juan Butorac -> ID 26).
    const c = clientes.find((x) => Number(x.GVA23_CODIGO) === 24);
    assert.ok(c, 'la muestra tiene algun cliente con vendedor 24');

    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_id_gva23, 26, 'debe guardar el ID interno');
    assert.notStrictEqual(propiedades.tango_id_gva23, 24, 'nunca el codigo');
});

test('la provincia se resuelve al ID correcto (el bug de los 4022 clientes)', () => {
    const c = clientes.find((x) => Number(x.GVA18_CODIGO) === 1);
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    // codigo 1 = Buenos Aires, ID interno 2. Sin lookup se grabaria 1 = Capital Federal.
    assert.strictEqual(propiedades.tango_id_gva18, 2);
    assert.strictEqual(propiedades.provincia, 'buenos_aires');
});

test('GVA05 mapea a zona y GVA23 a vendedor (no al reves)', () => {
    const c = clientes.find((x) => x.GVA05_CODIGO && x.GVA23_DESCRIPCION);
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    // La zona guarda el CODIGO desde el 2026-09-01 (§9.14): es un desplegable
    // de ENTRADA, y `lookups.resolver` traduce codigo -> ID interno, no
    // descripcion. El vendedor sigue guardando la descripcion porque quedo
    // como espejo: lo elige el owner, no la ficha.
    assert.strictEqual(propiedades.tango_zona, String(c.GVA05_CODIGO).trim());
    assert.strictEqual(propiedades.tango_vendedor, c.GVA23_DESCRIPCION);
});

test('lo que guarda un desplegable de entrada es lo que el ERP sabe resolver', () => {
    // El punto de todo el cambio: el valor guardado tiene que poder volver a
    // Tango. Con la descripcion no vuelve — resolver('zonas', 'NOA') falla y
    // resolver('zonas', '04') da 4.
    const c = clientes.find((x) => x.GVA05_CODIGO && x.GVA24_CODIGO && x.GVA01_COND_VTA);
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    for (const [prop, tabla] of [['tango_zona', 'zonas'], ['tango_transporte', 'transportes'], ['tango_condicion_venta', 'condicionesVenta']]) {
        const guardado = propiedades[prop];
        assert.ok(guardado !== undefined, `${prop} no se escribio`);
        const r = lk.resolver(tabla, guardado, prop);
        assert.ok(r.ok, `${prop}: el ERP no sabe resolver '${guardado}' (${r.motivo})`);
    }
});

test('un codigo que no resuelve se omite y se reporta, no se inventa', () => {
    const c = { ...clientes[0], GVA23_CODIGO: 9999 };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_id_gva23, undefined, 'no debe escribir un valor incorrecto');
    assert.ok(problemas.some((p) => /vendedores.*9999.*no existe/.test(p)));
});

test('un codigo vacio no genera problema: es ausencia de dato, no un error', () => {
    const c = { ...clientes[0], GVA23_CODIGO: '' };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_id_gva23, undefined);
    assert.ok(!problemas.some((p) => /vendedores/.test(p)));
});

test('la clave de idempotencia es COD_GVA14', () => {
    assert.strictEqual(mapper.clave(clientes[0]), String(clientes[0].COD_GVA14).trim());
});

test('name es el nombre de fantasia y la razon social va aparte', () => {
    // Decision de la planilla de Ultraschall: name = NOM_COM, no RAZON_SOCI.
    const c = clientes.find((x) => x.NOM_COM && x.RAZON_SOCI && x.NOM_COM !== x.RAZON_SOCI);
    assert.ok(c, 'la muestra tiene algun cliente con fantasia distinta de la razon social');
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.name, c.NOM_COM);
    assert.strictEqual(propiedades.razon_social, c.RAZON_SOCI);
});

test('el telefono va a phone, no a un campo de direccion (fila 16 de la planilla)', () => {
    const c = clientes.find((x) => x.TELEFONO_1);
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    assert.ok(propiedades.phone, 'TELEFONO_1 debe ir a phone');
    assert.strictEqual(propiedades.domicilio_fiscal, undefined, 'nunca a domicilio_fiscal');
});

test('el mapper exige lookups si el mapeo los usa', () => {
    assert.throws(() => crear(mapeoClientes, null), /no se paso la instancia de lookups/);
});

// ---------------------------------------------------------------------- hash

test('el hash es estable ante el orden de las claves', () => {
    const a = mapper.hash({ x: 1, y: 2 });
    const b = mapper.hash({ y: 2, x: 1 });
    assert.strictEqual(a, b);
});

test('el hash cambia si cambia un valor', () => {
    assert.notStrictEqual(mapper.hash({ x: 1 }), mapper.hash({ x: 2 }));
});

// ----------------------------------------------------------- corrida completa

test('mapea los 300 clientes de la muestra sin excepciones', () => {
    let conProblemas = 0;
    const hashes = new Set();

    // La propiedad clave se lee del mapeo, no se hardcodea: los nombres
    // internos los define la planilla de Ultraschall y pueden cambiar.
    const propClave = mapeoClientes._meta.claveIdempotencia.hubspot;

    for (const c of clientes) {
        const { propiedades, problemas } = mapper.aHubSpot(c);
        assert.ok(propiedades[propClave], `todo cliente debe tener la clave (${propClave})`);
        assert.strictEqual(typeof propiedades.tango_id_gva14, 'number');
        if (problemas.length) conProblemas++;
        hashes.add(mapper.hash(propiedades));
    }

    // Los hashes deben ser mayormente distintos: si colapsaran, el sync
    // diferencial no detectaria cambios.
    assert.ok(hashes.size > clientes.length * 0.95, `hashes distintos: ${hashes.size}/${clientes.length}`);
    assert.ok(conProblemas < clientes.length, 'no todos los clientes pueden tener problemas');
});

// ------------------------------------------------- dominio y deduplicacion

test('dominioDeMail descarta proveedores gratuitos', () => {
    // El dominio de un gmail no identifica a la empresa: usarlo como `domain`
    // haria que HubSpot fusione todos los clientes con gmail.
    assert.strictEqual(transforms.dominioDeMail('juan@gmail.com'), null);
    assert.strictEqual(transforms.dominioDeMail('x@hotmail.com.ar'), null);
    assert.strictEqual(transforms.dominioDeMail('x@fibertel.com.ar'), null);
    assert.strictEqual(transforms.dominioDeMail('ventas@conmil.com.ar'), 'conmil.com.ar');
});

test('dominioDeMail descarta el dominio de Ultraschall', () => {
    // MAIL_DE incluye al vendedor de Ultraschall que recibe copia de los
    // comprobantes: 903 clientes quedarian con este dominio y se fusionarian.
    assert.strictEqual(transforms.dominioDeMail('farancibia@ultraschall.com.ar'), null);
});

test('dominioDeMail toma la primera direccion de una lista', () => {
    // MAIL_DE viene como "a@x.com; b@y.com; c@z.com"
    assert.strictEqual(
        transforms.dominioDeMail('altatecnologia@empresa.com.ar; otro@fibertel.com.ar'),
        'empresa.com.ar'
    );
    assert.strictEqual(transforms.dominioDeMail(''), null);
    assert.strictEqual(transforms.dominioDeMail('no es un mail'), null);
});

test('un dominio compartido por dos clientes no se asigna a ninguno', () => {
    const { calcularDominiosUnicos } = require('../src/lib/syncClientes');
    const base = clientes[0];
    const lote = [
        { ...base, COD_GVA14: 'A1', MAIL_DE: 'uno@compartido.com.ar' },
        { ...base, COD_GVA14: 'A2', MAIL_DE: 'dos@compartido.com.ar' },
        { ...base, COD_GVA14: 'A3', MAIL_DE: 'tres@propio.com.ar' },
    ];
    const unicos = calcularDominiosUnicos(lote, mapper);
    assert.ok(unicos.has('propio.com.ar'), 'el dominio de un solo cliente si se asigna');
    assert.ok(!unicos.has('compartido.com.ar'), 'el compartido NO, porque HubSpot fusionaria');
});

test('MAIL_DE se guarda como texto, no como email', () => {
    const c = clientes.find((x) => x.MAIL_DE);
    if (!c) return;
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tango_mails_comprobantes, String(c.MAIL_DE).trim());
});

// ------------------------------------------------------------------ opciones
//
// HubSpot RECHAZA un valor que no este entre las opciones de un desplegable, y
// en /batch/upsert el rechazo voltea la tanda de 100 entera. Nunca puede salir
// un codigo crudo de Tango hacia una propiedad de tipo select.

test('condicion_iva sale como la etiqueta de HubSpot, nunca como el codigo de Tango', () => {
    const c = clientes.find((x) => x.COD_CATEGORIA_IVA === 'RI');
    assert.ok(c, 'la muestra tiene clientes RI');
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.condicion_iva, 'Responsable Inscripto');
});

test('ningun cliente de la muestra manda un valor fuera de las opciones', () => {
    const campo = mapeoClientes.campos.find((x) => x.hubspot === 'condicion_iva');
    const validas = new Set(Object.values(campo.opciones));
    for (const c of clientes) {
        const { propiedades } = mapper.aHubSpot(c);
        if (propiedades.condicion_iva === undefined) continue;
        assert.ok(validas.has(propiedades.condicion_iva), `valor invalido: '${propiedades.condicion_iva}'`);
    }
});

test('las etiquetas de condicion_iva no son inventadas: Tango se autodescribe', () => {
    // DESC_CATEGORIA_IVA viene junto al codigo en la misma respuesta. Si esta
    // correspondencia se rompiera, las opciones del select estarian mintiendo.
    const esperado = {
        RI: 'responsable inscripto',
        RS: 'responsable monotributista',
        EX: 'exento',
        CF: 'consumidor final',
    };
    const vistos = new Set();
    for (const c of clientes) {
        const cod = c.COD_CATEGORIA_IVA;
        if (!esperado[cod]) continue;
        vistos.add(cod);
        assert.strictEqual(
            String(c.DESC_CATEGORIA_IVA).trim().toLowerCase(), esperado[cod],
            `Tango describe '${cod}' distinto de lo que asume el mapeo`
        );
    }
    assert.deepStrictEqual([...vistos].sort(), ['CF', 'EX', 'RI', 'RS']);
});

test('el catalogo de IVA esta completo: las 11 categorias de Tango tienen opcion', () => {
    // La tabla CATEGORIA_IVA tiene 11 filas, no 5. Las 6 sin clientes se
    // extrajeron del ERP el 2026-08-24 y se agregaron para que el desplegable
    // este completo, no solo cubierto para el padron de hoy.
    const esperado = {
        RI: 'Responsable Inscripto', CF: 'Consumidor Final', RS: 'Monotributista',
        EX: 'Exento', EXE: 'Iva exento operacion de exportacion',
        INR: 'No responsable', PCE: 'Pequeño contribuyente eventual',
        RSS: 'Monotributista social', PCS: 'Pequeño contribuyente eventual social',
        SNC: 'Sujeto no categorizado', INA: 'Iva no alcanzado',
    };
    for (const [cod, etiqueta] of Object.entries(esperado)) {
        const { propiedades, problemas } = mapper.aHubSpot({ ...clientes[0], COD_CATEGORIA_IVA: cod });
        assert.strictEqual(propiedades.condicion_iva, etiqueta, `${cod} quedo mal`);
        assert.ok(!problemas.some((p) => p.includes('condicion_iva')));
    }
});

test('las etiquetas que ya estan en el portal no se renombran', () => {
    // El PATCH de opciones AGREGA, no renombra: cambiar 'Responsable Inscripto'
    // por 'Responsable inscripto' dejaria las dos conviviendo en el desplegable.
    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'condicion_iva');
    assert.strictEqual(campo.opciones.RI, 'Responsable Inscripto');
    assert.strictEqual(campo.opciones.CF, 'Consumidor Final');
    assert.strictEqual(campo.opciones.RS, 'Monotributista');
});

test('los 11 codigos resuelven a su ID interno para el alta', () => {
    const ids = { RI: 1, CF: 2, INR: 3, RS: 4, EX: 5, PCE: 6, RSS: 7, PCS: 8, EXE: 9, SNC: 10, INA: 11 };
    for (const [cod, id] of Object.entries(ids)) {
        const { propiedades } = mapper.aHubSpot({ ...clientes[0], COD_CATEGORIA_IVA: cod });
        assert.strictEqual(propiedades.tango_id_categoria_iva, id, `${cod} no resolvio a ${id}`);
    }
});

test('una categoria de IVA que no esta en la tabla se omite y se reporta, en los DOS campos', () => {
    // Hasta el 2026-09-01 `tango_categoria_iva` era texto libre y hacia de
    // valvula de escape: el select quedaba vacio pero la descripcion cruda
    // se guardaba igual. Al volverlo desplegable esa valvula se cierra, y es
    // a proposito: una categoria que no esta en la tabla significa que Tango
    // creo una doceava, y eso tiene que aparecer como problema y no como un
    // texto suelto en una ficha que no mira nadie. Las 11 estan verificadas
    // contra el ERP (2026-08-24) y falsadas contra los 5670 clientes.
    const c = { ...clientes[0], COD_CATEGORIA_IVA: 'ZZ', DESC_CATEGORIA_IVA: 'Categoria que no existe' };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.condicion_iva, undefined, 'el select no se escribe');
    assert.strictEqual(propiedades.tango_categoria_iva, undefined, 'el desplegable tampoco');
    assert.ok(
        problemas.some((p) => p.includes('tango_categoria_iva')) && problemas.some((p) => p.includes('condicion_iva')),
        `se pierde en silencio, y eso es lo que no puede pasar: ${JSON.stringify(problemas)}`,
    );
});

test('un codigo sin opcion definida se omite y se reporta, no se escribe', () => {
    // HubSpot RECHAZA un valor fuera de la lista, y en un batch de 100 el
    // rechazo se lleva la tanda entera. Por eso se omite y se reporta.
    const c = { ...clientes[0], COD_CATEGORIA_IVA: 'ZZ' };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.condicion_iva, undefined);
    assert.ok(problemas.some((p) => p.includes('condicion_iva') && p.includes('ZZ')));
});

test('tipo_de_documento no copia el codigo 0: lo resuelve con lib/documento', () => {
    // COD 0 lo etiqueta Tango "C.I. POLICIA FEDERAL" pero es el default de un
    // campo sin cargar, y lo tiene el 54% de la muestra.
    const c = clientes.find((x) => Number(x.COD_TIPO_DOCUMENTO_GV) === 0 && /^\d{2}-?\d{8}-?\d$/.test(String(x.CUIT || '')));
    assert.ok(c, 'la muestra tiene clientes sin tipo declarado pero con CUIT');
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tipo_de_documento, 'CUIT', 'se infiere del numero');
});

test('tipo_de_documento respeta lo que Tango declara', () => {
    const c = clientes.find((x) => Number(x.COD_TIPO_DOCUMENTO_GV) === 96);
    assert.ok(c, 'la muestra tiene DNI declarados');
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tipo_de_documento, 'DNI');
});

test('tipo_de_documento se omite cuando no se puede determinar', () => {
    const c = { ...clientes[0], COD_TIPO_DOCUMENTO_GV: 0, CUIT: '' };
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.tipo_de_documento, undefined, 'mejor vacio que una etiqueta inventada');
});

// ------------------------------------------------- alineacion con la migracion
//
// Ultraschall migro ~7.585 clientes a mano desde CRM GO. El sync tiene que
// convivir con eso, no pisarlo. Ver docs/ARQUITECTURA.md 7.5.

test('la provincia va a `provincia` (custom), no a `state`', () => {
    // Ultraschall creo `provincia` como desplegable. Escribir `state` habria
    // dejado el dato partido en dos propiedades y ninguna completa.
    const c = clientes.find((x) => x.GVA18_DESCRIPCION === 'Misiones');
    assert.ok(c);
    const { propiedades } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.provincia, 'misiones');
    assert.strictEqual(propiedades.state, undefined, 'no se escribe mas state');
});

test('Capital Federal y CABA caen las dos en la misma opcion', () => {
    // Tango tiene las dos como provincias distintas (908 y 616 registros en la
    // migracion). En HubSpot hay una sola opcion.
    const base = clientes[0];
    for (const nombre of ['Capital Federal', 'CABA']) {
        const { propiedades } = mapper.aHubSpot({ ...base, GVA18_DESCRIPCION: nombre });
        assert.strictEqual(propiedades.provincia, 'caba', `${nombre} deberia mapear a caba`);
    }
});

test('el desplegable cubre las 38 provincias reales de GVA18; solo queda afuera la basura', () => {
    // Ampliado el 2026-08-24: antes solo tenia las 24 argentinas y los 48
    // clientes del exterior quedaban sin provincia. Se midio contra la tabla
    // completa (40 filas) y alcanzaba con agregar 12.
    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'provincia');
    const provincias = require('./fixtures/provincias.json');
    const sinMapear = provincias
        .map((p) => String(p.NOMBRE_PRO).trim())
        .filter((n) => campo.opciones[n] === undefined);

    // Lo unico sin opcion son los dos placeholders de un campo sin cargar.
    assert.deepStrictEqual(sinMapear.sort(), ['0', 'Desconocido']);
});

test('una provincia extranjera ya se escribe, y el pais tambien', () => {
    const c = { ...clientes[0], GVA18_DESCRIPCION: 'Montevideo', GVA133_NOM_PAIS: 'URUGUAY' };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.provincia, 'montevideo');
    assert.strictEqual(propiedades.country, 'URUGUAY');
    assert.ok(!problemas.some((p) => p.includes('provincia')));
});

test('el placeholder 0 se sigue omitiendo y reportando', () => {
    // 36 clientes lo tienen. No es una provincia: es el default de un campo
    // que nadie cargo, y escribirlo ensuciaria la ficha.
    const c = { ...clientes[0], GVA18_DESCRIPCION: '0' };
    const { propiedades, problemas } = mapper.aHubSpot(c);
    assert.strictEqual(propiedades.provincia, undefined);
    assert.ok(problemas.some((p) => p.includes('provincia')));
});

test('name deja de ser autoritativo: no pisa la limpieza manual', () => {
    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'name');
    assert.strictEqual(campo.autoritativoTango, false);
    assert.ok(mapper.camposNoAutoritativos().includes('name'));
});

test('la clave y los IDs internos SI son autoritativos', () => {
    // Estos los manda Tango siempre: no tiene sentido "respetar" un valor viejo.
    const auth = mapper.camposAutoritativos();
    for (const p of ['codigo_tango', 'tango_id_gva14', 'razon_social', 'tango_sync_hash']) {
        assert.ok(auth.includes(p), `${p} deberia ser autoritativo`);
    }
});

// ---------------------------------------------------------------- domain
//
// REVERTIDO el 2026-08-24: el sync ya NO escribe `domain`. Era la segunda clave
// de matcheo de HubSpot -- la aplica solo, sin que se la pidamos, y dos
// companies que comparten dominio SE FUSIONAN. Sacandolo, la identidad del sync
// queda reducida a una sola llave que controlamos nosotros: codigo_tango.
// Ver ARQUITECTURA.md 7.2 y _meta.removidos del mapeo.

test('el sync no escribe domain para ningun cliente del padron', () => {
    // Con `domain` fuera del mapeo no hay forma de que dos clientes distintos
    // terminen fusionados en una sola company.
    for (const c of clientes) {
        assert.strictEqual(mapper.aHubSpot(c).propiedades.domain, undefined, `${c.COD_GVA14} escribio domain`);
    }
    assert.ok(!mapper.camposNoAutoritativos().includes('domain'));
    assert.ok(!mapper.camposAutoritativos().includes('domain'));
});

test('el sitio web no se pierde: sigue yendo a website', () => {
    // Lo que se saco es la propiedad con la que HubSpot fusiona, no el dato.
    const c = clientes.find((x) => x.WEB && String(x.WEB).trim());
    assert.ok(c, 'la muestra tiene clientes con WEB cargado');
    assert.ok(mapper.aHubSpot(c).propiedades.website, 'website quedo vacio');
});

test('la sugerencia de dominio sigue viva, y sigue descartando compartidos', () => {
    // `tango_dominio_sugerido` es texto plano: HubSpot no fusiona por el. Se
    // descarta el compartido por calidad del dato, no por riesgo de fusion.
    const { calcularDominiosUnicos } = require('../src/lib/syncClientes');
    const base = clientes[0];
    const lote = [
        { ...base, COD_GVA14: 'A1', MAIL_DE: 'uno@compartido.com.ar' },
        { ...base, COD_GVA14: 'A2', MAIL_DE: 'dos@compartido.com.ar' },
        { ...base, COD_GVA14: 'A3', MAIL_DE: 'tres@propio.com.ar' },
    ];
    const unicos = calcularDominiosUnicos(lote, mapper, 'tango_dominio_sugerido');
    assert.ok(unicos.has('propio.com.ar'));
    assert.ok(!unicos.has('compartido.com.ar'));
});

test('el filtro de ISPs sigue aplicando a la sugerencia', () => {
    // fibercorp y satlink estaban nombrados en las notas del mapeo pero
    // faltaban en el filtro; se agregaron el 2026-08-21 al medirlo.
    assert.strictEqual(transforms.dominioDeMail('salasalud@fibercorp.com.ar'), null);
    assert.strictEqual(transforms.dominioDeMail('x@satlink.com.ar'), null);
    assert.strictEqual(transforms.dominioDeMail('farancibia@ultraschall.com.ar'), null);
});

// ------------------------------------------------ direccion inversa (alta)
//
// Para dar de alta en Tango una company creada a mano en HubSpot hay que ir al
// reves: del valor del desplegable al ID interno. No hace falta para las
// companies que vinieron del sync — esas ya tienen tango_id_gva18 guardado.

test('toda opcion de provincia resuelve a un ID_GVA18 real', () => {
    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'provincia');
    const opciones = new Set(Object.values(campo.opciones));
    for (const o of opciones) {
        const r = mapper.desdeOpcion('provincia', o);
        assert.ok(r.ok, `la opcion '${o}' no resuelve: ${r.motivo}`);
        assert.ok(Number.isFinite(r.id), `la opcion '${o}' no dio un ID`);
    }
});

test('el codigo de provincia NO es el ID interno', () => {
    // La razon de guardar el codigo y resolver contra la tabla viva en vez de
    // hardcodear el ID. Si algun dia esto empieza a coincidir, sigue estando bien.
    assert.deepStrictEqual(mapper.desdeOpcion('provincia', 'montevideo'), { ok: true, id: 31, codigo: '30' });
    assert.deepStrictEqual(mapper.desdeOpcion('provincia', 'quito'), { ok: true, id: 40, codigo: '37' });
});

test('los empates de GVA18 estan resueltos, no adivinados', () => {
    // 'Capital Federal' (ID 1) y 'CABA' (ID 33) son dos filas distintas que caen
    // en la misma opcion; lo mismo 'Buenos Aires' (ID 2) y 'Gran Buenos Aires'
    // (ID 36). Se eligio por cantidad de clientes reales y quedo escrito en el
    // mapeo: aca solo se verifica que la eleccion siga siendo la que se decidio.
    assert.strictEqual(mapper.desdeOpcion('provincia', 'caba').id, 1);
    assert.strictEqual(mapper.desdeOpcion('provincia', 'buenos_aires').id, 2);
});

test('una opcion que no existe se reporta, no se inventa un ID', () => {
    const r = mapper.desdeOpcion('provincia', 'narnia');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.id, null);
    assert.match(r.motivo, /no tiene equivalencia/);
});

test('sin valor tampoco se inventa nada', () => {
    for (const v of [null, undefined, '', '   ']) {
        assert.strictEqual(mapper.desdeOpcion('provincia', v).ok, false);
    }
});

test('un campo sin opcionesInversas lo dice claro', () => {
    assert.match(mapper.desdeOpcion('condicion_iva', 'Exento').motivo, /no declara opcionesInversas/);
});

test('las provincias extranjeras entraron al desplegable, la basura no', () => {
    const campo = mapeoClientes.campos.find((c) => c.hubspot === 'provincia');
    for (const nom of ['Montevideo', 'Asuncion', 'Quito', 'La paz', 'Lima', 'Ciudad del este', 'Cochabamba']) {
        assert.ok(campo.opciones[nom], `falta la opcion para ${nom}`);
    }
    // '0' y 'Desconocido' son placeholders de un campo sin cargar: 37 clientes
    // los tienen y se omiten a proposito.
    assert.strictEqual(campo.opciones['0'], undefined);
    assert.strictEqual(campo.opciones['Desconocido'], undefined);
});
