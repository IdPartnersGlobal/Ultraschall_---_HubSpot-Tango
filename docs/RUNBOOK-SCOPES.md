# Runbook — destrabar los scopes de HubSpot y dejar el portal listo

Estado al **2026-08-20**. Este es el camino critico: sin esto no hay escritura a
HubSpot y las Fases 2 y 3 estan paradas.

El ciclo `upload → reinstalar → token nuevo` obliga a que alguien apruebe
permisos en el navegador, asi que **conviene hacerlo una sola vez**. Por eso los
scopes de contactos ya estan agregados aunque la Fase 3 venga despues.

---

## 0. Verificar en que estado estamos

```powershell
$cfg = Get-Content HubSpot-Tango\local.settings.json -Raw | ConvertFrom-Json
$r = Invoke-RestMethod -Method Post `
  -Uri "https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info" `
  -ContentType "application/json" -Body (@{tokenKey=$cfg.Values.HUBSPOT_TOKEN} | ConvertTo-Json)
$r.scopes | Sort-Object
```

Medido el 2026-08-20, el token del portal 51311915 devuelve:

```
crm.objects.companies.read      ← solo lectura
crm.objects.contacts.read
crm.objects.contacts.write
crm.objects.deals.read
crm.objects.deals.write
crm.objects.line_items.read
crm.objects.line_items.write
crm.objects.quotes.read
e-commerce
oauth
```

**Faltan cuatro**, los cuatro que ya declara `IdPartners/src/app/app-hsmeta.json`:

| Scope | Sin el, no se puede |
|---|---|
| `crm.objects.companies.write` | escribir ninguna company — Fase 2 entera |
| `crm.schemas.companies.write` | crear las 23 propiedades que faltan ni corregir las mal definidas |
| ~~`crm.schemas.contacts.write`~~ | 🟡 **YA NO HACE FALTA**: la Fase 3 (contactos) quedó fuera de alcance el 2026-08-24 (ARQUITECTURA.md §7.3). Está declarado en `app-hsmeta.json` desde antes. Sacarlo obliga a repetir el ciclo manual `upload → aprobar → token`; dejarlo sólo agrega un permiso que no vamos a usar. **Decidir antes de subir la app.** |
| `crm.objects.owners.read` | mapear vendedor de Tango → owner de HubSpot |

El paso 0 se repite al final para confirmar que quedaron.

---

## 1. Subir la app con los scopes nuevos

`hs` esta instalado (8.9.1) pero **sin autenticar**: no hay `hubspot.config.yml`.

```powershell
cd IdPartners
hs account auth        # abre el navegador; elegir el portal 51311915
hs project upload
```

`hs account auth` es interactivo. Desde el prompt de Claude Code se puede
lanzar con `! hs account auth` para que la salida quede en la conversacion.

---

## 2. Aprobar los permisos nuevos en el portal

Subir la app **no alcanza**: HubSpot no se auto-otorga permisos. En el portal,
en la app privada del proyecto, va a aparecer el aviso de que pide permisos
nuevos. Hay que aprobarlos.

Si el token cambia, copiar el nuevo. Si no cambia, sirve el mismo: lo que
importa es que el paso 0 ya devuelva los cuatro scopes.

---

## 3. Actualizar el token en los dos lados

Es el error facil de este paso: actualizarlo en local y olvidarse de Azure.

1. `HubSpot-Tango/local.settings.json` → `Values.HUBSPOT_TOKEN`
2. Function App `ultraschall-tango-hubspot` → Configuration → Application
   settings → `HUBSPOT_TOKEN`

En Azure ademas sigue abierta la deuda **D1**: falta replicar el rename
`TANGO_API_TOKEN` → `TANGO_API_KEY` y agregar `TANGO_COMPANY`. Aprovechar el
viaje y dejar las cuatro variables bien: `TANGO_API_URL`, `TANGO_API_KEY`,
`TANGO_COMPANY`, `HUBSPOT_TOKEN`.

---

## 4. Dejar el portal en orden

Todos los scripts son **dry-run por defecto**. Correr siempre primero sin
`--aplicar` y leer la salida.

### 4.1 Arreglar las dos propiedades que estan mal creadas

```powershell
cd HubSpot-Tango
node scripts/repararPropiedades.js clientes             # dry-run + backup
node scripts/repararPropiedades.js clientes --aplicar
```

Son propiedades que alguien creo a mano antes de la integracion:

| Propiedad | Que tiene | Por que hay que rehacerla |
|---|---|---|
| `codigo_tango` | `string/text`, **sin** `hasUniqueValue` | Es el `idProperty` del batch upsert. Sin unicidad el upsert no funciona, y `hasUniqueValue` es inmutable. Esta vacia en las 65 companies: no se pierde nada. |
| `cuit` | `number/number` | El formato acordado es texto con guiones (Tango los exige en el alta) y no siempre es un CUIT: segun el tipo de documento puede traer DNI o CUIL. Tiene 3 valores cargados. |

El script guarda los valores en `backup-propiedades-companies-*.json` **antes**
de borrar, y despues los reescribe pasandolos por el transform del mapeo (el
CUIT vuelve como `20-17221498-4`, no como `20172214984`). El backup esta
gitignoreado: trae CUITs reales.

### 4.2 Crear el resto de las propiedades

```powershell
node scripts/crearPropiedades.js clientes               # dry-run
node scripts/crearPropiedades.js clientes --aplicar
# node scripts/crearPropiedades.js contactos  <- NO CORRER: contactos quedo fuera de alcance (2026-08-24)
```

Medido el 2026-08-20 sobre companies: 9 ya existen, **23 a crear**, **2 a
parchear**, 2 a rehacer (las del paso anterior). ~~Sobre contacts: 10 a crear.~~ (contactos quedo fuera de alcance el 2026-08-24).

⚠️ Ese conteo es del 2026-08-20 y el mapeo cambio despues: el 2026-08-24 se saco `domain` y se agrego la opcion `EXE`. Volver a correr el dry-run antes de aplicar; medido contra el portal REAL el 2026-08-24, despues de la revision de campos: **21 a crear**, 10 ya estan, **3 a parchear** (`provincia`, `condicion_iva`, `tipo_de_documento`) y **2 a rehacer** (`codigo_tango`, `cuit`).

Las dos a parchear son los desplegables, y **es el problema mas serio que
apareció en esta revision**:

| Propiedad | Opciones en el portal | Lo que manda Tango |
|---|---|---|
| `condicion_iva` | Responsable Inscripto · Monotributista · Consumidor Final | `RI`, `RS`, `EX`, `CF`, `EXE` |
| `tipo_de_documento` | DNI · CUIT | `0`, `80`, `86`, `91`, `96`, `99` |

HubSpot **rechaza** un valor que no este entre las opciones, y en
`/batch/upsert` el rechazo voltea la tanda de 100 entera, no el registro. Tal
como estaba, la primera corrida con permiso de escritura habria fallado al
100%. Ya esta resuelto en el mapeo (`opciones` traduce codigo → etiqueta) y
el script agrega las opciones que faltan: `Exento`, `Iva exento operacion de exportacion` (agregada el 2026-08-24), `CUIL` y `C.I. Extranjera`.

**`EXE` queda a proposito sin mapear**: no se sabe que significa y no aparece
en la muestra de 300. Esos clientes se sincronizan sin `condicion_iva` y el
sync lo reporta como problema. Definirlo es una linea en
`config/mapeo.clientes.json`.

---

## 5. Primera corrida de verdad

⚠️ `scripts/syncClientes.js` **no se puede correr desde una maquina local**:
Tango tiene firewall por IP y solo acepta trafico desde la Function App
(ARQUITECTURA.md §5.6). La corrida real va si o si en Azure.

En las Application Settings, en este orden:

1. `SYNC_DRY_RUN=true` — dejarlo asi para la primera vuelta.
2. `SYNC_CLIENTES_ENABLED=true` — interruptor propio de la funcion, **apagado
   por defecto** a proposito: desplegar el codigo no arranca el sync solo.
3. Esperar el timer (`SYNC_CLIENTES_CRON`, default 03:00) o forzar la corrida
   desde el portal de Azure.

Leer el resumen en los logs: `leidos de Tango`, `a crear`, `a actualizar`,
`sin cambios`, `con problemas de mapeo`. Los problemas de mapeo esperados son
los `EXE` de `condicion_iva` y los clientes sin tipo de documento resoluble.

Recien cuando el dry-run cierre bien, poner `SYNC_DRY_RUN=false`.

---

## Checklist

- [ ] `hs account auth` + `hs project upload`
- [ ] Permisos aprobados en el portal
- [ ] `HUBSPOT_TOKEN` actualizado en `local.settings.json`
- [ ] `HUBSPOT_TOKEN` actualizado en Azure + deuda D1 (`TANGO_API_KEY`, `TANGO_COMPANY`)
- [ ] Paso 0 devuelve los cuatro scopes que faltaban
- [ ] `repararPropiedades.js clientes --aplicar` (con backup verificado)
- [ ] `crearPropiedades.js clientes --aplicar`
- [ ] `crearPropiedades.js contactos --aplicar`
- [ ] `SYNC_CLIENTES_ENABLED=true` con `SYNC_DRY_RUN=true` en Azure
- [ ] Corrida en dry-run desde Azure, sin problemas inesperados
