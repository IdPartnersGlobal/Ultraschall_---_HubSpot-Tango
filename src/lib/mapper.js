'use strict';

const crypto = require('node:crypto');
const documento = require('./documento');

/**
 * Traduce registros de Tango a propiedades de HubSpot segun config/mapeo.*.json.
 *
 * Reglas del mapeo (ver ARQUITECTURA.md 6):
 *  - Cada campo declara { tango, hubspot, tipo, transform?, lookup?, autoritativoTango }.
 *  - `lookup` es la parte critica: si esta presente, el valor NO se copia tal
 *    cual, se resuelve codigo -> ID interno contra la tabla auxiliar. Sin eso
 *    se guardarian codigos en campos llamados tango_id_*, que es justo el bug
 *    que produce datos incorrectos silenciosamente (ARQUITECTURA.md 5.4).
 *  - `opciones` cumple el mismo papel para las propiedades de tipo desplegable:
 *    HubSpot RECHAZA un valor que no este en la lista de opciones, y en un
 *    batch de 100 el rechazo se lleva puesta la tanda entera. Ver `opciones`
 *    mas abajo.
 */

// ---------------------------------------------------------------- transforms

/**
 * Proveedores de mail e ISPs: su dominio identifica al proveedor, no al
 * cliente. Asignarlo fusionaria empresas que no tienen nada que ver.
 *
 * `fibercorp` y `satlink` estaban nombrados como casos problematicos en las
 * notas del mapeo pero faltaban en la lista; se agregaron el 2026-08-21 al
 * medirlo (SOCIEDAD DE AUXILIOS SANITARIOS SALUD quedaba con fibercorp.com.ar).
 */
const PROVEEDORES = /^(gmail|hotmail|yahoo|outlook|live|icloud|speedy|fibertel|fibercorp|satlink|arnet|ciudad|uolsinectis|infovia|aol|msn|terra|sion|datafull|velocom)\./;

/** Descarta lo que no identifica al cliente. Devuelve el dominio o null. */
function dominioUtil(d) {
    if (!d || !d.includes('.')) return null;
    if (PROVEEDORES.test(d)) return null;
    // MAIL_DE incluye al vendedor de Ultraschall que recibe copia de los
    // comprobantes: sin este filtro 903 clientes comparten el mismo dominio.
    if (d === 'ultraschall.com.ar') return null;
    return d;
}

const transforms = {
    /**
     * Documento del cliente, en UN solo formato: texto con guiones.
     *
     * Decision de Ultraschall (2026-08-18): se guarda como texto, no como
     * numero, y con guiones — Tango los exige en el alta.
     *
     * Ojo: el campo CUIT de Tango no siempre trae un CUIT. Segun el tipo de
     * documento tambien puede traer un DNI ('38.901.611'). Por eso solo se
     * formatea cuando hay 11 digitos; el resto se deja como digitos limpios
     * en vez de forzarlo a una mascara que no le corresponde.
     */
    documentoConGuiones(v) {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        if (s === '') return null;
        const d = s.replace(/\D/g, '');
        if (d.length === 0) return null;
        if (d.length === 11) return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
        return d; // DNI u otro documento: sin mascara de CUIT
    },

    /**
     * Documento del cliente como NUMERO, sin guiones.
     *
     * DECISION 2026-08-27 (Matias): la propiedad `cuit` del portal se creo como
     * `number/number` y en este proyecto no se borran propiedades de HubSpot
     * para recrearlas (7.2). Asi que el que se adapta es el valor.
     *
     * ⚠️ Revierte el formato de `documentoConGuiones`, que sigue existiendo
     * porque los guiones NO desaparecen del circuito: Tango los exige en el
     * alta y se los vuelve a poner `documento.formatear` en la ida. Guardar y
     * mandar dejan de tener el mismo formato a proposito.
     *
     * Un cero adelante no sobrevive a un campo numerico: `01234567` se
     * guardaria como 1234567, que es OTRO documento. En ese caso se omite la
     * propiedad y se reporta, en vez de guardar un numero equivocado. Medido
     * el 2026-08-27 sobre los 300 de la muestra: 0 casos.
     */
    documentoSoloDigitos(v) {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        if (s === '') return null;

        const d = s.replace(/\D/g, '');
        if (d.length === 0) return null;
        if (d[0] === '0') {
            return { omitir: true, motivo: `el documento '${s}' empieza con cero y la propiedad es numerica: guardarlo cambiaria el numero` };
        }
        return Number(d);
    },

    /** Agrega el esquema si falta; descarta lo que no parezca un dominio. */
    normalizarUrl(v) {
        if (!v) return null;
        let s = String(v).trim();
        if (!s || !s.includes('.')) return null;
        if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
        try {
            return new URL(s).toString();
        } catch {
            return null;
        }
    },

    /** Deja digitos y el + inicial. '(0376)4434782' -> '03764434782'. */
    normalizarTelefono(v) {
        if (!v) return null;
        const s = String(v).trim();
        const mas = s.startsWith('+') ? '+' : '';
        const d = s.replace(/\D/g, '');
        return d.length ? mas + d : null;
    },

    /**
     * Dominio corporativo a partir de una direccion de mail.
     *
     * HubSpot usa `domain` como clave natural para deduplicar companies, asi
     * que un dominio mal asignado FUSIONA empresas. Por eso descarta:
     *  - proveedores gratuitos (gmail, hotmail, fibertel...): el dominio no
     *    identifica a la empresa.
     *  - ultraschall.com.ar: MAIL_DE es la lista de destinatarios de
     *    comprobantes e incluye al vendedor de Ultraschall que recibe copia.
     *    Sin este filtro, 903 clientes quedarian con el mismo dominio.
     *
     * Devolver un candidato NO alcanza: el sync ademas descarta los dominios
     * que aparecen en mas de un cliente (ver syncClientes.dominiosUnicos).
     */
    dominioDeMail(v) {
        if (!v) return null;
        const primera = String(v).split(/[;,]/)[0].trim().toLowerCase();
        const m = primera.match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
        if (!m) return null;
        return dominioUtil(m[1]);
    },

    /**
     * '2018-08-29T00:00:00' -> epoch ms UTC a medianoche.
     * HubSpot exige medianoche UTC en las propiedades de tipo date.
     */
    fechaTangoAEpoch(v) {
        if (!v) return null;
        const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    },
};

// ------------------------------------------------- transforms de registro
//
// Reciben el registro COMPLETO, no un campo. Son para los casos en que el
// valor de una propiedad no sale de una sola columna de Tango.

const transformsRegistro = {
    /**
     * Tipo de documento como tipo logico, no como codigo crudo.
     *
     * COD_TIPO_DOCUMENTO_GV = 0 lo etiqueta Tango "C.I. POLICIA FEDERAL" pero
     * en los hechos es el default de un campo sin cargar, y lo tiene el 54% de
     * la muestra. Copiarlo tal cual llenaria mas de media cartera con una
     * etiqueta falsa. `documento.resolver` respeta el tipo cuando Tango lo
     * declara y solo infiere cuando dice "sin definir", cruzando digito
     * verificador y prefijo AFIP (ver lib/documento.js).
     *
     * Devuelve null cuando no se puede determinar: la propiedad se omite en
     * vez de escribir un valor inventado.
     */
    tipoDocumento(registro) {
        return documento.resolver(registro).tipo;
    },
};

// ------------------------------------------------------------------ casteos

function castear(valor, tipo) {
    if (valor === null || valor === undefined) return null;
    switch (tipo) {
        case 'number': {
            // Ojo: Number('') es 0, no NaN. Sin este guard un campo vacio se
            // guardaria como 0, que en Tango significa algo distinto de "sin dato".
            if (typeof valor === 'string' && valor.trim() === '') return null;
            const n = Number(valor);
            return Number.isFinite(n) ? n : null;
        }
        case 'bool':
        case 'boolean':
            return typeof valor === 'boolean' ? valor : /^(s|si|true|1)$/i.test(String(valor).trim());
        case 'string':
        default: {
            const s = String(valor).trim();
            return s === '' ? null : s;
        }
    }
}

// ------------------------------------------------------------------- mapper

/**
 * @param {object} mapeo    contenido de config/mapeo.*.json
 * @param {object} lookups  instancia de lib/lookups (opcional si el mapeo no usa lookup)
 */
function crear(mapeo, lookups = null) {
    const campos = mapeo.campos.filter((c) => c.tango && c.hubspot);

    const conLookup = campos.filter((c) => c.lookup);
    if (conLookup.length && !lookups) {
        throw new Error(
            `mapper: el mapeo '${mapeo._meta?.entidad}' usa lookups (${conLookup.map((c) => c.hubspot).join(', ')}) ` +
            'pero no se paso la instancia de lookups. Sin ella se guardarian codigos en vez de IDs internos.'
        );
    }

    return {
        /**
         * La definicion del mapeo ya filtrada. La necesita quien tiene que ir
         * en la direccion contraria (lib/verificarEmpresa lee `opciones` al
         * reves para volver de la etiqueta de HubSpot al codigo de Tango).
         */
        campos,

        /**
         * Convierte un registro de Tango en propiedades de HubSpot.
         * @returns {{ propiedades: object, problemas: string[] }}
         */
        aHubSpot(registro) {
            const propiedades = {};
            const problemas = [];

            for (const campo of campos) {
                // Un campo derivado no existe en Tango: se calcula a partir de
                // otros. Toma el primero de la lista que tenga dato.
                let valor = campo.derivadoDe
                    ? campo.derivadoDe.map((f) => registro[f]).find((v) => v !== null && v !== undefined && String(v).trim() !== '')
                    : registro[campo.tango];

                if (campo.lookup) {
                    const r = lookups.resolver(campo.lookup, valor, `${mapeo._meta?.entidad} ${registro[mapeo._meta?.claveIdempotencia?.tango] ?? ''}`.trim());
                    if (!r.ok) {
                        // No se inventa un valor: se omite la propiedad y se reporta.
                        if (valor !== null && valor !== undefined && String(valor).trim() !== '') problemas.push(r.motivo);
                        continue;
                    }
                    propiedades[campo.hubspot] = r.id;
                    continue;
                }

                if (campo.transformRegistro) {
                    const fn = transformsRegistro[campo.transformRegistro];
                    if (!fn) {
                        problemas.push(`transformRegistro desconocido '${campo.transformRegistro}' en el campo ${campo.hubspot}`);
                        continue;
                    }
                    valor = fn(registro);
                } else if (campo.transform) {
                    const fn = transforms[campo.transform];
                    if (!fn) {
                        problemas.push(`transform desconocido '${campo.transform}' en el campo ${campo.tango}`);
                        continue;
                    }
                    valor = fn(valor);
                } else {
                    valor = castear(valor, campo.tipo);
                }

                // Un transform puede decidir que el valor NO se puede guardar
                // sin cambiarlo (un documento con cero adelante en un campo
                // numerico). Mismo criterio que los desplegables: se omite la
                // propiedad y se reporta, nunca se guarda algo distinto de lo
                // que hay en Tango.
                if (valor && typeof valor === 'object' && valor.omitir) {
                    problemas.push(`${campo.hubspot}: ${valor.motivo}`);
                    continue;
                }

                // Desplegable: el valor tiene que ser una opcion existente. Si
                // no esta en la tabla se omite y se reporta; escribirlo igual
                // haria que HubSpot rechace la tanda completa de 100.
                if (campo.opciones && valor !== null && valor !== undefined) {
                    const opcion = campo.opciones[String(valor)];
                    if (opcion === undefined) {
                        problemas.push(`${campo.hubspot}: el valor '${valor}' no tiene opcion definida en el mapeo`);
                        continue;
                    }
                    valor = opcion;
                }

                if (valor !== null && valor !== undefined) propiedades[campo.hubspot] = valor;
            }

            return { propiedades, problemas };
        },

        /**
         * Direccion inversa, para el alta: valor de un desplegable de HubSpot
         * -> ID interno de Tango.
         *
         * Existe porque una company creada a mano en HubSpot NO tiene
         * `tango_id_gva18`: lo unico que hay es lo que comercial eligio en el
         * desplegable. Para las companies que vinieron del sync esto no hace
         * falta — el ID ya esta guardado (ARQUITECTURA.md 5.3).
         *
         * El mapeo guarda el CODIGO de Tango, no el ID: el ID lo resuelve
         * `lookups` contra la tabla viva, asi no queda hardcodeado y no se
         * desincroniza si el ERP cambia.
         *
         * ⚠️ Varias descripciones de Tango pueden caer en la misma opcion de
         * HubSpot con IDs distintos ('Capital Federal' y 'CABA' son dos filas
         * de GVA18). El empate NO se adivina aca: viene resuelto y documentado
         * en `opcionesInversas` del mapeo.
         *
         * @returns {{ok: boolean, id: number|null, codigo: string|null, motivo?: string}}
         */
        desdeOpcion(nombreHubSpot, valorOpcion) {
            const campo = campos.find((c) => c.hubspot === nombreHubSpot && c.opcionesInversas);
            if (!campo) return { ok: false, id: null, codigo: null, motivo: `${nombreHubSpot}: el mapeo no declara opcionesInversas` };
            if (valorOpcion === null || valorOpcion === undefined || String(valorOpcion).trim() === '') {
                return { ok: false, id: null, codigo: null, motivo: `${nombreHubSpot}: sin valor` };
            }
            const codigo = campo.opcionesInversas[String(valorOpcion).trim()];
            if (codigo === undefined) {
                return { ok: false, id: null, codigo: null, motivo: `${nombreHubSpot}: la opcion '${valorOpcion}' no tiene equivalencia en Tango` };
            }
            // La tabla puede declararse en el campo del desplegable
            // (`lookupInverso`) o venir de un campo que ya la usa: en el mapeo
            // de clientes el desplegable es `provincia` pero el lookup vive en
            // `tango_id_gva18`, que es otro campo.
            const tabla = campo.lookupInverso || campo.lookup;
            if (!tabla) return { ok: true, id: null, codigo };
            const r = lookups.resolver(tabla, codigo, nombreHubSpot);
            return r.ok ? { ok: true, id: r.id, codigo } : { ok: false, id: null, codigo, motivo: r.motivo };
        },

        /** Clave de idempotencia del registro. */
        clave(registro) {
            const c = mapeo._meta?.claveIdempotencia?.tango;
            if (!c) throw new Error(`mapper: el mapeo '${mapeo._meta?.entidad}' no declara claveIdempotencia`);
            const v = registro[c];
            return v === null || v === undefined ? null : String(v).trim();
        },

        /** Campos que el sync pisa en cada corrida. El resto solo se escribe si esta vacio. */
        camposAutoritativos() {
            return campos.filter((c) => c.autoritativoTango).map((c) => c.hubspot);
        },

        /**
         * Campos que NO se pisan: si el registro ya tiene valor en HubSpot, se
         * respeta. Es lo que protege la migracion manual que hizo Ultraschall
         * (nombres normalizados a mano, direcciones corregidas) de volver a
         * quedar como los tiene Tango en la proxima corrida.
         */
        camposNoAutoritativos() {
            return [...new Set(campos.filter((c) => !c.autoritativoTango).map((c) => c.hubspot))];
        },

        /**
         * Hash del resultado mapeado. Base de la escritura diferencial:
         * como Tango no tiene fecha de modificacion (ARQUITECTURA.md 8.2),
         * es la unica forma de no reescribir 5670 companies por corrida.
         */
        hash(propiedades) {
            const ordenado = Object.keys(propiedades).sort().map((k) => `${k}=${propiedades[k]}`).join('|');
            return crypto.createHash('sha1').update(ordenado).digest('hex').slice(0, 16);
        },
    };
}

module.exports = { crear, transforms, transformsRegistro, castear };
