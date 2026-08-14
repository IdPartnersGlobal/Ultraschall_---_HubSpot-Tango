# Ultraschall — Integración Tango ERP ↔ HubSpot

Azure Functions (Node.js, modelo de programación v4) que sincroniza **Tango Gestión** (ERP, hosteado en Claro Cloud) con **HubSpot** (CRM).

> **El diseño y las decisiones viven en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).** Este README es solo cómo levantar y desplegar el proyecto.

---

## Estado

| Fase | Flujo | Estado |
|---|---|---|
| 0 | Conectividad y proxy a Tango | ✅ Hecho |
| 1 | Artículos → HubSpot Products | 🔨 A construir |
| 2 | Clientes → HubSpot Companies | 🔨 A construir |
| 3 | Contactos | 🟡 Fuera de alcance (a confirmar) |
| 4 | Deal ganado → Pedido en Tango | 🔨 A construir |

---

## Requisitos

- **Node.js 22.x** (misma versión que usa el workflow de deploy).
- **Azure Functions Core Tools v4** — `npm i -g azure-functions-core-tools@4 --unsafe-perm true`.
- **Azurite** o una cuenta de storage, para `AzureWebJobsStorage` en local.

---

## Setup local

> ⚠️ **Tango no es accesible desde tu máquina.** El ERP está restringido por IP y sólo acepta tráfico
> desde la Function App de Azure. En local podés levantar el runtime y testear lógica pura (mapeos,
> armado de payloads), pero **cualquier llamada real a Tango hay que hacerla contra la app desplegada**:
>
> ```
> https://ultraschall-tango-hubspot-cjcpbug0g4fxgehg.canadacentral-01.azurewebsites.net/api/testTangoConnection?process=2117
> ```
>
> Es decir: probar contra Tango implica commit → push a `main` → esperar el deploy. Conviene agrupar
> cambios en vez de hacer un deploy por prueba.

```bash
npm install
```

Completá `local.settings.json` con las credenciales reales (el archivo está en `.gitignore`, **nunca se commitea**):

```jsonc
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",

    "TANGO_API_URL": "http://138.99.6.77:17000",
    "TANGO_API_KEY": "...",
    "TANGO_COMPANY": "1",

    "HUBSPOT_TOKEN": "...",
    "SYNC_DRY_RUN": "true"
  }
}
```

Levantar:

```bash
npm start          # = func start
```

### Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `TANGO_API_URL` | ✅ | Base URL del ERP. Sin barra final. |
| `TANGO_API_KEY` | ✅ | Valor del header `ApiAuthorization`. |
| `TANGO_COMPANY` | — | Código de empresa. Default `1`. |
| `HUBSPOT_TOKEN` | ✅ (fases 1-4) | Private App token del portal de Ultraschall. |
| `SYNC_DRY_RUN` | — | `true` = calcula y loguea, pero **no escribe** en HubSpot. |

En Azure estas mismas variables van en **Application Settings** de la Function App.

---

## Funciones

### `testTangoConnection` — diagnóstico

Proxy pass-through contra Tango. Sirve para relevar datos y verificar conectividad; **no es la función de producción**.

- `GET` → por defecto pega a `Api/Get`
- `POST` → por defecto pega a `Api/Create`
- `?tangoPath=...` fuerza la ruta (se elimina antes de reenviar)
- El resto de los query params se reenvían tal cual

> ⚠️ **Hoy está en `authLevel: 'anonymous'`** mientras dura el relevamiento. Es deuda técnica conocida (D2): la URL es pública y el `POST` escribe en el ERP de producción. Antes de producción pasa a `'function'`.

```bash
curl "$FUNC_URL/api/testTangoConnection?process=87&pages=1&pageSize=10"
```

Respuesta:

```json
{
  "status": "success",
  "proxyTarget": "http://.../Api/Get?process=87&pages=1&pageSize=10",
  "method": "GET",
  "latencyMs": 0,
  "totalFunctionTimeMs": 0,
  "result": { "resultData": { "list": [] } }
}
```

**Procesos de Tango relevados:**

| `process` | Tabla | Contenido |
|---|---|---|
| `2117` | `GVA14` | Clientes |
| `87` | `STA11` | Artículos |
| `19845` | `GVA21` | Pedidos (alta) |

---

## Estructura

```
HubSpot-Tango/
├─ src/
│  ├─ index.js                   → app.setup({ enableHttpStream: true })
│  └─ functions/
│     └─ testTangoConnection.js  → proxy de diagnóstico
├─ config/
│  ├─ mapeo.clientes.json        → GVA14 ↔ Companies
│  ├─ mapeo.productos.json       → STA11 ↔ Products
│  └─ defaults.tango.json        → parametría fija para el alta en Tango
├─ docs/
│  ├─ ARQUITECTURA.md            → fuente de verdad del diseño
│  └─ payloads/                  → payloads de alta relevados
├─ host.json
├─ local.settings.json           → secretos locales (NO commitear)
└─ .github/workflows/            → deploy a Azure
```

---

## Deploy

Push a `main` → **GitHub Actions** → Azure Function App `ultraschall-tango-hubspot`.

El workflow (`.github/workflows/main_ultraschall-tango-hubspot.yml`) hace `npm install`, empaqueta y publica vía OIDC. No hace falta ningún paso manual.

> ⚠️ Después de desplegar, verificá que las Application Settings de Azure tengan `TANGO_API_KEY` (no `TANGO_API_TOKEN`) y `TANGO_COMPANY`.

---

## Seguridad

- La API key de Tango viaja en header sobre **HTTP plano** contra una IP pública. Pendiente evaluar HTTPS o VPN/IP allowlist — ver `docs/ARQUITECTURA.md` §10.
- `local.settings.json` está en `.gitignore`. Verificalo antes de cada commit.
- Los logs enmascaran la API key y truncan el body a 300 bytes.
