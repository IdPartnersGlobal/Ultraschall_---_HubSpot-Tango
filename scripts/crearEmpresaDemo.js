#!/usr/bin/env node
'use strict';

/**
 * Crea en HubSpot UNA company de prueba, completa, para poder ejercitar el
 * circuito de negocio ganado -> pedido punta a punta.
 *
 *   node scripts/crearEmpresaDemo.js            # dry-run (no escribe)
 *   node scripts/crearEmpresaDemo.js --aplicar  # la crea de verdad
 *
 * POR QUE EXISTE (2026-08-27). Medido contra el portal: de las 66 companies
 * reales, **65 no se pueden dar de alta en Tango** — les falta razon social,
 * condicion de IVA, domicilio o CUIT. Eso es carga de datos de comercial y no
 * se resuelve desde el codigo. Para no quedar bloqueados esperando esa carga,
 * se crea una company de prueba que si pasa la verificacion.
 *
 * ⚠️ A PROPOSITO **no** se le cargan `tango_codigo_cliente` ni `tango_id_gva14`:
 * sin codigo de Tango, el negocio ganado tiene que pasar por el alta al vuelo
 * (§7.12), que es justamente el camino que hay que probar. Ponerle el codigo
 * saltearia esa mitad del circuito.
 *
 * ⚠️ Las tablas auxiliares salen de `test/fixtures/`, no de Tango: el ERP solo
 * acepta trafico desde Azure (§5.6). Alcanza para verificar que no falte
 * ningun campo; la resolucion definitiva de IDs la hace la Function App contra
 * las tablas vivas.
 */

const path = require('node:path');
const fs = require('node:fs');
const hubspot = require('../src/lib/hubspotClient');
const verificarEmpresa = require('../src/lib/verificarEmpresa');
const mapperLib = require('../src/lib/mapper');
const { Lookups } = require('../src/lib/lookups');
const mapeoClientes = require('../config/mapeo.clientes.json');

/**
 * La company de prueba.
 *
 * El CUIT es sintetico pero con digito verificador valido (30-99999999-5): asi
 * no queda marcado 'revisar' y se parece a un dato real sin poder pisarle el
 * CUIT a nadie. Va como NUMERO porque la propiedad del portal es `number`
 * (decision del 2026-08-27, §7.2).
 *
 * `provincia` y `condicion_iva` llevan el VALOR interno de la opcion de
 * HubSpot, no la etiqueta: es lo que guarda el desplegable y lo que sabe leer
 * `opcionesInversas`.
 */
const DEMO = {
    name: 'EMPRESA DE PRUEBA - Integracion Tango',
    razon_social: 'EMPRESA DE PRUEBA INTEGRACION TANGO SA',
    cuit: 30999999995,
    condicion_iva: 'Responsable Inscripto',
    domicilio_del_consultorio: 'Av. Corrientes 1234',
    localidad: 'Ciudad Autonoma de Buenos Aires',
    zip: '1043',
    provincia: 'caba',
    country: 'ARGENTINA',
    phone: '+541143210000',
};

function leerToken() {
    if (process.env.HUBSPOT_TOKEN) return process.env.HUBSPOT_TOKEN;
    const p = path.join(__dirname, '..', 'local.settings.json');
    if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, 'utf8')).Values || {};
        if (v.HUBSPOT_TOKEN) return v.HUBSPOT_TOKEN;
    }
    throw new Error('Falta HUBSPOT_TOKEN (variable de entorno o local.settings.json)');
}

function lookupsDeFixtures() {
    const f = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', `${n}.json`), 'utf8'));
    return Lookups.desdeRegistros({
        condicionesVenta: f('condicionesVenta'),
        vendedores: f('vendedores'),
        transportes: f('transportes'),
        provincias: f('provincias'),
        zonas: f('zonas'),
        alicuotasIva: f('alicuotasIva'),
    });
}

(async () => {
    const aplicar = process.argv.includes('--aplicar');
    const hs = hubspot.crear({ token: leerToken() });
    const lk = lookupsDeFixtures();
    const m = mapperLib.crear(mapeoClientes, lk);
    const claveHs = mapeoClientes._meta.claveIdempotencia.hubspot;

    const cuenta = await hs.cuenta();
    console.log(`Portal ${cuenta.portalId}  ·  objeto: companies\n`);
    if (!aplicar) console.log('(dry-run: no escribe nada. Agregar --aplicar para crearla)\n');

    // 1. Que no se dupliquen en cada corrida.
    const existentes = await hs.leerTodos('companies', ['name', claveHs]);
    const yaEsta = existentes.find((c) => (c.properties?.name || '').trim() === DEMO.name);
    if (yaEsta) {
        console.log(`Ya existe: company ${yaEsta.id} — "${DEMO.name}"`);
        console.log(`  ${claveHs}: ${yaEsta.properties?.[claveHs] || '(vacio, como tiene que estar)'}`);
        console.log('\nNo se crea otra. Si querias una nueva, cambiale el `name` a DEMO.');
        return;
    }

    // 2. Verificar ANTES de crear. Una company de prueba que no pasa la
    //    verificacion no sirve para nada: es el unico motivo por el que existe.
    // El vendedor sale del owner del NEGOCIO, que aca no existe todavia: esto
    // crea una company, no un pedido. Se le pasa un owner que si es vendedor
    // para que la verificacion hable de los datos de la EMPRESA, que es lo que
    // este script tiene que probar. Sale del catalogo, no escrito a mano.
    const campoVendedor = verificarEmpresa.ALTA.campos.find((c) => c.origen === 'owner');
    const unVendedor = Object.keys(campoVendedor?.porOwner || {})[0] || null;
    const v = verificarEmpresa.verificar({ propiedades: DEMO, lookups: lk, mapper: m, ownerId: unVendedor });

    console.log('Verificacion previa del alta (7.12):');
    console.log('  ok        :', v.ok);
    console.log('  problemas :', v.problemas.length ? JSON.stringify(v.problemas) : 'ninguno');
    console.log('  pendientes:', v.pendientes.length ? JSON.stringify(v.pendientes) : 'ninguno');
    console.log('\nLo que Tango va a recibir en el alta:');
    for (const [k, val] of Object.entries(v.valores)) console.log(`   ${k.padEnd(22)} ${JSON.stringify(val)}`);

    if (!v.ok) {
        console.error('\n❌ La company de prueba NO pasa la verificacion. No se crea.');
        process.exit(1);
    }

    if (!aplicar) {
        console.log('\n(dry-run) nada fue creado.');
        return;
    }

    const creada = await hs.crearObjeto('companies', DEMO);
    console.log(`\n✅ Creada: company ${creada.id}`);
    console.log(`   https://app.hubspot.com/contacts/${cuenta.portalId}/company/${creada.id}`);
    console.log(`\n   Sin ${claveHs} ni tango_id_gva14, a proposito: el primer negocio ganado`);
    console.log('   con esta empresa la va a dar de alta en Tango (§7.12).');
})().catch((e) => {
    console.error('ERROR:', e.message);
    process.exit(1);
});
