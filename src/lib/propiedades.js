'use strict';

/**
 * Compara lo que el mapeo espera contra lo que hay en el portal de HubSpot.
 *
 * Vive en lib/ y no en el script porque es logica pura: recibe el mapeo y la
 * lista de propiedades que devolvio HubSpot, y no toca la red. Asi se puede
 * testear el caso que importa sin scopes ni portal.
 *
 * El caso que motiva esto: `condicion_iva` y `tipo_de_documento` estan creadas
 * en el portal como desplegables con etiquetas ('Responsable Inscripto'), pero
 * Tango manda codigos ('RI'). HubSpot RECHAZA un valor que no este entre las
 * opciones, y en /batch/upsert el rechazo voltea la tanda de 100 entera, no el
 * registro. Sin esta comparacion el error recien aparece en la primera corrida
 * con permiso de escritura, cuando ya es tarde.
 */

const GRUPO = { name: 'tango_erp', label: 'Datos Tango ERP' };

/** Propiedades estandar de HubSpot: no se crean, ya existen. */
const ESTANDAR = new Set([
    'name', 'website', 'phone', 'address', 'city', 'zip', 'state', 'country',
    'description', 'price', 'hs_sku',
    'firstname', 'lastname', 'email', 'jobtitle',
]);

/** Tipo de HubSpot que le corresponde a un campo del mapeo. */
function tipoHubSpot(campo) {
    const t = (campo.hsFieldType || '').toLowerCase();
    if (t === 'number' || campo.tipo === 'number') return { type: 'number', fieldType: 'number' };
    if (t === 'date' || campo.tipo === 'datetime' || campo.tipo === 'date') return { type: 'date', fieldType: 'date' };
    if (t === 'checkbox' || campo.tipo === 'bool' || campo.tipo === 'boolean') return { type: 'bool', fieldType: 'booleancheckbox' };
    // Un desplegable sin opciones es invalido para HubSpot. Si el mapeo no
    // declara `opciones`, se degrada a texto en vez de fallar el alta.
    if (t === 'select') {
        return campo.opciones
            ? { type: 'enumeration', fieldType: 'select' }
            : { type: 'string', fieldType: 'text' };
    }
    return { type: 'string', fieldType: 'text' };
}

/**
 * Las dos opciones que HubSpot exige en un `booleancheckbox`. Sin ellas la
 * creacion falla con "Boolean properties must have exactly two options".
 * Detectado el 2026-08-25 creando `tango_lleva_stock` en products.
 */
const OPCIONES_BOOL = [
    { label: 'Si', value: 'true', displayOrder: 0, hidden: false },
    { label: 'No', value: 'false', displayOrder: 1, hidden: false },
];

/**
 * Opciones de HubSpot a partir del mapeo. `opciones` es codigo -> valor de la
 * opcion, y varios codigos pueden apuntar al mismo valor, asi que se deduplica.
 *
 * La etiqueta es el valor, salvo que el mapeo declare `opcionesEtiquetas`
 * (valor de la opcion -> texto). Eso hace falta cuando el valor tiene que ser
 * estable y cruzable contra el ERP pero no se puede mostrar: el desplegable de
 * deposito guarda `'36'` y comercial tiene que leer "SERVICIO TECNICO". Sin
 * esto habria que elegir entre un valor legible (que se rompe si el ERP
 * renombra el deposito) o una lista de numeros que nadie entiende.
 *
 * El orden en que HubSpot las muestra sale de `opcionesOrden` si el mapeo lo
 * declara. NO alcanza con el orden de `opciones`: JavaScript reordena solo las
 * claves de un objeto que parecen enteros, asi que un mapa con codigos '01' y
 * '36' sale con el '36' PRIMERO. Se descubrio el 2026-08-28 armando el
 * desplegable de deposito, que quedaba con COMPONENTES OBSOLETOS arriba y
 * PRODUCTO TERMINADO —el 66% de los pedidos— en el medio de la lista.
 */
function opcionesDe(campo) {
    if (tipoHubSpot(campo).fieldType === 'booleancheckbox') return OPCIONES_BOOL;
    if (!campo.opciones) return undefined;
    const etiquetas = campo.opcionesEtiquetas || {};
    const declarados = Object.values(campo.opciones);
    const orden = campo.opcionesOrden
        // Lo que el orden no nombre va al final, en vez de desaparecer.
        ? [...campo.opcionesOrden, ...declarados.filter((v) => !campo.opcionesOrden.includes(v))]
        : declarados;
    const vistos = new Set();
    const salida = [];
    for (const valor of orden) {
        if (vistos.has(valor)) continue;
        vistos.add(valor);
        salida.push({
            label: etiquetas[valor] ?? valor,
            value: valor,
            displayOrder: salida.length,
            hidden: false,
        });
    }
    return salida;
}

/**
 * @param {object} mapeo       contenido de config/mapeo.*.json
 * @param {Array}  existentes  respuesta de GET /crm/v3/properties/{objeto}
 * @returns {{ aCrear, yaEstan, aParchear, aRehacer }}
 *
 *  - aCrear:    no existen en el portal.
 *  - aParchear: existen y se arreglan con un PATCH (opciones que faltan).
 *  - aRehacer:  existen mal y NO se arreglan con un PATCH. `type` y
 *               `hasUniqueValue` son inmutables en HubSpot: hay que borrar la
 *               propiedad y recrearla, lo que borra los valores cargados.
 */
function planificar(mapeo, existentes, { grupo = GRUPO.name } = {}) {
    const porNombre = new Map((existentes || []).map((p) => [p.name, p]));
    const clave = mapeo._meta?.claveIdempotencia?.hubspot;
    // La clave es unica salvo que el mapeo diga lo contrario. En pedidos NO lo
    // es: la guarda de idempotencia es "si tiene valor, no se manda de nuevo",
    // y una propiedad unica ahi haria fallar la escritura de vuelta del pedido
    // que SI se creo, que es justo el rastro que no se puede perder.
    const claveEsUnica = mapeo._meta?.claveIdempotencia?.unique !== false;

    const aCrear = [];
    const yaEstan = [];
    const aParchear = [];
    const aRehacer = [];

    for (const campo of mapeo.campos) {
        if (!campo.hubspot || ESTANDAR.has(campo.hubspot)) continue;

        const { type, fieldType } = tipoHubSpot(campo);
        const opciones = opcionesDe(campo);
        const debeSerUnica = campo.hubspot === clave && claveEsUnica;

        const definicion = {
            name: campo.hubspot,
            label: campo.label || campo.hubspot,
            groupName: grupo,
            type,
            fieldType,
            description: (campo.notas || '').slice(0, 250) || undefined,
            hasUniqueValue: debeSerUnica ? true : undefined,
            options: opciones,
        };

        const actual = porNombre.get(campo.hubspot);
        if (!actual) {
            aCrear.push(definicion);
            continue;
        }

        yaEstan.push(campo.hubspot);

        if (debeSerUnica && !actual.hasUniqueValue) {
            aRehacer.push({
                name: campo.hubspot,
                motivo: 'es la clave de idempotencia pero no es unica, y hasUniqueValue no se puede cambiar',
                definicion,
            });
            continue;
        }
        if (actual.type !== type) {
            aRehacer.push({
                name: campo.hubspot,
                motivo: `esta como '${actual.type}/${actual.fieldType}' y el mapeo espera '${type}/${fieldType}'`,
                definicion,
            });
            continue;
        }
        if (opciones) {
            const tiene = new Set((actual.options || []).map((o) => o.value));
            const faltan = opciones.filter((o) => !tiene.has(o.value));
            if (faltan.length) {
                // El PATCH REEMPLAZA la lista entera, no la agrega. Se mandan
                // las viejas (que pueden tener valores cargados en registros
                // reales) junto con las nuevas.
                const viejas = (actual.options || []).map((o, i) => ({
                    label: o.label, value: o.value, displayOrder: i, hidden: false,
                }));
                aParchear.push({
                    name: campo.hubspot,
                    detalle: `faltan opciones: ${faltan.map((o) => `'${o.value}'`).join(', ')}`,
                    cambios: {
                        options: [
                            ...viejas,
                            ...faltan.map((o, i) => ({ ...o, displayOrder: viejas.length + i })),
                        ],
                    },
                });
            }
        }
    }

    return { aCrear, yaEstan, aParchear, aRehacer };
}

module.exports = { GRUPO, ESTANDAR, OPCIONES_BOOL, tipoHubSpot, opcionesDe, planificar };
