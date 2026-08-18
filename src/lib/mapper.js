'use strict';

const crypto = require('node:crypto');

/**
 * Traduce registros de Tango a propiedades de HubSpot segun config/mapeo.*.json.
 *
 * Reglas del mapeo (ver ARQUITECTURA.md 6):
 *  - Cada campo declara { tango, hubspot, tipo, transform?, lookup?, autoritativoTango }.
 *  - `lookup` es la parte critica: si esta presente, el valor NO se copia tal
 *    cual, se resuelve codigo -> ID interno contra la tabla auxiliar. Sin eso
 *    se guardarian codigos en campos llamados tango_id_*, que es justo el bug
 *    que produce datos incorrectos silenciosamente (ARQUITECTURA.md 5.4).
 */

// ---------------------------------------------------------------- transforms

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
         * Convierte un registro de Tango en propiedades de HubSpot.
         * @returns {{ propiedades: object, problemas: string[] }}
         */
        aHubSpot(registro) {
            const propiedades = {};
            const problemas = [];

            for (const campo of campos) {
                let valor = registro[campo.tango];

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

                if (campo.transform) {
                    const fn = transforms[campo.transform];
                    if (!fn) {
                        problemas.push(`transform desconocido '${campo.transform}' en el campo ${campo.tango}`);
                        continue;
                    }
                    valor = fn(valor);
                } else {
                    valor = castear(valor, campo.tipo);
                }

                if (valor !== null && valor !== undefined) propiedades[campo.hubspot] = valor;
            }

            return { propiedades, problemas };
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

module.exports = { crear, transforms, castear };
