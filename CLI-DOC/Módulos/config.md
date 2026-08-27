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
