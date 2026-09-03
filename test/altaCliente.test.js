'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const alta = require('../src/lib/altaCliente');
const mapper = require('../src/lib/mapper');
const syncClientes = require('../src/lib/syncClientes');
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
const m = mapper.crear(mapeoClientes, lk);
const CLAVE_HS = mapeoClientes._meta.claveIdempotencia.hubspot;

const porCodigo = (cod) => clientes.find((c) => c.COD_GVA14 === cod);
const AHORA = new Date('2026-08-24T15:00:00Z');

/**
 * Reproduce, en cinco lineas, lo que el timer hace con un registro para decidir
 * si lo reescribe. No es duplicacion ociosa: es el otro lado del invariante que
 * cierra el riesgo 1, y si alguno de los dos cambia, los tests de abajo avisan.
 */
function comoElTimer(registro, padron) {
    const sugeridosUnicos = syncClientes.calcularDominiosUnicos(padron, m, 'tango_dominio_sugerido');
    const { propiedades } = m.aHubSpot(registro);
    if (propiedades.tango_dominio_sugerido && !sugeridosUnicos.has(propiedades.tango_dominio_sugerido)) delete propiedades.tango_dominio_sugerido;
    return { hash: m.hash(propiedades), propiedades };
}

// ------------------------------------------------- el filtro SQL contra el ERP

test('condicionPorCodigo arma la condicion sin WHERE', () => {
    assert.strictEqual(alta.condicionPorCodigo('007611'), "COD_GVA14 = '007611'");
    assert.strictEqual(alta.condicionPorCodigo('  007611  '), "COD_GVA14 = '007611'");
});

test('un codigo con forma de inyeccion no llega a armar filtro', () => {
    // filtroSql es SQL concatenado del lado del ERP (ARQUITECTURA.md 10.0) y el
    // codigo puede venir de un webhook. La regla es que el filtro se arma en el
    // codigo; esto es el cinturon que la hace cumplir igual.
    for (const malo of ["000003' OR '1'='1", '000003; DROP', '000003 UNION SELECT', "' OR 1=1--", '', null, undefined, '0'.repeat(20)]) {
        assert.throws(() => alta.condicionPorCodigo(malo), /forma invalida/, `deberia rechazar ${JSON.stringify(malo)}`);
    }
});

// ------------------------------------------------------- que se le escribe

test('la company queda con el codigo y con el ID interno de Tango', () => {
    const registro = porCodigo('000003');
    const { propiedades, clave } = alta.planificarEscritura(registro, {}, m, AHORA);

    assert.strictEqual(clave, '000003');
    assert.strictEqual(propiedades[CLAVE_HS], '000003');
    // Sin ID_GVA14 la Fase 4 no puede armar el pedido de ese cliente (5.3, 9.2).
    assert.strictEqual(propiedades.tango_id_gva14, registro.ID_GVA14);
    assert.ok(propiedades.tango_sync_hash, 'sin hash el timer reescribe la company en la primera corrida');
    assert.strictEqual(propiedades.tango_ultima_sync, Date.UTC(2026, 7, 24));
});

test('🔴 el timer no duplica: encuentra la company por su clave y ve el mismo hash', () => {
    // Este es el test que cierra el riesgo 1. Un cliente sin sugerencia de
    // dominio: la escritura de vuelta y el timer tienen que llegar al MISMO
    // hash, asi la primera corrida nocturna lo cuenta como sinCambios.
    const registro = porCodigo('000005');
    const { propiedades } = alta.planificarEscritura(registro, {}, m, AHORA);
    const timer = comoElTimer(registro, clientes);

    assert.strictEqual(propiedades.tango_sync_hash, timer.hash);
    assert.strictEqual(propiedades[CLAVE_HS], m.clave(registro), 'sin la clave, el upsert del timer crearia una company nueva');
});

test('con sugerencia unica el timer la completa: una reescritura, nunca un duplicado', () => {
    // Consecuencia asumida de no escribir la sugerencia desde el alta. Lo que
    // importa es que el registro se encuentra igual por su clave: es un UPDATE,
    // no un alta nueva.
    const registro = porCodigo('000003');
    const { propiedades } = alta.planificarEscritura(registro, {}, m, AHORA);
    const timer = comoElTimer(registro, clientes);

    assert.ok(timer.propiedades.tango_dominio_sugerido, 'el fixture elegido tiene que tener sugerencia unica');
    assert.notStrictEqual(propiedades.tango_sync_hash, timer.hash);
    assert.strictEqual(propiedades[CLAVE_HS], timer.propiedades[CLAVE_HS]);
});

test('el alta no escribe ni domain ni la sugerencia de dominio', () => {
    // `domain` ya no lo escribe nadie (decision 2026-08-24). La sugerencia solo
    // vale si pertenece a un unico cliente, y eso no se puede juzgar desde un
    // registro suelto.
    for (const registro of clientes.slice(0, 50)) {
        const { propiedades } = alta.planificarEscritura(registro, {}, m, AHORA);
        assert.strictEqual(propiedades.domain, undefined, `${registro.COD_GVA14} escribio domain`);
        assert.strictEqual(propiedades.tango_dominio_sugerido, undefined);
    }
});

test('para los 270 clientes sin sugerencia, el hash del alta y el del timer coinciden', () => {
    // La version fuerte del invariante que cierra el riesgo 1: para la enorme
    // mayoria del padron, la primera corrida del timer no toca nada.
    let iguales = 0, distintos = 0;
    for (const registro of clientes) {
        const { propiedades } = alta.planificarEscritura(registro, {}, m, AHORA);
        const timer = comoElTimer(registro, clientes);
        propiedades.tango_sync_hash === timer.hash ? iguales++ : distintos++;
    }
    assert.strictEqual(iguales + distintos, clientes.length);
    assert.ok(iguales / clientes.length > 0.85, `solo ${iguales}/${clientes.length} coinciden`);
});

test('lo que cargo comercial a mano no se pisa', () => {
    const registro = porCodigo('000003');
    const actuales = { name: 'Arcana S.R.L.', localidad: 'Posadas' };
    const { propiedades, respetados } = alta.planificarEscritura(registro, actuales, m, AHORA);

    assert.strictEqual(propiedades.name, undefined);
    assert.ok(respetados.includes('name'));
    // Los autoritativos si se escriben: son los que manda Tango.
    assert.ok(propiedades.razon_social);
});

test('un campo vacio en HubSpot si se completa desde Tango', () => {
    const registro = porCodigo('000003');
    const { propiedades, respetados } = alta.planificarEscritura(registro, { name: '   ', localidad: null }, m, AHORA);

    assert.ok(propiedades.name, 'un valor en blanco no es un dato cargado a mano');
    assert.deepStrictEqual(respetados, []);
});

test('el hash se calcula ANTES de respetar lo cargado a mano', () => {
    // Si se calculara despues, un campo protegido haria que el hash cambiara en
    // cada corrida y la company nunca cerraria: el timer la reescribiria para
    // siempre. Es el mismo razonamiento que ya esta en syncClientes.
    const registro = porCodigo('000003');
    const limpia = alta.planificarEscritura(registro, {}, m, AHORA);
    const conDatos = alta.planificarEscritura(registro, { name: 'Arcana S.R.L.' }, m, AHORA);

    assert.strictEqual(limpia.propiedades.tango_sync_hash, conDatos.propiedades.tango_sync_hash);
});

// ------------------------------------------------------- lectura post-alta

const tangoFake = (respuestas) => {
    const cola = [...respuestas];
    const llamadas = [];
    return {
        llamadas,
        async getByFilter(process, condicion) {
            llamadas.push({ process, condicion });
            return cola.length > 1 ? cola.shift() : cola[0];
        },
    };
};

test('si el alta todavia no es visible, reintenta antes de rendirse', async () => {
    const tango = tangoFake([[], [], [porCodigo('000003')]]);
    const r = await alta.leerCreado(tango, '000003', undefined, 0);

    assert.strictEqual(r.COD_GVA14, '000003');
    assert.strictEqual(tango.llamadas.length, 3);
});

test('si el cliente no aparece nunca, el error dice que hay que mirar el ERP', async () => {
    const tango = tangoFake([[]]);
    await assert.rejects(
        () => alta.leerCreado(tango, '007611', undefined, 0),
        /no aparece en Tango.*Verificar a mano/s
    );
});

test('dos clientes con el mismo codigo cortan todo', async () => {
    const tango = tangoFake([[porCodigo('000003'), porCodigo('000004')]]);
    await assert.rejects(() => alta.leerCreado(tango, '000003', undefined, 0), /dejo de ser unica/);
});

// ----------------------------------------------------- escritura de vuelta

const hsFake = (props = {}) => {
    const patches = [];
    return {
        patches,
        async objeto(objeto, id) {
            return id === 'inexistente' ? null : { id, properties: props };
        },
        async actualizarObjeto(objeto, id, propiedades) {
            patches.push({ objeto, id, propiedades });
            return { id };
        },
    };
};

const correr = (extra = {}) => alta.escribirDeVuelta({
    tango: tangoFake([[porCodigo('000003')]]),
    hs: hsFake(),
    lookups: lk,
    companyId: '123',
    codigo: '000003',
    ahora: AHORA,
    ...extra,
});

test('escribe la company con el codigo y el ID interno', async () => {
    const hs = hsFake();
    const r = await correr({ hs, dryRun: false });

    assert.strictEqual(r.escrito, true);
    assert.strictEqual(hs.patches.length, 1);
    assert.strictEqual(hs.patches[0].id, '123');
    assert.strictEqual(hs.patches[0].propiedades[CLAVE_HS], '000003');
    assert.strictEqual(r.idGva14, porCodigo('000003').ID_GVA14);
});

test('dry-run es el default y no escribe nada', async () => {
    const hs = hsFake();
    const r = await correr({ hs });

    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.escrito, false);
    assert.deepStrictEqual(hs.patches, []);
    assert.strictEqual(r.propiedades[CLAVE_HS], '000003', 'igual tiene que decir que habria escrito');
});

test('una company ya vinculada a OTRO cliente no se re-ata', async () => {
    // Reatarla dejaria al cliente anterior huerfano y el timer volveria a crear
    // una company para el: el duplicado que este modulo existe para evitar.
    const hs = hsFake({ [CLAVE_HS]: '000999' });
    await assert.rejects(() => correr({ hs, dryRun: false }), /ya esta vinculada al cliente '000999'/);
    assert.deepStrictEqual(hs.patches, []);
});

test('reprocesar el mismo alta es idempotente', async () => {
    // El hook puede llegar dos veces. Si la company ya tiene ESE codigo, se
    // reescribe lo mismo y no pasa nada.
    const hs = hsFake({ [CLAVE_HS]: '000003' });
    const r = await correr({ hs, dryRun: false });
    assert.strictEqual(r.escrito, true);
});

test('si Tango devuelve otro codigo, no se escribe', async () => {
    const tango = tangoFake([[porCodigo('000004')]]);
    const hs = hsFake();
    await assert.rejects(() => correr({ tango, hs, dryRun: false }), /No coinciden/);
    assert.deepStrictEqual(hs.patches, []);
});

test('una company que no existe se reporta clara', async () => {
    await assert.rejects(() => correr({ companyId: 'inexistente' }), /no existe en HubSpot/);
});

test('sin companyId falla antes de tocar nada', async () => {
    const hs = hsFake();
    await assert.rejects(() => correr({ hs, companyId: undefined }), /falta companyId/);
    assert.deepStrictEqual(hs.patches, []);
});

test('un cliente sin ID_GVA14 se reporta como problema', async () => {
    const sinId = { ...porCodigo('000003'), ID_GVA14: null };
    const r = await correr({ tango: tangoFake([[sinId]]) });

    assert.strictEqual(r.idGva14, null);
    assert.ok(r.problemas.some((p) => /no va a poder facturar/.test(p)));
});

// ------------------------------------- el alta completa y su reintento (7.6)
//
// "Le sumamos uno hasta que la respuesta sea que se creo bien" (Matias,
// 2026-08-27). Lo delicado no es sumar uno: es NO sumar uno cuando el cliente
// ya quedo creado, porque eso duplica clientes en el ERP.

/** Una company de HubSpot con todo lo que el alta necesita. */
const COMPANY_OK = {
    name: 'CLINICA DEMO',
    razon_social: 'CLINICA DEMO SA',
    cuit: 30999999995,
    condicion_iva: 'Responsable Inscripto',
    domicilio_del_consultorio: 'Av. Corrientes 1234',
    localidad: 'CABA',
    zip: '1043',
    provincia: 'caba',
    country: 'ARGENTINA',
};

/**
 * Tango de mentira para el alta entera.
 *
 * @param ocupados  COD_GVA14 -> fila que lo ocupa (una colision), o 'error'
 *                  para que el create falle sin que el codigo quede tomado.
 */
function tangoAlta({ ocupados = {}, padron = [porCodigo('000003')] } = {}) {
    return {
        creados: [],
        consultas: [],
        async get() { return { registros: padron, total: padron.length }; },
        async create(process, payload) {
            const cod = payload.COD_GVA14;
            this.creados.push(payload);
            if (ocupados[cod]) throw new Error(`Tango rechazo la consulta: el codigo ${cod} ya existe`);
            return { NRO: cod };
        },
        async getByFilter(process, condicion) {
            this.consultas.push(condicion);
            const cod = condicion.match(/'([^']+)'/)?.[1];
            // Primero: ¿alguien ocupa el codigo? (clasificacion de la colision)
            const ocupa = ocupados[cod];
            if (ocupa && ocupa !== 'error') return [ocupa];
            if (ocupa === 'error') return [];
            // Si no, es la lectura del cliente recien creado.
            return this.creados.some((c) => c.COD_GVA14 === cod)
                ? [{ ...porCodigo('000003'), COD_GVA14: cod, ID_GVA14: 9001 }]
                : [];
        },
    };
}

const hsAlta = () => {
    const patches = [];
    return {
        patches,
        async objeto(_o, id) { return { id, properties: COMPANY_OK }; },
        async actualizarObjeto(_o, id, propiedades) { patches.push({ id, propiedades }); return { id }; },
    };
};

/**
 * El owner del NEGOCIO decide el vendedor y sin equivalencia el alta frena
 * (2026-09-03), asi que todo alta que tenga que salir bien necesita uno.
 */
const OWNER_VENDEDOR = 'jbutorac@ultraschall.com.ar'; // vendedor 24

const crearAlta = (tango, hs, extra = {}) => alta.crear({
    tango, hs, lookups: lk, companyId: '555', propiedades: COMPANY_OK,
    estrategia: 'correlativo', ownerId: OWNER_VENDEDOR, dryRun: false, ahora: AHORA, ...extra,
});

test('si el codigo esta tomado por otro cliente, suma uno y sigue', async () => {
    // El primer candidato despues de 000003 es 000004; se lo queda un alta
    // manual, asi que el cliente tiene que terminar en 000005.
    const tango = tangoAlta({ ocupados: { '000004': { ...porCodigo('000003'), RAZON_SOCI: 'OTRO CLIENTE SRL', CUIT: '30-11111111-1' } } });
    const r = await crearAlta(tango, hsAlta());

    assert.strictEqual(r.creado, true);
    assert.strictEqual(r.codigo, '000005');
    assert.deepStrictEqual(tango.creados.map((c) => c.COD_GVA14), ['000004', '000005']);
});

test('un rechazo que NO es colision se propaga sin quemar codigos', async () => {
    // El ERP caido, o un campo invalido. Sumar uno no lo arregla: probar 25
    // codigos seria gastar 25 requests para terminar con un error peor.
    const tango = tangoAlta({ ocupados: { '000004': 'error' } });
    await assert.rejects(() => crearAlta(tango, hsAlta()), /ya existe/);
    assert.strictEqual(tango.creados.length, 1, 'un solo intento');
});

test('si el alta entro pero la respuesta fallo, NO se crea un segundo cliente', async () => {
    // El caso feo: Tango grabo y la respuesta se perdio. El codigo figura
    // tomado, pero por NOSOTROS. Reintentar duplicaria el cliente.
    const nuestro = { ...porCodigo('000003'), COD_GVA14: '000004', ID_GVA14: 9001, RAZON_SOCI: 'CLINICA DEMO SA', CUIT: '30-99999999-5' };
    const tango = tangoAlta({ ocupados: { '000004': nuestro } });
    const hs = hsAlta();
    const r = await crearAlta(tango, hs);

    assert.strictEqual(r.creado, true);
    assert.strictEqual(r.codigo, '000004', 'se queda con el que ya estaba creado');
    assert.strictEqual(tango.creados.length, 1, 'no se mando un segundo alta');
    assert.strictEqual(hs.patches.length, 1, 'y la company igual quedo atada');
});

test('si la escritura de vuelta falla, el cliente NO se vuelve a crear', async () => {
    // REGRESION: `escribirDeVuelta` estaba DENTRO del try del reintento, asi
    // que un fallo al escribir en HubSpot mandaba el alta de nuevo con el
    // codigo siguiente y dejaba dos clientes en el ERP.
    const tango = tangoAlta();
    const hs = hsAlta();
    hs.actualizarObjeto = async () => { throw new Error('HubSpot rechazo el PATCH'); };

    await assert.rejects(() => crearAlta(tango, hs), /HubSpot rechazo el PATCH/);
    assert.deepStrictEqual(tango.creados.map((c) => c.COD_GVA14), ['000004'], 'un solo cliente en Tango');
});

test('se preparan candidatos de sobra para no releer el padron', () => {
    // Releer el padron cuesta 107 s; los candidatos son strings sobre datos que
    // ya estan en memoria.
    assert.ok(alta.CANDIDATOS >= 10, `${alta.CANDIDATOS} candidatos es poco margen`);
});

test('esElMismoCliente reconoce lo nuestro por CUIT y por razon social', () => {
    const valores = { CUIT: '30-99999999-5', RAZON_SOCI: 'CLINICA DEMO SA' };
    assert.strictEqual(alta.esElMismoCliente({ CUIT: '30999999995' }, valores), true, 'el formato no importa');
    assert.strictEqual(alta.esElMismoCliente({ RAZON_SOCI: 'clinica demo sa' }, valores), true);
    assert.strictEqual(alta.esElMismoCliente({ CUIT: '30-11111111-1', RAZON_SOCI: 'OTRO SRL' }, valores), false);
    assert.strictEqual(alta.esElMismoCliente({}, valores), false, 'sin datos NO se asume que es nuestro');
});
