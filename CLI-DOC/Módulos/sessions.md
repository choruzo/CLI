---
date: 2026-05-29
tags: [módulo, sesiones, persistencia, stratum-cli]
status: implementado
hito: 2
---

# Módulo sessions — Persistencia de Sesiones

Implementado en Hito 2. Ver [[Roadmap#Hito 2]] y [[Arquitectura]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/session/types.ts` | `SessionContext` — schema de sesión guardada |
| `src/session/store.ts` | `SessionStore` — CRUD sobre `~/.stratum/sessions/` |

---

## SessionContext (`types.ts`) — §12.6

```typescript
interface SessionContext {
  id:            string   // "sess_20260529_143022_abc"
  createdAt:     string   // ISO 8601
  updatedAt:     string   // ISO 8601
  provider:      string   // nombre del provider (e.g. "local-ollama")
  model:         string
  project:       string   // cwd absoluto
  messages:      Message[]
  toolCallCount: number
  summary:       string   // resumen ≤ 100 chars (vacío si < 5 rondas)
}
```

**Invariante de seguridad:** `provider` guarda solo el nombre, **nunca** `apiKey` ni `baseUrl`. Los secretos de configuración no se persisten en ningún formato.

### Formato de IDs

```
sess_YYYYMMDD_HHMMSS_xxx
         │        │    └── 3 chars alfanuméricos aleatorios
         │        └── hora en formato local (HH:MM:SS)
         └── fecha (YYYYMMDD)
```

---

## SessionStore (`store.ts`)

```typescript
class SessionStore {
  constructor(sessionsDir: string)  // típicamente ~/.stratum/sessions

  async save(params: SaveSessionParams): Promise<SessionContext>
  load(id: string): SessionContext               // lanza si no existe
  list(opts?: { last?: number }): SessionContext[] // más recientes primero (por updatedAt)
  delete(id: string): void
  prune(olderThanMs: number): number             // devuelve nº eliminadas
}
```

### `save()` — ciclo de vida

```typescript
interface SaveSessionParams {
  provider:      string
  model:         string
  project:       string
  messages:      Message[]
  toolCallCount: number
  llmProvider?:  IProvider    // si se pasa y rondas ≥ 5, genera summary via LLM
  existingId?:   string       // para actualizar una sesión existente (--resume)
  createdAt?:    string       // preservar la fecha original (--resume)
}
```

Si la sesión tiene ≥ 5 rondas de usuario y se pasa `llmProvider`, hace un LLM call para generar el `summary` (máx 100 chars). El guardado nunca falla por un error en el resumen.

### `list()` — ordenación

Ordena por `updatedAt` ISO 8601 descendente (más recientes primero). No depende del nombre de archivo, evitando ambigüedades cuando varias sesiones se crean en el mismo segundo.

---

## Ciclo de vida en `stratum chat`

```
stratum chat
  → crea sessionStart = new Date().toISOString()

stratum chat --resume <id>
  → SessionStore.load(id) → { messages, id, createdAt }
  → new StratumAgent(config, router, registry, { initialMessages })

Al salir (Ctrl+C, /quit, exit):
  → waitUntilExit() resuelve
  → SessionStore.save({ existingId?, createdAt?, messages, ... })
  → escribe ~/.stratum/sessions/<id>.json
```

---

## Comandos de gestión

### `stratum sessions list [--last N]`

```
Sesiones guardadas (3):

  sess_20260529_143022_abc
    29/05/2026, 16:30  │  local-ollama / qwen3.5:9b  Refactoring del módulo de auth

  sess_20260529_091511_xyz
    29/05/2026, 11:15  │  local-ollama / qwen3.5:9b
```

### `stratum sessions resume <id>`

Equivalente a `stratum chat --resume <id>`.

### `stratum sessions delete <id>`

Elimina `~/.stratum/sessions/<id>.json`.

### `stratum sessions prune --older <duration>`

Elimina sesiones más antiguas que la duración indicada.

```bash
stratum sessions prune --older 30d   # más de 30 días
stratum sessions prune --older 7d    # más de 7 días
stratum sessions prune --older 2h    # más de 2 horas
```

Formatos soportados: `Nd`, `Nh`, `Nm`, `Ns`.

---

## `parseDuration(str)` (`store.ts`)

Convierte strings de duración a milisegundos:

| Input | Output (ms) |
|-------|------------|
| `30d` | 2_592_000_000 |
| `7d`  | 604_800_000 |
| `2h`  | 7_200_000 |
| `5m`  | 300_000 |
| `10s` | 10_000 |

---

## Tests

`src/session/store.test.ts` (12 tests):
- Save y load round-trip
- No persiste `apiKey` ni `baseUrl` en disco
- `list()` devuelve más recientes primero
- `list({ last: N })` limita resultados
- `delete()` elimina el archivo
- `prune()` elimina sesiones antiguas
- `load()` lanza si la sesión no existe
- `parseDuration()`: días, horas, minutos, segundos, formato inválido
