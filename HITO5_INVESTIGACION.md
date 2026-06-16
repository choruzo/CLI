# Hito 5 — Memory Layers 2 y 3: investigación e implementación

> Análisis de cómo abordar el Hito 5 de Stratum CLI (DecisionStore + Vector DB
> semántico), usando como referencia arquitectónica el repo
> [odysseus](https://github.com/pewdiepie-archdaemon/odysseus) (workspace IA
> self-hosted en Python). Odysseus implementa exactamente el mismo problema
> —extracción de memoria, embeddings locales/remotos, store vectorial, dedup,
> recuperación KNN y auditoría— y deja muchas lecciones de robustez ya probadas
> en producción que se mapean directamente a Stratum.

---

## 1. Qué pide el Hito 5

De `STRATUM_PROJECT_DEFINITION.md` §9 y §5 (capas 2 y 3):

- [ ] `DecisionStore`: schema JSON + CRUD (`~/.stratum/memory/decisions.json`)
- [ ] Detección automática de decisiones importantes (LLM-based)
- [ ] Pipeline de embedding con `@xenova/transformers` (ONNX local)
- [ ] `sqlite-vec` setup e integración (`~/.stratum/memory/vectors.db`)
- [ ] Búsqueda semántica KNN
- [ ] Inyección de memoria relevante en contexto (evento `memory_retrieved`)
- [ ] Comandos `stratum memory list/search/forget`

Estado actual del código (lo ya hecho, no tocar):

- `src/memory/manager.ts` tiene los stubs `storeDecision()` y
  `searchDecisions()` que lanzan "no implementado hasta Hito 5".
- `src/agent/types.ts` ya define `DecisionEntry` y el evento
  `{ type: 'memory_retrieved'; decisions: DecisionEntry[] }`.
- `src/config/schema.ts` ya valida `decisionsFile`, `vectorDb`,
  `embeddingModel` (`Xenova/all-MiniLM-L6-v2`), `retrievalTopK` (5),
  `embeddingWarmup`.
- `src/cli/commands/memory.ts` ya tiene `list/search/forget` como stubs que
  imprimen "Coming in Hito 5"; `show` sí funciona.
- §12.7 fija el **trigger**: tool interna `store_decision` que el agente invoca
  él mismo (no clasificador externo). §12.10 fija la **carga ONNX** lazy con
  warm-up opcional.

---

## 2. Arquitectura de referencia en odysseus

Odysseus separa el problema en tres piezas casi idénticas a las capas de
Stratum:

| Pieza odysseus | Archivo | Equivalente Stratum (Hito 5) |
|---|---|---|
| Store JSON de hechos (CRUD) | `src/memory.py` | `decisions.json` / `DecisionStore` |
| Cliente de embeddings | `src/embeddings.py` | `EmbeddingService` (§12.10) |
| Índice vectorial + KNN/dedup | `src/memory_vector.py` | capa `sqlite-vec` / `vectors.ts` |
| Extracción automática + auditoría | `services/memory/memory_extractor.py` | "detección automática LLM-based" |

**Diferencia tecnológica importante:** odysseus usa **ChromaDB**; Stratum tiene
fijado por decisión técnica `sqlite-vec` + `better-sqlite3` (embebido, sin
servidor). El *patrón* es transferible 1:1, solo cambia la capa de
almacenamiento. Igualmente odysseus usa `fastembed` (ONNX) y/o un endpoint HTTP;
Stratum tiene fijado `@xenova/transformers`. Las decisiones técnicas de Stratum
(§"Decisiones que no deben revertirse") **mandan** sobre lo que haga odysseus.

---

## 3. Pipeline de embeddings (`EmbeddingService`)

### Lo que hace odysseus (`src/embeddings.py`)

Factory con orden de prioridad y *fast-fail*:

1. **HTTP API OpenAI-compatible** (`/v1/embeddings`, Ollama/vLLM/llama.cpp)
   con timeout de conexión corto (3 s) para que un endpoint caído caiga rápido
   al fallback local en vez de colgar el arranque ~30 s por probe.
2. **Local ONNX** (`fastembed`) como fallback de cero configuración.

Detalles valiosos:

- **Latch de proceso `_http_embed_down`**: si el endpoint HTTP falla una vez, no
  se reintenta el resto del proceso (evita pagar el timeout en cada
  embedding). Hay un `reset_http_embed_state()` para cuando cambia la config.
- **Batching** en chunks de 64 textos por request.
- **Normalización L2** de los vectores (`normalize_embeddings=True`) → permite
  usar producto punto como similitud coseno.
- **Descubrimiento de dimensión** embebiendo `"hello"` una vez y cacheándola.

### Recomendación para Stratum

La spec (§12.10) solo contempla `@xenova` local. Funciona, pero **conviene
adoptar el patrón provider-agnostic de odysseus** porque encaja con la filosofía
del proyecto (cualquier API OpenAI-compatible): Stratum ya tiene un
`OpenAICompatible` provider y muchos backends (Ollama, vLLM, LiteLLM) exponen
`/v1/embeddings`. Propuesta:

- **Primario:** `@xenova/transformers` local (lo que pide la spec), lazy load
  exactamente como en §12.10 (clase con `pipeline` + `loadPromise`, cache en
  `~/.stratum/models/`, warm-up opcional).
- **Opcional/avanzado:** permitir `memory.embeddingEndpoint` para usar el
  `/v1/embeddings` del provider activo, con el mismo latch de fast-fail y
  fallback al ONNX local. Es barato de añadir y muy en línea con el proyecto.

Lo crítico de `@xenova`: salida `{ pooling: 'mean', normalize: true }` →
`Float32Array` de **384 dims** para `all-MiniLM-L6-v2`. Normalizar siempre para
que coseno == dot product.

### ⚠️ Aviso Windows (relevante para tu entorno)

Odysseus dedica código defensivo a un bug real de Windows que **también afectará
a `@xenova` en Stratum**: la caché de HuggingFace guarda el modelo ONNX como
*symlinks* (`snapshots/<rev>/model.onnx -> ../../blobs/<hash>`). En rutas de red
/ UNC, Windows no sigue el symlink (`WinError 1463`) y el modelo falla a cargar
*sin re-descargar*, dejando la memoria semántica muerta.

Mitigación a portar:

```
// antes de importar @xenova / al configurar la caché
process.env.HF_HUB_DISABLE_SYMLINKS = '1';
process.env.HF_HUB_DISABLE_SYMLINKS_WARNING = '1';
```

Y, opcionalmente, una auto-curación: detectar un `.onnx` que es symlink roto en
`~/.stratum/models/` y borrar ese dir para forzar re-descarga (odysseus lo hace
en `FastEmbedClient.__init__`).

---

## 4. Capa 3 — Vector DB con `sqlite-vec`

Odysseus usa Chroma (`collection.add/query/delete`), pero el contrato que expone
su `MemoryVectorStore` es justo el que Stratum necesita reproducir sobre
`sqlite-vec`:

| Método odysseus | Semántica | Implementación sqlite-vec |
|---|---|---|
| `add(id, text)` | upsert un vector | `INSERT` en tabla `vec0` con `embedding_ref` como rowid/clave |
| `remove(id)` | borrado O(1), sin rebuild | `DELETE WHERE key = ?` |
| `search(query, k)` | KNN top-K, devuelve `{id, score}` | `SELECT ... WHERE embedding MATCH ? ORDER BY distance LIMIT k` |
| `find_similar(text, threshold)` | detección de near-dup | `search(text, 1)` y comparar score ≥ threshold |
| `rebuild(entries)` | reconstrucción completa | `DELETE` todo + re-insertar por lotes de 100 |
| `count()` / `get_stats()` | salud/observabilidad | `SELECT count(*)` |

### Setup concreto sqlite-vec en Node

```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec'; // load extension

const db = new Database(vectorDbPath);
sqliteVec.load(db);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS decisions_vec USING vec0(
    embedding_ref TEXT PRIMARY KEY,
    embedding float[384]
  );
`);
```

- **Insertar**: pasar el `Float32Array` como BLOB (`Buffer.from(vec.buffer)`).
- **KNN**:

```ts
const rows = db.prepare(`
  SELECT embedding_ref, distance
  FROM decisions_vec
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT ?
`).all(Buffer.from(queryVec.buffer), topK);
// similitud coseno = 1 - distance  (igual que odysseus: similarity = 1.0 - distance)
```

- La clave es `embedding_ref = vec_${id}` tal como fija §"Generación de IDs" de
  la spec; así el KNN devuelve `embedding_ref` → derivas el `id` de la decisión
  → cargas la entrada completa desde `decisions.json`.

### Lecciones de robustez de odysseus a portar

1. **`decisions.json` es la fuente de verdad, el vector es índice.** Un fallo al
   escribir en el vector store **no debe** abortar el batch ni perder la
   decisión (odysseus envuelve cada `vector.add` en try/except y solo loguea).
2. **Borrado O(1)**: `remove()` no reconstruye el índice; clave para
   `stratum memory forget`.
3. **Batch en lotes de 100** en `rebuild()` para no mandar requests gigantes.
4. **`.healthy` solo se setea en init**, no captura fallos posteriores → en cada
   uso, capturar excepciones en caliente y degradar a búsqueda por texto si el
   vector falla.

---

## 5. Trigger de escritura: `store_decision` vs extracción automática

Hay dos enfoques y el Hito 5 los menciona ambos:

### A. `store_decision` como tool interna (lo que fija §12.7) — **primario**

El agente invoca él mismo la tool cuando toma una decisión significativa. Sin
LLM call extra, coste cero si no hay decisión. Ya está el schema en la spec
(`title`, `content`, `type`, `tags`, `importance`; `destructive:false`,
`serialized:true`). Pipeline de `decisionStore.save()`:

```
1. id = dec_YYYYMMDD_<nanoid6>           (sin leer el JSON previo → sin colisión)
2. embedding_ref = vec_${id}
3. (dedup) find_similar(content) ≥ threshold → si hay near-dup, no duplicar
4. append entrada completa a decisions.json
5. embedding = EmbeddingService.embed(content)   (ONNX local)
6. INSERT en sqlite-vec con embedding_ref como clave
```

### B. Extracción automática LLM-based (lo que hace odysseus) — **opcional**

`memory_extractor.extract_and_store()` corre **en background tras cada respuesta
del agente**: manda los últimos ~6 mensajes al LLM con un prompt que extrae
"hechos durables" (máx 2 por conversación) y los guarda. Patrones clave:

- **Aplana** la ventana de mensajes en UN solo mensaje de usuario
  ("analiza este transcript, devuelve el array JSON") en vez de pasarlos como
  conversación; si no, el modelo *continúa* la charla en vez de *analizar* y
  devuelve `[]` siempre. (Repro controlada: 0/6 vs 6/6.)
- **Parsing tolerante a modelos de razonamiento**: stripear `<think>…</think>`,
  fences ```` ```json ````, prosa antes/después, y recortar de `[` a `]`.
- `max_tokens` amplio (4096) porque el modelo gasta presupuesto pensando antes
  de emitir el JSON.
- **Fallback por regex** sin LLM para hechos obvios de identidad/preferencia
  ("my name is…", "I live in…", "I prefer…") por si el modelo de background los
  juzga demasiado conversacionales.
- **Nunca lanza**: corre como tarea de background, errores solo se loguean.

**Recomendación:** implementar A (es lo que fija la spec y es barato/predecible).
Dejar B como mejora futura tras Hito 5 si quieres captura pasiva — el blueprint
de odysseus está completo y listo para portar. Para el checklist "detección
automática LLM-based", A + el system-prompt que instruye al agente a usar
`store_decision` proactivamente (§12.7) cumple la intención sin el coste de B.

---

## 6. Flujo de recuperación (KNN → inyección)

Siguiendo §5 de la spec y `MemoryVectorStore.search()` de odysseus:

```
Query semántica (p.ej. el input del usuario o una sub-consulta del agente)
   → EmbeddingService.embed(query)               (ONNX local, normalizado)
   → sqlite-vec KNN top-K (retrievalTopK = 5)    → [embedding_ref, distance]
   → derivar ids → cargar entradas completas de decisions.json
   → inyectar en contexto + emitir AgentEvent { type:'memory_retrieved', decisions }
```

- La UI ya espera `memory_retrieved` (indicador visual discreto, §UI spec §11).
- `score = 1 - distance`; aplicar un umbral mínimo de relevancia para no
  inyectar ruido (odysseus ordena por score y dedup por id antes de devolver).
- **Cuándo recuperar**: opción simple = al inicio de cada turno embebes el input
  del usuario y recuperas top-K. Más fino = exponer una tool `recall_decisions`
  que el agente invoque cuando lo necesite (espejo de `store_decision`).

---

## 7. Auditoría / consolidación (para `memory list/search/forget` y mantenimiento)

`memory_extractor.audit_memories()` aporta patrones muy útiles para un
`stratum memory` sano a largo plazo, aunque no sea estrictamente obligatorio en
Hito 5:

- **Short-circuit por fingerprint**: hash estable (orden-independiente) de
  `id+text+category`; si no cambió desde la última auditoría, se salta el LLM
  (ahorra 30-120 s). Útil si añades consolidación periódica.
- **Red de seguridad anti-borrado**: si la auditoría devolvería <50 % de las
  entradas (sobre ≥8), se rechaza por considerarse un misfire. *Mejor no-op que
  perder memoria.*
- **Preservar `id` y metadata** al fusionar; nunca inventar entradas (descartar
  ids desconocidos que devuelva el modelo).
- **Rebuild del índice vectorial** desde el set completo guardado tras
  consolidar.

`stratum memory forget <id>` = borrar de `decisions.json` + `vector.remove(id)`
(O(1), sin rebuild). `memory list` = leer JSON. `memory search <query>` = el
flujo KNN del §6 pero imprimiendo resultados en CLI.

---

## 8. Plan de implementación propuesto (orden sugerido)

1. **`src/memory/decisions.ts` — `DecisionStore`**: CRUD sobre `decisions.json`,
   generación de `id` (`dec_YYYYMMDD_<nanoid6>`) y `embedding_ref`, dedup previa.
   Tests de CRUD y colisión de ids.
2. **`src/memory/embeddings.ts` — `EmbeddingService`**: lazy load `@xenova`
   (§12.10), normalización, warm-up opcional, guard de symlinks Windows.
   (Opcional: ruta HTTP `/v1/embeddings` con fast-fail.)
3. **`src/memory/vectors.ts` — capa `sqlite-vec`**: `better-sqlite3` + extensión,
   tabla `vec0(384)`, `add/remove/search/findSimilar/rebuild/count`. Errores en
   caliente capturados, fuente de verdad = JSON.
4. **Wire en `MemoryManager`**: reemplazar los stubs `storeDecision()` /
   `searchDecisions()` orquestando las 3 piezas; emitir `memory_retrieved`.
5. **Tool `store_decision`** (§12.7) en `src/tools/` + instrucción en el system
   prompt. `serialized:true`.
6. **Recuperación en el loop** (`harness.ts`): embeber consulta → KNN → inyectar
   → evento. Respetar `retrievalTopK` y umbral de score.
7. **CLI**: implementar `memory list/search/forget` (hoy stubs) + autocompletado
   `/memory list/search/forget` en la UI Ink + indicador `memory_retrieved` +
   barra de progreso de descarga ONNX en primer arranque.
8. **Verificación**: tests Vitest de `DecisionStore`, round-trip embed→insert→KNN
   (con vectores mock para no depender del modelo en CI), y dedup por threshold.
   Probar en Windows que el ONNX carga (caso symlink).

### Dependencias a añadir a `package.json`

- `better-sqlite3` + `sqlite-vec`
- `@xenova/transformers`
- `nanoid` (para el sufijo de id)

Node ≥22 ya está fijado (`engines`), compatible con `better-sqlite3` y
`@xenova`.

---

## 9. Resumen de decisiones clave

- **Mantener** `sqlite-vec` + `@xenova` (decisiones técnicas innegociables de
  Stratum); odysseus aporta el *patrón*, no la tecnología.
- **Trigger primario** = `store_decision` (spec §12.7); extracción automática
  LLM-based de odysseus queda como mejora opcional con blueprint listo.
- **`decisions.json` = fuente de verdad**; el vector es índice reconstruible y
  un fallo vectorial nunca debe perder datos.
- **Dedup antes de insertar** con `findSimilar(threshold)` (odysseus usa
  ~0.72–0.92 según el caso; ajustar empíricamente).
- **Endurecer para Windows** desde el día 1 (symlinks ONNX, fast-fail de
  endpoints).
- **Errores de memoria se loguean, no se propagan**: la memoria es auxiliar,
  nunca debe tumbar una sesión del agente.

---

### Archivos de odysseus consultados

- `src/embeddings.py` — clientes de embedding (HTTP + ONNX fallback, Windows)
- `src/memory_vector.py` — store vectorial (add/remove/search/find_similar/rebuild)
- `services/memory/memory_extractor.py` — extracción automática + auditoría
- `services/memory/memory_vector.py` — wrapper de compatibilidad
