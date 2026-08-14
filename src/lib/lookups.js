'use strict';

const procesos = require('../../config/tango.processes.json');

/**
 * Resolucion codigo -> ID interno de Tango.
 *
 * POR QUE EXISTE ESTE MODULO
 * --------------------------
 * La lectura de Tango devuelve CODIGOS (GVA23_CODIGO = '24') pero el alta
 * exige IDs INTERNOS (ID_GVA23 = 25). No son lo mismo. Verificado el
 * 2026-08-14 sobre las 6 tablas auxiliares: las 6 divergen.
 *
 * Y el modo de falla es silencioso: como los rangos de codigo e ID se
 * solapan, mandar el codigo no da error — graba OTRO registro valido.
 * Medido sobre los 5670 clientes reales:
 *
 *   GVA18 provincias : 4022 clientes (71%) -> "Buenos Aires" se grabaria "Capital Federal"
 *   GVA23 vendedores :  484 clientes (10%) -> "Juan Butorac" se grabaria "Natali Vazquez"
 *   GVA24 transportes:  278 clientes (6%)  -> "A CONVENIR" se grabaria "RETIRA BICENTENARIO"
 *
 * Detalle en ARQUITECTURA.md 5.4.
 */

/** Normaliza un codigo para comparar: '05', 5 y ' 5 ' son el mismo. */
function clave(valor) {
    if (valor === null || valor === undefined) return null;
    const s = String(valor).trim();
    if (s === '') return null;
    // Los codigos numericos vienen con ceros a la izquierda de forma inconsistente
    // ('05' en una tabla, 5 en otra). Se normalizan a numero cuando se puede.
    return /^\d+$/.test(s) ? String(Number(s)) : s.toUpperCase();
}

class TablaAuxiliar {
    constructor(nombre, def, registros) {
        this.nombre = nombre;
        this.def = def;
        this.registros = registros;
        this.porCodigo = new Map();
        this.porId = new Map();

        for (const r of registros) {
            const k = clave(r[def.codigo]);
            const id = Number(r[def.id]);
            if (k !== null && !this.porCodigo.has(k)) this.porCodigo.set(k, r);
            if (Number.isFinite(id)) this.porId.set(id, r);
        }
    }

    /** Codigo -> ID interno. Devuelve null si el codigo no existe. */
    id(codigo) {
        const r = this.porCodigo.get(clave(codigo));
        return r ? Number(r[this.def.id]) : null;
    }

    /** Codigo -> descripcion legible. */
    descripcion(codigo) {
        const r = this.porCodigo.get(clave(codigo));
        return r && this.def.descripcion ? r[this.def.descripcion] : null;
    }

    /** Registro completo por codigo. */
    registro(codigo) {
        return this.porCodigo.get(clave(codigo)) || null;
    }

    /**
     * Diagnostico: cuantos codigos coinciden con su ID.
     * Sirve para detectar si una tabla nueva es de las peligrosas.
     */
    divergencia() {
        let iguales = 0, distintos = 0;
        for (const r of this.registros) {
            const c = Number(r[this.def.codigo]);
            const i = Number(r[this.def.id]);
            if (!Number.isFinite(c) || !Number.isFinite(i)) continue;
            c === i ? iguales++ : distintos++;
        }
        return { total: this.registros.length, iguales, distintos };
    }
}

/**
 * Carga todas las tablas auxiliares del catalogo y arma los diccionarios.
 * Son tablas chicas (9 a 86 registros) y estables: se cachean por corrida.
 *
 * @param {object} tango  cliente de tangoClient
 * @param {object} log
 * @returns {Promise<Lookups>}
 */
async function cargar(tango, log = require('./logger').silencioso) {
    const tablas = {};
    const fallidas = [];

    for (const [nombre, def] of Object.entries(procesos.auxiliares)) {
        if (nombre.startsWith('_')) continue;
        try {
            const { registros } = await tango.get(def.process);
            tablas[nombre] = new TablaAuxiliar(nombre, def, registros);
            const d = tablas[nombre].divergencia();
            log.paso('LOOKUP', `${nombre} (${def.tabla}, process=${def.process}): ${d.total} registros, ${d.distintos} divergen`);
        } catch (e) {
            fallidas.push({ nombre, error: e.message });
            log.error('LOOKUP', `no se pudo cargar ${nombre} (process=${def.process}): ${e.message}`);
        }
    }

    if (fallidas.length) {
        // Sin los diccionarios completos NO se puede escribir en Tango:
        // se grabarian valores incorrectos sin error. Preferimos cortar.
        throw new Error(
            `No se pudieron cargar ${fallidas.length} tablas auxiliares: ` +
            fallidas.map((f) => f.nombre).join(', ') +
            '. Escribir en Tango sin ellas produciria datos incorrectos silenciosamente.'
        );
    }

    return new Lookups(tablas);
}

class Lookups {
    constructor(tablas) {
        this.tablas = tablas;
    }

    tabla(nombre) {
        const t = this.tablas[nombre];
        if (!t) throw new Error(`lookups: no existe la tabla auxiliar '${nombre}'`);
        return t;
    }

    // Atajos por entidad. Devuelven el ID interno o null.
    condicionVenta(cod) { return this.tabla('condicionesVenta').id(cod); }
    vendedor(cod)       { return this.tabla('vendedores').id(cod); }
    transporte(cod)     { return this.tabla('transportes').id(cod); }
    provincia(cod)      { return this.tabla('provincias').id(cod); }
    zona(cod)           { return this.tabla('zonas').id(cod); }
    alicuotaIva(cod)    { return this.tabla('alicuotasIva').id(cod); }

    /**
     * Resuelve un codigo y explica el fallo si no se puede.
     * Usar en el armado de payloads: nunca mandar un codigo sin resolver.
     */
    resolver(nombreTabla, codigo, contexto = '') {
        const t = this.tabla(nombreTabla);
        if (codigo === null || codigo === undefined || String(codigo).trim() === '') {
            return { ok: false, id: null, motivo: `${nombreTabla}: el registro no tiene codigo${contexto ? ` (${contexto})` : ''}` };
        }
        const id = t.id(codigo);
        if (id === null) {
            return { ok: false, id: null, motivo: `${nombreTabla}: el codigo '${codigo}' no existe en ${t.def.tabla}${contexto ? ` (${contexto})` : ''}` };
        }
        return { ok: true, id, descripcion: t.descripcion(codigo) };
    }

    /** Construye Lookups desde registros ya cargados. Para tests sin red. */
    static desdeRegistros(porNombre) {
        const tablas = {};
        for (const [nombre, registros] of Object.entries(porNombre)) {
            const def = procesos.auxiliares[nombre];
            if (!def) throw new Error(`lookups: '${nombre}' no esta en config/tango.processes.json`);
            tablas[nombre] = new TablaAuxiliar(nombre, def, registros);
        }
        return new Lookups(tablas);
    }
}

module.exports = { cargar, Lookups, TablaAuxiliar, clave };
