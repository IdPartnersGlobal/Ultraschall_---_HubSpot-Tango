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

/**
 * Saltos de `type` que HubSpot acepta por PATCH, verificados contra el portal.
 * Fuera de esta lista se asume que hay que rehacer la propiedad. La lista se
 * amplia SONDEANDO, no razonando: el costo de equivocarse es borrar datos.
 */
const CONVERTIBLE = new Set(['string->enumeration']);

/** Propiedades estandar de HubSpot: no se crean, ya existen. */
const ESTANDAR = new Set([
    'name', 'website', 'phone', 'address', 'city', 'zip', 'state', 'country',
    'description', 'price', 'hs_sku',
    'firstname', 'lastname', 'email', 'jobtitle',
    // La moneda del negocio. La define HubSpot con las divisas de la cuenta:
    // crearla o parchearla desde aca la romperia.
    'deal_currency_code',
]);

/** Tipo de HubSpot que le corresponde a un campo del mapeo. */
function tipoHubSpot(campo) {
    const t = (campo.hsFieldType || '').toLowerCase();
    if (t === 'number' || campo.tipo === 'number') return { type: 'number', fieldType: 'number' };
    if (t === 'date' || campo.tipo === 'datetime' || campo.tipo === 'date') return { type: 'date', fieldType: 'date' };
    if (t === 'checkbox' || campo.tipo === 'bool' || campo.tipo === 'boolean') return { type: 'bool', fieldType: 'booleancheckbox' };
    // Un desplegable sin opciones es invalido para HubSpot. Si el mapeo no
    // declara `opciones`, se degrada a texto en vez de fallar el alta.
    //
    // ⚠️ Esa degradacion es SILENCIOSA y costo 11 propiedades: el mapeo pedia
    // `select` para tango_vendedor, tango_zona, tango_perfil y ocho mas, nadie
    // les cargo `opciones`, y quedaron de texto libre en el portal sin que nada
    // fallara — `planificar` las comparaba contra la spec ya degradada y
    // reportaba `0 a rehacer`. Se descubrio el 2026-09-01. La red que lo
    // impide de ahora en mas NO es este `if`, que sigue siendo la salida
    // segura, sino el test que falla si algun mapeo declara select o checkbox
    // sin opciones (test/propiedades.test.js).
    //
    // `multiselect` es el multivalor de HubSpot —varias opciones a la vez,
    // separadas por ';', que es justo como Tango entrega CLASIFICACION—, y en
    // HubSpot se llama `checkbox`.
    //
    // ⚠️ NO se puede usar `checkbox` como nombre en el mapeo: ahi ya significa
    // la casilla booleana (mapeo.contactos lo usa asi para DEFECTO y
    // PAGADOR_HABITUAL), y ademas la rama de arriba lo agarra primero. Con ese
    // nombre, tango_clasificacion salia `booleancheckbox` y sus 11 opciones se
    // reemplazaban por Si/No.
    if (t === 'select' || t === 'multiselect') {
        return campo.opciones
            ? { type: 'enumeration', fieldType: t === 'multiselect' ? 'checkbox' : 'select' }
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
 * `opcionesOcultas` marca valores con `hidden: true`. NO es lo mismo que
 * sacarlos de la lista: una opcion oculta no se OFRECE en el desplegable pero
 * se sigue pudiendo ESCRIBIR por API (verificado contra el portal el
 * 2026-09-01). Es la unica forma de tratar los registros dados de baja en un
 * campo que escribe el sync: si el vendedor inhabilitado no esta entre las
 * opciones, el cliente que lo tiene asignado hace fallar la escritura con 400
 * INVALID_OPTION; si esta visible, comercial se lo puede elegir a uno muerto.
 *
 * Esto NO aplica a los campos que elige comercial, como tango_deposito: ahi el
 * de baja se saca de la lista y listo, porque nadie tiene ese valor guardado.
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
    const ocultas = new Set(campo.opcionesOcultas || []);
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
            hidden: ocultas.has(valor),
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
 *  - aParchear: existen y se arreglan con un PATCH (opciones que faltan, o
 *               una opcion que hay que ocultar/mostrar).
 *  - aConvertir: existen con el tipo equivocado y SI se arreglan con un PATCH.
 *               HubSpot deja pasar `string` a `enumeration` sin borrar nada, y
 *               los valores ya cargados sobreviven — incluso los que no estan
 *               entre las opciones nuevas. Verificado contra el portal el
 *               2026-09-01 con dos propiedades descartables.
 *  - aRehacer:  existen mal y NO se arreglan con un PATCH. `hasUniqueValue` es
 *               inmutable: hay que borrar la propiedad y recrearla, lo que
 *               borra los valores cargados.
 *  - sobrantes: opciones que estan en el portal y el mapeo ya no declara. Solo
 *               se INFORMAN; `aParchear` las sigue mandando para no perderlas.
 *               Quitar una opcion que nadie uso no borra ningun dato, pero
 *               quitar una que si se uso vacia el campo en esos registros — y
 *               saber cual es cual exige contar contra el portal, que es red.
 *               Lo resuelve `crearPropiedades --quitar-sobrantes`.
 *
 * ⚠️ Hasta el 2026-09-01 CUALQUIER diferencia de `type` caia en aRehacer,
 * porque se daba por sentado que `type` era inmutable como `hasUniqueValue`.
 * Nunca se habia probado. Esa suposicion es la razon por la que tango_perfil
 * se dejo de texto libre a proposito: se creia que hacerlo desplegable exigia
 * borrar la propiedad, y eso choca con la regla de no borrar ninguna.
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
    const aConvertir = [];
    const aRehacer = [];
    const sobrantes = [];

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

        // El GRUPO y la ETIQUETA. Se comparan aparte de las opciones porque una
        // propiedad puede estar perfecta de tipo y valores y aun asi vivir en el
        // lugar equivocado — y ahi comercial no la encuentra, o peor, la
        // encuentra con un nombre que no dice de que es.
        //
        // Descubierto el 2026-09-04 con `condiciones_de_pago`: ya existia, en
        // "Informacion del negocio" y con la etiqueta de la planilla vieja. El
        // planificador la daba por buena porque solo miraba tipo y opciones.
        //
        // ⚠️ El NOMBRE INTERNO no se puede cambiar en HubSpot, ni aca ni a mano:
        // una propiedad se llama para siempre como se creo. Por eso esto mueve y
        // renombra lo que se ve, y el `name` queda como esta.
        const mudanza = {};
        if (actual.groupName !== grupo) mudanza.groupName = grupo;
        if (campo.label && actual.label !== campo.label) mudanza.label = campo.label;
        const detalleMudanza = [
            mudanza.groupName ? `esta en el grupo '${actual.groupName}' y va en '${grupo}'` : null,
            mudanza.label ? `se llama '${actual.label}' y el mapeo dice '${campo.label}'` : null,
        ].filter(Boolean).join(' · ');

        /** Un solo PATCH por propiedad: la mudanza viaja con lo que haya. */
        const parchear = (detalle, cambios) => aParchear.push({
            name: campo.hubspot,
            detalle: [detalle, detalleMudanza].filter(Boolean).join(' · '),
            cambios: { ...mudanza, ...cambios },
        });

        if (debeSerUnica && !actual.hasUniqueValue) {
            aRehacer.push({
                name: campo.hubspot,
                motivo: 'es la clave de idempotencia pero no es unica, y hasUniqueValue no se puede cambiar',
                definicion,
            });
            continue;
        }
        if (actual.type !== type || actual.fieldType !== fieldType) {
            const detalle = `esta como '${actual.type}/${actual.fieldType}' y el mapeo espera '${type}/${fieldType}'`;
            // El unico salto medido es de texto libre a desplegable, que es el
            // que hace falta. Cualquier otro sigue siendo aRehacer: no se
            // convierte a ciegas algo que no se probo.
            if (CONVERTIBLE.has(`${actual.type}->${type}`)) {
                aConvertir.push({
                    name: campo.hubspot,
                    detalle,
                    cambios: { type, fieldType, options: opciones },
                });
            } else {
                aRehacer.push({ name: campo.hubspot, motivo: detalle, definicion });
            }
            continue;
        }
        if (opciones) {
            const porValor = new Map((actual.options || []).map((o) => [o.value, o]));
            const faltan = opciones.filter((o) => !porValor.has(o.value));

            // Opciones que estan en el portal y el mapeo ya no declara. NO se
            // tocan desde aca: `aParchear` sigue mandandolas para no perderlas.
            // Se informan aparte porque quitar una opcion que nadie uso no es
            // borrar un dato, pero quitar una que SI se uso vacia el campo en
            // esos registros — y eso lo tiene que decidir alguien mirando el
            // conteo real, no este modulo, que no habla con la red.
            const queridas = new Set(opciones.map((o) => o.value));
            const sinDeclarar = (actual.options || []).filter((o) => !queridas.has(o.value));
            if (sinDeclarar.length) {
                sobrantes.push({
                    name: campo.hubspot,
                    valores: sinDeclarar.map((o) => o.value),
                    // La lista que quedaria si se las saca, ya lista para el PATCH.
                    cambios: {
                        options: opciones.map((o, i) => ({ ...o, displayOrder: i })),
                    },
                });
            }
            // Una opcion que el mapeo quiere ocultar (un vendedor dado de baja)
            // y en el portal esta visible, o al reves.
            const visibilidadMal = opciones.filter(
                (o) => porValor.has(o.value) && !!porValor.get(o.value).hidden !== o.hidden,
            );

            if (faltan.length || visibilidadMal.length) {
                // El PATCH REEMPLAZA la lista entera, no la agrega. Se mandan
                // las viejas (que pueden tener valores cargados en registros
                // reales) junto con las nuevas.
                //
                // ⚠️ `hidden` se preserva de lo que ya hay en el portal, salvo
                // que el mapeo diga otra cosa. Reconstruirlas con `hidden:
                // false` fijo —como estaba hasta el 2026-09-01— DES-OCULTA en
                // cada corrida todo lo que se hubiera ocultado, y el sync es
                // idempotente: bastaba con que apareciera una opcion nueva
                // para que volvieran a la lista los dados de baja.
                const queridas = new Map(opciones.map((o) => [o.value, o]));

                // ⚠️ HubSpot exige que las ETIQUETAS sean unicas, no solo los
                // valores: "Property option labels must be unique". Cuando un
                // desplegable cambia de valores —tango_zona paso de guardar
                // 'CABA' a guardar '01', las dos con etiqueta CABA— mandar las
                // viejas junto con las nuevas choca de frente y el PATCH se cae
                // entero. Pasó el 2026-09-01 en las cuatro propiedades a la vez.
                //
                // La vieja NO se puede tirar (puede tener valores cargados), asi
                // que se le desambigua la etiqueta. Queda fea a proposito: es
                // una opcion que el mapeo ya no declara y que conviene sacar con
                // --quitar-sobrantes en cuanto se confirme que nadie la usa.
                const etiquetasNuevas = new Set(opciones.map((o) => o.label));
                const viejas = (actual.options || []).map((o, i) => ({
                    label: queridas.has(o.value) || !etiquetasNuevas.has(o.label)
                        ? o.label
                        : `${o.label} (valor anterior: ${o.value})`,
                    value: o.value,
                    displayOrder: i,
                    hidden: queridas.has(o.value) ? queridas.get(o.value).hidden : !!o.hidden,
                }));
                const detalle = [
                    faltan.length ? `faltan opciones: ${faltan.map((o) => `'${o.value}'`).join(', ')}` : null,
                    visibilidadMal.length ? `visibilidad distinta: ${visibilidadMal.map((o) => `'${o.value}'->${o.hidden ? 'oculta' : 'visible'}`).join(', ')}` : null,
                ].filter(Boolean).join(' · ');

                parchear(detalle, {
                    options: [
                        ...viejas,
                        ...faltan.map((o, i) => ({ ...o, displayOrder: viejas.length + i })),
                    ],
                });
                continue;
            }
        }

        // Nada que tocar en las opciones, pero la propiedad esta en el grupo
        // equivocado o con otra etiqueta.
        if (Object.keys(mudanza).length) parchear(null, {});
        continue;
        {
        }
    }

    return { aCrear, yaEstan, aParchear, aConvertir, aRehacer, sobrantes };
}

module.exports = { GRUPO, ESTANDAR, OPCIONES_BOOL, CONVERTIBLE, tipoHubSpot, opcionesDe, planificar };
