# Arquitectura — Integración Tango ERP ↔ HubSpot (Ultraschall)

> **Estado del documento:** borrador vivo. Es la fuente de verdad de la integración.
> Todo lo marcado con 🟡 **PENDIENTE** está esperando definición o dato de Ultraschall / Matías.
> Todo lo marcado con ⚠️ es una inferencia mía que hay que confirmar contra Tango.
>
> Última actualización: 2026-08-12

---

## 1. Objetivo y alcance

Sincronizar la información maestra y transaccional entre **Tango Gestión** (ERP de Ultraschall, hosteado en Claro Cloud) y **HubSpot** (CRM), de modo que:

- Comercial trabaje en HubSpot con la cartera de clientes y el catálogo reales del ERP.
- Lo que se cierra en HubSpot impacte en Tango sin recarga manual.

### Alcance por fase

| Fase | Flujo | Origen → Destino | Estado |
|---|---|---|---|
| 0 | Conectividad y proxy a Tango | — | ✅ Hecho |
| 1 | Artículos → catálogo | Tango `STA11` → HubSpot **Products** | 🔨 A construir (piloto, 825 reg.) |
| 2 | Clientes → cuentas | Tango `GVA14` → HubSpot **Companies** | 🔨 A construir (5.668 reg.) |
| 3 | Contactos | Tango `GVA14` (email) → HubSpot **Contacts** | 🟡 PENDIENTE definir (ver §7.3) |
| 4 | Pedidos | HubSpot **Deal** ganado → Tango `Api/Create` (`process=19845`) | 🔨 A construir — payload ya relevado (§9) |

🟡 **PENDIENTE:** confirmar si el alcance real es éste o si hay que sumar comprobantes/saldos de cuenta corriente.

---

## 2. Estado actual (qué existe hoy)

Repo `HubSpot-Tango/` — Azure Functions Node.js, modelo de programación v4.

```
HubSpot-Tango/
├─ src/
│  ├─ index.js                      → app.setup({ enableHttpStream: true })
│  └─ functions/
│     └─ testTangoConnection.js     → proxy genérico HTTP → Tango
├─ host.json
├─ local.settings.json              → secretos locales (NO commitear)
└─ .github/workflows/               → deploy a Azure en push a main
```

**`testTangoConnection`** es un proxy pass-through:
- `GET` → por defecto pega a `Api/Get`; `POST` → por defecto a `Api/Create`.
- Se puede forzar la ruta con el query param `?tangoPath=...` (se elimina antes de reenviar).
- Reenvía todos los demás query params tal cual y agrega los headers de Tango.
- Devuelve la respuesta de Tango envuelta en `{ status, proxyTarget, method, latencyMs, totalFunctionTimeMs, result }`.

Sirvió para validar conectividad y relevar datos. **No es la función de producción**: en la arquitectura final queda como herramienta de diagnóstico (ver §4).

### Deuda técnica detectada

| # | Problema | Archivo | Acción | Estado |
|---|---|---|---|---|
| D1 | `local.settings.json` define `TANGO_API_TOKEN`, pero el código lee `TANGO_API_KEY`. Además falta `TANGO_COMPANY`. | `local.settings.json` | Unificar a `TANGO_API_KEY` y agregar `TANGO_COMPANY`. | ✅ 2026-08-14. Se sumaron `HUBSPOT_TOKEN` y `SYNC_DRY_RUN` como placeholders. ⚠️ **Falta replicar el rename en las Application Settings de Azure.** |
| D2 | `authLevel: 'anonymous'` en un proxy que expone el ERP entero a internet, incluido el `POST → Api/Create`. | `testTangoConnection.js` | Pasar a `function` (API key) o restringir por red. Ver §10. | ⏸️ **Abierta a propósito.** Se mantiene `anonymous` mientras dura el relevamiento (§5.6). Cerrar antes de producción. |
| D3 | `pdfkit` está en `dependencies` sin uso aparente. | `package.json` | Confirmar si se usa; si no, sacar. | ✅ 2026-08-14. Sin usos; removido y lock regenerado. Queda `@azure/functions` como única dependencia. |
| D4 | README vacío ("First commit"). | `README.md` | Completar con setup local + deploy. | ✅ 2026-08-14. |
| D5 | `.gitignore` ignoraba `.funcignore`, así que nunca llegaba al repo. | `.gitignore` | Sacarlo de la sección de empaquetados. | ✅ 2026-08-14. |
| D6 | `config/` y `docs/` estaban **untracked**: mapeos, payloads y esta arquitectura sólo existían en la máquina de Matías. | — | Commitear al repo. | ✅ 2026-08-14. |

---

## 3. Diagrama de arquitectura

```mermaid
flowchart LR
    subgraph TANGO["Tango Gestión — Claro Cloud"]
        TAPI["API REST\n:17000\nApi/Get · Api/Create"]
    end

    subgraph AZURE["Azure Functions — ultraschall-tango-hubspot"]
        direction TB
        SYNCP["syncProductos\n(timer)"]
        SYNCC["syncClientes\n(timer)"]
        DEALS["dealToTango\n(HTTP · webhook)"]
        DIAG["testTangoConnection\n(diagnóstico)"]
        LIB["lib/\ntangoClient · hubspotClient\nmapper · logger"]
    end

    subgraph HS["HubSpot — Ultraschall"]
        PROD["Products"]
        COMP["Companies"]
        DEAL["Deals"]
    end

    TAPI -->|"GET paginado"| SYNCP & SYNCC
    SYNCP -->|"batch upsert"| PROD
    SYNCC -->|"batch upsert"| COMP
    DEAL -->|"workflow / webhook"| DEALS
    DEALS -->|"POST Api/Create"| TAPI
    SYNCP & SYNCC & DEALS -.-> LIB
    DIAG -.-> TAPI
```

---

## 4. Componentes a construir

| Componente | Tipo | Responsabilidad |
|---|---|---|
| `lib/tangoClient.js` | módulo | Auth, paginado automático, reintentos y timeout contra Tango. Único lugar que conoce la URL del ERP. |
| `lib/hubspotClient.js` | módulo | Auth con private app token, batch upsert, respeto de rate limits. |
| `lib/mapper.js` | módulo | Aplica `config/mapeo.*.json`: renombra campos, castea tipos, corre transforms. |
| `lib/logger.js` | módulo | Formato de log unificado (el estilo con `[REQ-xxx]` que ya usás). |
| `functions/syncProductos.js` | Timer | Fase 1. Tango `process=87` → HubSpot Products. |
| `functions/syncClientes.js` | Timer | Fase 2. Tango `process=2117` → HubSpot Companies. |
| `functions/dealToTango.js` | HTTP | Fase 4. Recibe el Deal desde HubSpot y crea el comprobante en Tango. |
| `functions/testTangoConnection.js` | HTTP | Ya existe. Queda como diagnóstico, con auth restringida (D2). |

**Criterio:** ninguna función habla directo con `fetch`. Todo pasa por `lib/`, así el mapeo y los reintentos se testean y se cambian en un solo lugar.

---

## 5. Sistemas y endpoints

### 5.1 Tango ERP

| Ítem | Valor |
|---|---|
| Base URL | `http://138.99.6.77:17000` ⚠️ HTTP plano + IP fija, ver §10 |
| Endpoint lectura | `GET /Api/Get?process={id}&pages={n}&pageSize={n}` |
| Endpoint escritura | `POST /Api/Create` |
| Header auth | `ApiAuthorization: {TANGO_API_KEY}` |
| Header empresa | `company: {TANGO_COMPANY}` (hoy default `1`) |
| Formato respuesta | `{ resultData: { list[], pageIndex, pageSize, totalCount, totalPages, hasPreviousPage, hasNextPage } }` |

**Procesos relevados:**

| `process` | Tabla | Contenido | Uso | Registros |
|---|---|---|---|---|
| `2117` | `GVA14` | Clientes | Lectura **y alta** | 5.668 (116 campos, 61 con datos ≥20%) |
| `87` | `STA11` | Artículos | Lectura **y alta** | 825 (141 campos, 82 con datos ≥20%) |
| `19845` | `GVA21` ⚠️ | Pedidos | **Alta** | — |

El `process` va como query param y el payload en el body — el puente de Azure lo reenvía tal cual:

```
POST https://{function-app}/api/testTangoConnection?process=2117
  → POST http://138.99.6.77:17000/Api/Create?process=2117
```

🟡 **PENDIENTE — completar procesos faltantes:**

| Necesidad | `process` | Notas |
|---|---|---|
| Listas de precios | `____` | **Bloqueante para Fase 1**: `process=87` NO trae precio. |
| Stock por depósito | `____` | `STA11.STOCK` es un booleano "lleva stock", no la existencia real. |
| Tablas auxiliares (`GVA01`, `GVA05`, `GVA10`, `GVA18`, `GVA23`, `GVA24`, `GVA41`, `STA22`) | `____` | Ver §5.4: hacen falta para resolver los IDs internos. |

🟡 **PENDIENTE — filtros del ERP:** ¿`Api/Get` acepta filtro por fecha de modificación o por código? De eso depende si el sync puede ser incremental o tiene que ser full (§8.2).

### 5.3 ⚠️ Regla crítica: lectura por código, escritura por ID interno

Los payloads de alta relevados (`docs/payloads/`) **no usan códigos, usan los IDs internos numéricos de Tango**:

| Lectura devuelve | Escritura exige |
|---|---|
| `COD_GVA14` = `"000003"` | `ID_GVA14` = `2590` |
| `COD_STA11` = `"APY"` | `ID_STA11` = `394` |
| `GVA10_NRO_DE_LIS` | `ID_GVA10` |

**Consecuencia de arquitectura:** el sync de clientes y de productos **debe persistir el ID interno** en HubSpot (`tango_id_gva14`, `tango_id_sta11`), aunque no le sirva a comercial. Sin eso, la Fase 4 no puede armar el pedido y habría que resolver un lookup contra Tango en cada creación.

Estos IDs ya vienen en las respuestas de lectura (`ID_GVA14` e `ID_STA11` están al 100% en ambos dumps), así que no requiere llamadas extra.

### 5.4 ⚠️ RIESGO ABIERTO: ¿el código de las tablas auxiliares es el ID interno?

Para las entidades principales el ID viene explícito (`ID_GVA14`, `ID_STA11`). **Para las tablas auxiliares no.**

Los payloads de alta piden `ID_GVA01`, `ID_GVA05`, `ID_GVA10`, `ID_GVA18`, `ID_GVA23`, `ID_GVA24`, `ID_CATEGORIA_IVA`, `ID_TIPO_DOCUMENTO_GV`, `ID_STA22`, `ID_MEDIDA_*`, `ID_GVA41_*`.
Pero la lectura de clientes devuelve **códigos**: `GVA01_COND_VTA`, `GVA05_CODIGO`, `GVA10_NRO_DE_LIS`, `GVA23_CODIGO`, `GVA24_CODIGO`, `COD_CATEGORIA_IVA`…

**No está confirmado que código == ID interno.** Si no coinciden, hace falta resolver la equivalencia leyendo cada tabla auxiliar (de ahí el pedido de procesos en §5.1) y cachearla.

**Cómo verificarlo rápido:** leer el cliente `ID_GVA14 = 2590` (el del payload de pedido de ejemplo) y comparar su `GVA10_NRO_DE_LIS` contra el `ID_GVA10 = 3` del pedido. Si coinciden, código == ID y nos ahorramos las tablas auxiliares. **Es la primera prueba a correr.**

### 5.5 Campos de parametría en el alta

Los tres payloads de alta muestran un patrón: además de los datos del negocio, Tango exige un bloque de parametría que HubSpot no conoce ni debería conocer (`SOBRE_IVA`, `TYP_FEX`, `COBRA_LUNES`…`COBRA_DOMINGO`, `IDIOMA_CTE`, `PRODUCTO_TERMINADO_COT`, etc.).

**Decisión:** esos valores viven en **`config/defaults.tango.json`**, y el payload se arma como:

```js
payload = { ...defaults[entidad], ...camposMapeadosDesdeHubSpot }
```

Así el mapeo (`config/mapeo.*.json`) queda limpio: sólo lo que realmente viaja entre los dos sistemas.

⚠️ Los valores actuales de `defaults.tango.json` salieron de los ejemplos de Postman. **Antes de producción los tiene que validar administración**, sobre todo talonario, depósito, alícuotas de IVA y clasificaciones SIAP.

### 5.6 ⚠️ Tango sólo es accesible desde Azure

El ERP está **restringido por IP: sólo acepta tráfico desde la Function App**. No se puede pegarle a Tango desde una máquina de desarrollo, ni desde Postman apuntando directo a `138.99.6.77:17000`.

Toda consulta al ERP pasa por la app desplegada:

```
https://ultraschall-tango-hubspot-cjcpbug0g4fxgehg.canadacentral-01.azurewebsites.net/api/testTangoConnection?process=2117
```

**Consecuencias:**

1. **No hay ciclo de desarrollo local contra Tango.** Probar implica commit → push a `main` → GitHub Actions → deploy. Conviene agrupar cambios en vez de un deploy por prueba.
2. **La lógica pura tiene que ser testeable sin red.** Mapeo, armado de payloads y hashing van en `lib/` como funciones puras, con la capa de I/O aislada. Es la única forma de iterar rápido.
3. **Esto es lo que hoy justifica dejar D2 abierta**: `testTangoConnection` en `anonymous` es la única vía de relevamiento. Cerrarlo antes de terminar el relevamiento obliga a manejar la function key en cada consulta.
4. Como beneficio lateral, el ERP no está expuesto a internet en general — la superficie de ataque es la Function App, no Tango. Eso **no** compensa D2: el proxy anónimo reabre el agujero, con el agravante de que ya viene autenticado contra el ERP.

Si hace falta verificar algo en la interfaz de Tango (parametría, talonarios, depósitos), Matías tiene **acceso remoto** al ERP.

### 5.2 HubSpot

| Ítem | Valor |
|---|---|
| Portal / Hub ID | 🟡 `____` |
| Tipo de auth | 🟡 Private App token / OAuth app — `____` |
| API base | `https://api.hubapi.com` |
| Endpoints batch | `POST /crm/v3/objects/{objectType}/batch/upsert` (100 registros por request) |
| Scopes requeridos | `crm.objects.companies.write`, `crm.objects.companies.read`, `crm.objects.products.write`, `crm.objects.products.read`, `crm.schemas.companies.write`, `crm.objects.deals.read` |

🟡 **PENDIENTE:** ¿la integración corre con Private App del portal de Ultraschall, o va dentro del proyecto `IdPartners/` como app pública? Cambia el modelo de auth y dónde viven los secretos.

---

## 6. Convenciones

- **Prefijo de propiedades custom:** `tango_` (ej. `tango_cod_cliente`). Evita colisiones y hace obvio el origen del dato.
- **Grupo de propiedades en HubSpot:** `tango_erp` ("Datos Tango ERP"), para que el equipo comercial las vea agrupadas.
- **Nunca pisar campos editados a mano en HubSpot** salvo los que el mapeo marque como `autoritativoTango: true`.
- **Idioma:** propiedades y labels en español; código y nombres de archivo en inglés.

---

## 7. Modelo de datos y correspondencias

### 7.1 Artículos → Products (Fase 1)

- **Clave de idempotencia:** `COD_STA11` → `hs_sku`.
- Mapeo detallado: **`config/mapeo.productos.json`**.
- ⛔ **Bloqueante:** HubSpot Products necesita `price`, y `process=87` no lo trae. Sin el proceso de listas de precios, los productos entran con precio 0 o sin precio.

### 7.2 Clientes → Companies (Fase 2)

- **Clave de idempotencia:** `COD_GVA14` → propiedad custom `tango_cod_cliente`, marcada como *unique*.
  `CUIT` queda como segunda clave (única pero no primaria: puede haber sucursales con mismo CUIT).
- Mapeo detallado: **`config/mapeo.clientes.json`**.

### 7.3 ¿Contacts? (Fase 3)

Dato duro del relevamiento: **`E_MAIL` está cargado en apenas el 25% de los clientes** y `TELEFONO_1` en el 64%.

`GVA14` es una tabla de *cuentas*, no de personas: un registro = una empresa, con un mail genérico (`consultas@...`). No hay nombre y apellido de contacto.

**Recomendación:** no generar Contacts desde `GVA14`. Los contactos los carga/capta comercial en HubSpot y se asocian a la Company sincronizada. 🟡 Confirmar.

### 7.4 Vendedor → Owner

`GVA05_CODIGO` / `GVA05_DESCRIPCION` ⚠️ (asumo que es la tabla de vendedores de Tango) está al 100%. Si se arma una tabla de equivalencia vendedor Tango ↔ usuario HubSpot, se puede setear `hubspot_owner_id` automáticamente y las companies quedan asignadas solas.

🟡 **PENDIENTE:** ¿existe esa correspondencia? ¿la armamos a mano en un JSON de configuración?

---

## 8. Estrategia de sincronización

### 8.1 Frecuencia

🟡 **PENDIENTE — definir:**

| Entidad | Frecuencia propuesta | Justificación |
|---|---|---|
| Productos | 1× por día (madrugada) | Catálogo estable, 825 registros. |
| Clientes | 1× por día (madrugada) | Alta de clientes no es urgente en el CRM. |
| Precios | según §5.1 | Depende de cuánto cambian. |

### 8.2 Full vs. incremental

Ninguno de los dos payloads relevados trae **fecha de última modificación** (hay `FECHA_ALTA`, no `FECHA_MODIF`). Consecuencias:

- Si Tango **no** permite filtrar por modificación → sync **full** todas las corridas: 12 páginas de clientes + 2 de productos. Es viable con batch upsert, pero consume cuota de API de HubSpot.
- Optimización: calcular un **hash por registro** y guardarlo en `tango_sync_hash`; sólo se manda a HubSpot lo que cambió. Reduce muchísimo la escritura sin depender del ERP.

**Propuesta:** full read desde Tango + escritura diferencial por hash a HubSpot.

### 8.3 Paginado y límites de ejecución

- Tango: `pageSize=500` (validado), recorrer con `hasNextPage`.
- HubSpot: batch de **100** registros por request.
- ⚠️ **Riesgo:** en plan Consumption, una Function HTTP corta a los 5 min (configurable hasta 10). 5.668 clientes + latencias de ~6 s por página de Tango puede acercarse al límite.
  **Mitigación propuesta:** timer trigger (sin límite de request) + procesamiento por chunks, o pasar a Durable Functions si el volumen crece.

### 8.4 Errores y observabilidad

- Reintento con backoff exponencial (3 intentos) ante 429 y 5xx, de ambos lados.
- Un registro que falla **no corta la corrida**: se acumula y se reporta al final.
- Cada corrida loguea: registros leídos, creados, actualizados, sin cambios, fallidos, y duración.
- 🟡 **PENDIENTE:** ¿dónde se notifica una corrida fallida? (mail, Teams, Slack, o sólo Application Insights)

---

## 9. Fase 4 — Deal ganado → Pedido en Tango

Se crea un **pedido** (no una factura), vía `POST /Api/Create` con `process=19845`.
Payload de referencia validado: **`docs/payloads/pedido-create.json`**.

### 9.1 Flujo

1. Workflow de HubSpot: Deal pasa a `closedwon` → webhook a `dealToTango`.
2. La función lee el Deal + line items + Company asociada.
3. Arma el payload resolviendo los IDs internos desde las propiedades sincronizadas (§5.3).
4. `POST /Api/Create` y guarda el número de pedido devuelto en `tango_nro_pedido` del Deal.

### 9.2 De dónde sale cada campo del pedido

**Cabecera:**

| Campo Tango | Origen | Notas |
|---|---|---|
| `ID_GVA14` | Company → `tango_id_gva14` | Cliente. Si está vacío ⇒ error de negocio (§9.3). |
| `ID_GVA01` | Company → `tango_id_gva01` | Condición de venta del cliente (`GVA01_COND_VTA`, 100% cargado). |
| `ID_GVA10` | Company → `tango_id_gva10` | Lista de precios. ⚠️ sólo 30% de los clientes la tiene ⇒ necesita **default**. |
| `ID_GVA23` | Company → `tango_id_gva23` | ⚠️ confirmar qué es (31% cargado). |
| `ID_GVA24` | Company → `tango_id_gva24` | ⚠️ confirmar qué es (30% cargado). |
| `ID_MONEDA` | fijo `1` | 🟡 confirmar si siempre ARS. |
| `ID_GVA43_TALON_PED` | config | Talonario de pedidos. 🟡 confirmar cuál usa Ultraschall. |
| `ID_STA22` | config | Depósito. 🟡 confirmar cuál. |
| `FECHA_PEDIDO` | fecha de cierre del Deal | |
| `FECHA_ENTREGA` | 🟡 propiedad del Deal a definir | |
| `NRO_ORDEN_COMPRA` | 🟡 propiedad del Deal a definir | |
| `LEYENDA_1..5` | trazabilidad | Propuesta: dejar el ID del Deal de HubSpot en una leyenda para auditoría. |
| `VALIDA_STOCK` | config | ⚠️ el ejemplo va en `false`; definir si producción debe validar. |
| `PORCENTAJE_DESCUENTO_GENERAL` | Deal | |
| `APLICA_DESCUENTO_CLIENTE` / `CALCULA_PROMOCIONES` | config | Definir política. |

**Renglones (`RENGLON_DTO[]`), uno por line item del Deal:**

| Campo Tango | Origen |
|---|---|
| `ID_STA11` | Line item → Product → `tango_id_sta11` |
| `CANTIDAD_PEDIDA` | `quantity` |
| `PRECIO` | `price` |
| `PORCENTAJE_BONIFICACION` | `discount` |
| `ID_STA22` | depósito (mismo default de cabecera) |

### 9.3 Casos de error a resolver

🟡 **PENDIENTE — definir comportamiento:**
- Company sin `tango_id_gva14` (cliente que no existe en el ERP): ¿se rechaza, se avisa, o se da de alta el cliente en Tango?
- Line item cuyo producto no tiene `tango_id_sta11`.
- Cliente sin lista de precios asignada.
- Reintento de un Deal ya enviado: **¿cómo se evita el pedido duplicado?** Propuesta: no enviar si `tango_nro_pedido` ya tiene valor.

---

## 10. Seguridad

| Tema | Situación | Acción |
|---|---|---|
| Transporte a Tango | `http://` plano contra IP pública, con la API key viajando en header | 🟡 Evaluar HTTPS o VPN/IP allowlist. Hoy la credencial del ERP viaja en claro. |
| Auth del proxy | `anonymous` (D2) | Pasar a `function` key o restringir por IP. |
| Secretos | `local.settings.json` local + Application Settings en Azure | Verificar que `local.settings.json` esté en `.gitignore` (✅ está) y que nunca se commitee. |
| Logs | El proxy loguea la API key enmascarada (✅ correcto) y hasta 300 bytes del body | Revisar que no se loguee CUIT/datos personales en producción. |

---

## 11. Entornos y despliegue

| Entorno | Function App | Portal HubSpot | Empresa Tango |
|---|---|---|---|
| Producción | `ultraschall-tango-hubspot` | 🟡 `____` | `company=1` |
| Desarrollo | 🟡 ¿existe? | 🟡 ¿sandbox? | 🟡 ¿empresa de prueba? |

Deploy: push a `main` → GitHub Actions → Azure.

🟡 **PENDIENTE:** ¿hay portal sandbox de HubSpot y/o empresa de prueba en Tango para no escribir sobre producción durante el desarrollo?

### Variables de entorno

| Variable | Descripción |
|---|---|
| `TANGO_API_URL` | Base URL del ERP |
| `TANGO_API_KEY` | Valor del header `ApiAuthorization` (corregir D1) |
| `TANGO_COMPANY` | Código de empresa, default `1` |
| `HUBSPOT_TOKEN` | Private app token 🟡 a crear |
| `SYNC_DRY_RUN` | `true` = calcula y loguea pero no escribe en HubSpot |

---

## 12. Lo que necesito de tu lado

Para cerrar el diseño y empezar a codear, en orden de importancia:

| # | Qué | Bloquea |
|---|---|---|
| 1 | **Verificar código vs. ID interno** en tablas auxiliares (§5.4) — es una sola consulta | Fase 4 y alta de clientes |
| 2 | **`process` de listas de precios** | Fase 1 (Products sin `price` no sirven) |
| 3 | **Credenciales/portal de HubSpot**: Hub ID + Private App token | Todas las fases de escritura |
| 4 | **Revisar los mapeos propuestos** en `config/mapeo.*.json` | Fases 1 y 2 |
| 5 | **Validar `config/defaults.tango.json`** con administración (talonario, depósito, alícuotas, SIAP) | Toda escritura a Tango |
| 6 | `process` de stock, frecuencia de sync, ambiente de pruebas | Optimizaciones |
| 7 | Confirmar que Contacts queda fuera de alcance (§7.3) | Fase 3 |
| 8 | Doc de comunicación con la API de Tango (lo pasa Matías) | — |

### Archivos de referencia

| Archivo | Contenido |
|---|---|
| `docs/ARQUITECTURA.md` | Este documento. Diseño y decisiones. |
| `docs/payloads/cliente-create.json` | Payload de alta de cliente (`process=2117`). |
| `docs/payloads/producto-create.json` | Payload de alta de artículo (`process=87`). |
| `docs/payloads/pedido-create.json` | Payload de alta de pedido (`process=19845`). |
| `config/mapeo.clientes.json` | Mapeo campo a campo GVA14 ↔ Companies. |
| `config/mapeo.productos.json` | Mapeo campo a campo STA11 ↔ Products. |
| `config/defaults.tango.json` | Parametría fija para el alta en Tango (§5.5). |
