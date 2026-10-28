---
date: 2026-08-27
tags: [módulo, config, zod, ssh, stratum-cli]
status: implementado
hito: 0-9
---

# Módulo config — Configuración

Implementado en Hito 0, ampliado en Hito 2. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/config/schema.ts` | Schema Zod del `.stratumrc.json` |
| `src/config/loader.ts` | `loadConfig()` — carga, valida y expande `${VAR}` |
| `src/config/paths.ts` | `expandHome()`, `resolveMemoryPaths()` — expande `~` |

---

## Estructura de `.stratumrc.json`

```json
{
  "provider": {
    "default": "local-ollama",
    "providers": {
      "local-ollama": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "model": "qwen3.5:9b",
        "apiKey": "ollama",
        "contextWindow": 32768
      }
    }
  },
  "memory": {
    "projectFile": "./STRATUM.md",
    "globalFile": "~/.stratum/STRATUM.md",
    "decisionsFile": "~/.stratum/memory/decisions.json",
    "vectorDb": "~/.stratum/memory/vectors.db",
    "embeddingModel": "Xenova/all-MiniLM-L6-v2",
    "retrievalTopK": 5
  },
  "agent": {
    "maxIterations": 50,
    "maxToolRetries": 3,
    "compressionKeepRounds": 6,
    "compressionThreshold": 0.8,
    "compressorModel": "qwen3.5:9b"
  },
  "tools": {
    "confirmDestructive": true,
    "bashTimeout": 30000
  },
  "agents": {
    "defaultProfile": "general",
    "maxConcurrency": 1
  },
  "ssh": {
    "auditLog": true,
    "hosts": {
      "prod-web": {
        "host": "192.168.1.10",
        "port": 22,
        "user": "javi",
        "privateKey": "~/.ssh/id_ed25519",
        "jumpHost": "bastion",
        "confirmAll": true
      }
    }
  }
}
```

Los campos no definidos reciben sus valores por defecto del schema Zod (`StratumConfigSchema.parse({})`).

---

## `pricing` — coste en USD (UX-3)

Opcional, por provider y/o por modelo. Tarifas en **USD por millón de tokens**,
todas ≥ 0:

```json
{
  "provider": {
    "default": "gateway",
    "providers": {
      "gateway": {
        "type": "openai-compatible",
        "baseUrl": "http://localhost:4000/v1",
        "model": "claude-sonnet-4-5",
        "apiKey": "${LITELLM_API_KEY}",
        "pricing": { "input": 3, "output": 15, "cachedInput": 0.3, "cacheWrite": 3.75 },
        "models": {
          "claude-haiku-4-5": { "pricing": { "input": 0.8, "output": 4 } }
        }
      }
    }
  }
}
```

- `input` y `output` son obligatorios si la sección existe; `cachedInput` y
  `cacheWrite` son opcionales (sin ellas, la caché se cobra a `input`).
- `models.<id>.pricing` gana al precio del provider (`ProviderRouter.pricing`).
- **Sin `pricing` no hay coste**: `TurnUsage.costUsd` queda `undefined`. Stratum
  no trae tarifas por defecto ni estima importes; un tramo con tokens y sin
  precio deja el total de la sesión sin definir.
- La sección es estricta (`.strict()`): una clave desconocida es un error de
  config, no una tarifa ignorada.

---

## Variables de entorno (`${VAR}`)

Las cadenas que sigan el patrón `${VAR_NAME}` son expandidas por `loadConfig()` antes de la validación Zod:

```json
{ "apiKey": "${OPENAI_API_KEY}" }
```

---

## Expansión de `~` (`paths.ts`)

El loader no expande `~`. Las rutas de memoria y sesiones usan `expandHome()`:

```typescript
expandHome('~/.stratum/sessions')
// → '/home/user/.stratum/sessions' (Linux/macOS)
// → 'C:\Users\user\.stratum\sessions' (Windows)

resolveMemoryPaths(config): MemoryPaths
// → { projectFile, globalFile, decisionsFile, vectorDb, sessionsDir }
//   todas con rutas absolutas
```

---

## Campos del agente añadidos en Hito 2

| Campo | Default | Descripción |
|-------|---------|-------------|
| `agent.compressionThreshold` | `0.8` | Umbral (0–1) para activar compresión de contexto |
| `agent.compressorModel` | _(activo)_ | Modelo alternativo para el LLM call de compresión; si no se define, usa el provider activo |
| `agent.compressionReusePrefix` | `false` | El resumen manda el historial tal cual (mismas tools, `tool_choice: 'none'`) para reutilizar la caché de prefijo del backend, solo cuando deja menos fuera de caché que el digest. Ver `stratum-cli/docs/prompt-caching.md` |

---

## Inventario SSH (Hito 9, §12.14)

`ssh` es la única sección **opcional sin default**: si no existe, las tools SSH no se registran en el
`ToolRegistry` y el modelo no las ve. `auditLog` acepta `true` (→ `~/.stratum/logs/ssh-audit.jsonl`),
una ruta, o `false`.

| Campo de host | Default | Descripción |
|---------------|---------|-------------|
| `host`, `port`, `user` | — / `22` / — | Destino y usuario |
| `privateKey`, `passphrase` | — | Clave privada; `~` se expande. `passphrase` acepta `env:<VAR>` |
| `useAgent` | `false` | Autenticar contra el ssh-agent del sistema (no es agent forwarding) |
| `password` | — | Acepta `env:<VAR>` o valor literal |
| `jumpHost` | — | Alias de otro host como bastión |
| `hostKeyPolicy` | `tofu` | `tofu` / `strict` / `insecure` |
| `hostKeyHash` | — | Fingerprint pinneado; **obligatorio** con `strict` |
| `confirmAll` | `false` | Confirmación en TODOS los comandos del host |
| `connectTimeout` | `10000` | ms para establecer la conexión |
| `commandTimeout` | `30000` | ms por defecto por comando (override por tool call) |
| `maxBytes` | `262144` | Tope de stdout+stderr (override por tool call) |

### Validación temprana (`superRefine`)

El schema rechaza en carga lo que el pool no podría arreglar en runtime:

- un host sin **ningún** método de autenticación (`privateKey` / `useAgent` / `password`)
- `hostKeyPolicy: "strict"` sin `hostKeyHash`
- un `jumpHost` que no existe en `ssh.hosts`, un **ciclo**, o una cadena de más de 2 saltos

Fallar aquí y no al conectar evita que un ciclo de `jumpHost` cuelgue el pool.

### Resolución de secretos

```
"env:<VAR>"   → process.env[VAR]
"<literal>"   → el valor tal cual (no recomendado: queda en disco)
```

En ambos casos, si no se resuelve se prueba `STRATUM_SSH_<ALIAS>_SECRET`.
**`keychain:` no está implementado** — devuelve un error que apunta a `env:`.

---

## Diagnósticos LSP (UX-2b)

Sección `lsp`, **opt-in**: con `enabled: false` (el default) no se arranca ningún language server y `edit_file`/`write_file` se comportan como siempre.

```jsonc
"lsp": {
  "enabled": true,
  "timeoutMs": 3000,           // espera máxima de diagnósticos por edición
  "startupTimeoutMs": 15000,   // initialize del servidor
  "maxDiagnostics": 20,        // cuántos se anexan al resultado de la tool
  "severity": "error",         // "error" | "warning": umbral mínimo
  "servers": {
    "typescript": {},          // preset: basta el nombre
    "pyright": {},
    "mio": { "command": "foo-ls", "args": ["--stdio"], "extensions": [".foo"], "env": {} }
  }
}
```

Presets embebidos (`src/lsp/presets.ts`):

| Preset | Comando | Extensiones |
|---|---|---|
| `typescript` | `typescript-language-server --stdio` | `.ts .tsx .js .jsx .mjs .cjs .mts .cts` |
| `pyright` | `pyright-langserver --stdio` | `.py` |
| `rust-analyzer` | `rust-analyzer` | `.rs` |

Un servidor declarado con más campos sobreescribe el preset del mismo nombre **campo a campo** (cambiar solo `args` conserva comando y extensiones). Un nombre que no es preset exige `command` y `extensions` (con punto); el schema lo valida al cargar.

Los servidores se arrancan **perezosamente** al primer fichero que los necesite, uno por extensión en el orden de la config. Un fallo de arranque o una caída desactivan ese servidor para el resto de la sesión con un `warning` en el log (`ns: lsp`); nunca lanzan ni convierten una edición correcta en un error. `stratum` cierra los servidores con `shutdown`/`exit` (y los mata si no salen en 2 s) en el teardown de `chat`, `run`, `init` y del host de sesión.

---

## Acceso desde código

```typescript
import { loadConfig } from './config/loader.js'
const config = loadConfig()  // busca .stratumrc.json desde cwd hacia arriba

import { resolveMemoryPaths } from './config/paths.js'
const paths = resolveMemoryPaths(config)
// paths.sessionsDir → '~/.stratum/sessions' expandido

// En tests:
import { StratumConfigSchema } from './config/schema.js'
const config = StratumConfigSchema.parse({})  // valores por defecto
```

---

## Comando `stratum config`

```
stratum config get provider.default
stratum config set agent.maxIterations 30
```

Lee y escribe con dot-path sobre `.stratumrc.json` del directorio actual.

---

## Tests

`src/config/loader.test.ts` (13 tests):
- Carga desde archivo válido
- Valores por defecto cuando el archivo no existe
- Expansión de variables de entorno `${VAR}`
- Validación de campos inválidos (error Zod)
- Búsqueda hacia arriba en el árbol de directorios
