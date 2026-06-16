---
date: 2026-06-16
tags: [diario, hito-5, memoria, decisiones, embeddings, stratum-cli]
hito: 5
commit: 1ed9b63
---

# Diario — Hito 5: Memory Layers 2 y 3

## Resumen

Las tres capas de memoria están activas. El agente ahora recuerda decisiones técnicas entre sesiones y las recupera por similitud semántica. 29 tests nuevos.

---

## Qué se implementó

### Capa 2 — DecisionStore (`decisions.ts`)

Decision store JSON estructurado, **fuente de verdad**. Escritura atómica, id `dec_YYYYMMDD_<nanoid6>`, `embedding_ref = vec_${id}`. Se escribe vía la tool `store_decision` (el agente) y vía extracción automática LLM-based en background (`extractor.ts`).

### Capa 3 — VectorStore + EmbeddingService

- `VectorStore` (`vectors.ts`) — backend `sqlite-vec` (tabla `vec0`, `distance_metric=cosine`, import dinámico de `better-sqlite3` + `sqlite-vec`) con **fallback brute-force JS** persistente (`*.fallback.json`) cuando faltan las deps nativas
- `EmbeddingService` (`embeddings.ts`) — `@xenova/transformers` ONNX local (lazy, guard de symlinks en Windows) con endpoint HTTP `/v1/embeddings` opcional (fast-fail + latch)

### Orquestador DecisionMemory (`decision-memory.ts`)

Singleton por ruta. Dedup semántico al guardar, KNN al recuperar (tool `recall_decisions`). El evento `memory_retrieved` se emite en `harness.ts` (vía `takeLastRecall`) y la UI lo muestra con un indicador discreto.

### CLI y chat

`stratum memory list/search/forget` y `/memory list|search|forget` (autocompletado en `session-commands.ts`, handlers en `App.tsx`). Warm-up ONNX opcional cableado en `chat` (`memory.embeddingWarmup`).

---

## Decisión técnica clave

**Invariante de no-pérdida.** `decisions.json` es la fuente de verdad y nunca se pierde aunque el índice vectorial o el embedder fallen. El fallback brute-force JS garantiza búsqueda semántica incluso sin `sqlite-vec`/`better-sqlite3` instalados; estas deps van en `optionalDependencies` y como `external` en `tsup.config.ts`.

---

## Configuración añadida

```
memory.{embeddingDimension, embeddingEndpoint, autoExtract,
        extractionModel, similarityThreshold, embeddingWarmup}
```

---

## Próximo paso

**Hito 6 — Multi-provider Polishing:** health check al startup, listado/pull de modelos Ollama, pulido de fallback.
