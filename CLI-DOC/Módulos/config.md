---
date: 2026-05-29
tags: [módulo, config, zod, stratum-cli]
status: implementado
hito: 0-2
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
