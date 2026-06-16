---
date: 2026-06-16
tags: [módulo, memoria, decisiones, embeddings, stratum-cli]
status: implementado
hito: 2-5
---

# Módulo memory — Sistema de Memoria

Las 3 capas están activas: Capa 1 (Hito 2), Capas 2 y 3 (Hito 5). Ver [[Arquitectura]].

---

## Archivos

| Archivo | Responsabilidad |
|---------|----------------|
| `src/memory/project.ts` | `loadProjectMemory()` — STRATUM.md proyecto + global |
| `src/memory/manager.ts` | `MemoryManager` — orquesta las 3 capas |
| `src/memory/show.ts` | `renderMemoryShow()` — salida compartida CLI/chat |
| `src/memory/decisions.ts` | `DecisionStore` — CRUD JSON atómico (Capa 2) |
| `src/memory/embeddings.ts` | `EmbeddingService` — ONNX local + endpoint HTTP |
| `src/memory/vectors.ts` | `VectorStore` — sqlite-vec + fallback JS (Capa 3) |
| `src/memory/decision-memory.ts` | `DecisionMemory` — orquestador singleton |
| `src/memory/extractor.ts` | Extracción automática LLM-based en background |

---

## Arquitectura en 3 capas

```
MemoryManager
    ├── Capa 1 — STRATUM.md (activa, Hito 2)
    │       ├── ./STRATUM.md           ← memoria del proyecto (cwd)
    │       └── ~/.stratum/STRATUM.md  ← memoria global del usuario
    └── DecisionMemory (singleton por ruta, Hito 5)
            ├── Capa 2 — DecisionStore  → ~/.stratum/memory/decisions.json
            └── Capa 3 — VectorStore    → ~/.stratum/memory/vectors.db
                    └── EmbeddingService (ONNX local / HTTP)
```

**Invariante clave:** `decisions.json` es la fuente de verdad y **nunca se pierde** aunque el índice vectorial o el embedder fallen.

---

## Capa 1 — STRATUM.md (`project.ts`)

```typescript
function loadProjectMemory(config: StratumConfig): ProjectMemory
// { projectContent, globalContent, projectPath, globalPath }
```

- Nunca lanza error por ausencia de archivos — devuelve strings vacíos
- `projectFile` se resuelve desde `process.cwd()`; `globalFile` expande `~`
- `getInjectableMemory()` concatena global (primero) + proyecto (último, mayor prioridad) separados por `---`; el resultado va a `buildSystemPrompt(config, memory)`

---

## Capa 2 — DecisionStore (`decisions.ts`)

Decision store JSON estructurado, **fuente de verdad**.

- Escritura atómica
- id `dec_YYYYMMDD_<nanoid6>`
- `embedding_ref = vec_${id}` enlaza con la Capa 3
- Se escribe vía la tool `store_decision` (el agente, §12.7) y vía extracción automática LLM-based en background (`extractor.ts`)

---

## Capa 3 — VectorStore + EmbeddingService

### VectorStore (`vectors.ts`)

Índice semántico con dos backends:

- **`sqlite-vec`** — tabla `vec0` con `distance_metric=cosine`, import dinámico de `better-sqlite3` + `sqlite-vec`
- **Fallback brute-force JS** persistente (`*.fallback.json`) cuando las deps nativas faltan

### EmbeddingService (`embeddings.ts`)

- `@xenova/transformers` ONNX local (lazy, guard de symlinks en Windows)
- Endpoint HTTP `/v1/embeddings` opcional (fast-fail + latch)
- Warm-up opcional cableado en `chat` (`memory.embeddingWarmup`)

Deps opcionales (`@xenova/transformers`, `better-sqlite3`, `sqlite-vec`) declaradas en `optionalDependencies` y `external` en `tsup.config.ts`.

---

## DecisionMemory (`decision-memory.ts`)

Orquestador singleton por ruta:

- **Al guardar** → dedup semántico (no duplica decisiones casi idénticas)
- **Al recuperar** → KNN sobre el índice; alimenta la tool `recall_decisions`
- Mantiene el invariante: si el índice/embedder fallan, la decisión igualmente se persiste en `decisions.json`

---

## Tools del agente (§12.7)

| Tool | Rol |
|------|-----|
| `store_decision` | `serialized`. Guarda una decisión estructurada con dedup semántico |
| `recall_decisions` | KNN semántico; emite el evento `memory_retrieved` |

El system prompt incluye instrucción para usar ambas. El evento `memory_retrieved` se emite en `harness.ts` (vía `takeLastRecall`) y la UI lo muestra con un indicador discreto.

---

## MemoryManager (`manager.ts`)

```typescript
class MemoryManager {
  reload(): void                       // recarga STRATUM.md (tras /init)
  getProjectMemory(): ProjectMemory
  getInjectableMemory(): string        // bloque para system prompt
  hasMemory(): boolean
  // Capas 2 y 3 vía DecisionMemory (ya no son stubs)
}
```

---

## `stratum init` / `/init` — §12.13

Init opera como **comando-plantilla** (`INITIALIZE_PROMPT` en `agent/initialize-prompt.ts`), inyectado como mensaje de usuario del agente general — no hay agente especializado. Ver [[Módulos/agent]].

Estructura fija del STRATUM.md: `Proyecto`, `Stack Tecnológico`, `Estructura`, `Convenciones`, `Comandos Clave`. Las secciones extra del usuario se preservan siempre.

---

## Comandos de memoria

### CLI

| Comando | Descripción |
|---------|-------------|
| `stratum memory show` | STRATUM.md activo (proyecto + global) con rutas |
| `stratum memory list` | Lista decisiones almacenadas |
| `stratum memory search <query>` | Búsqueda semántica KNN |
| `stratum memory forget <id>` | Elimina una decisión |

### Chat (slash commands)

`/memory show`, `/memory list`, `/memory search <query>`, `/memory forget <id>` — autocompletado en `session-commands.ts`, handlers en `App.tsx`.

---

## Configuración (`memory.*`)

```
embeddingDimension, embeddingEndpoint, autoExtract,
extractionModel, similarityThreshold, embeddingWarmup
```

---

## Tests

- `src/memory/project.test.ts` — Capa 1 (strings vacíos sin archivo, carga+trim, ruta correcta)
- Capa 2/3 (Hito 5, 29 tests nuevos) — `DecisionStore` CRUD atómico, dedup semántico, KNN, fallback JS cuando faltan deps nativas, invariante de no-pérdida de `decisions.json`
