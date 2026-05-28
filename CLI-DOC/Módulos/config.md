---
date: 2026-05-28
tags: [módulo, config, zod, stratum-cli]
status: implementado
hito: 0
---

# Módulo config — Configuración

Implementado en Hito 0. Ver [[Arquitectura]] y [[Roadmap]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/config/schema.ts` | Schema Zod del `.stratumrc.json` |
| `src/config/loader.ts` | `loadConfig()` — carga, valida y expande variables |

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
  "agent": {
    "maxIterations": 20
  },
  "tools": {
    "bashTimeout": 30000
  }
}
```

Los campos no definidos reciben sus valores por defecto del schema Zod (`StratumConfigSchema.parse({})`).

---

## Variables de entorno

Las cadenas en la config que sigan el patrón `${VAR_NAME}` son expandidas automáticamente por `loadConfig()` antes de la validación Zod. Útil para claves de API:

```json
{ "apiKey": "${OPENAI_API_KEY}" }
```

---

## Acceso desde código

```typescript
import { loadConfig } from './config/loader.js'
const config = await loadConfig()   // busca .stratumrc.json desde cwd hacia arriba

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
