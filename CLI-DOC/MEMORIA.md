# Memoria de Decisiones de Stratum (Capas 2 y 3)

> Cómo funciona, en orden, la memoria a largo plazo implementada en el Hito 5.
> El código vive en `stratum-cli/src/memory/`.

## 1. Qué es

Es una **memoria semántica persistente**: Stratum recuerda decisiones técnicas
entre sesiones y las recupera por *significado*, no por coincidencia exacta de
palabras. No es un log: cada decisión es un registro estructurado, se
deduplica al guardarse y se recupera mediante búsqueda vectorial (KNN).

La `Capa 1` (STRATUM.md, Hito 2) sigue existiendo y es independiente: contexto
de proyecto cargado en el system prompt. Este documento cubre las **Capas 2 y
3**, que son la memoria de decisiones propiamente dicha.

## 2. Las tres piezas

Hay una separación deliberada entre **lo que se guarda** y **cómo se encuentra**.

| Pieza | Archivo | Rol |
|---|---|---|
| `DecisionStore` | `decisions.ts` → `decisions.json` | Fuente de verdad (Capa 2) |
| `VectorStore` | `vectors.ts` → `vectors.db` / `*.fallback.json` | Índice de búsqueda (Capa 3) |
| `EmbeddingService` | `embeddings.ts` | Texto → vector de significado |
| `DecisionMemory` | `decision-memory.ts` | Orquestador de las tres |

### 2.1. DecisionStore — la fuente de verdad

`decisions.json` es un array de registros. Cada uno:

```json
{
  "id": "dec_20260616_a3f9k2",
  "timestamp": "2026-06-16T10:30:00.000Z",
  "type": "architectural",
  "title": "Usar sqlite-vec en lugar de Chroma",
  "content": "Embebido y sin servidor; Chroma requería Docker.",
  "tags": ["database", "vectors"],
  "importance": "high",
  "embedding_ref": "vec_dec_20260616_a3f9k2",
  "source": "agent"
}
```

- `id`: formato `dec_YYYYMMDD_<nanoid6>`, generado antes de escribir (sin leer
  el JSON previo → sin colisiones entre sesiones concurrentes).
- `type`: architectural | tooling | convention | bug_fix | security | user_preference.
- `embedding_ref = vec_<id>`: la clave con la que el índice vectorial referencia
  esta decisión.
- `source`: `agent` (tool `store_decision`) o `auto` (extracción en background).
- Escritura **atómica**: se escribe a un `.tmp` y se renombra, para no corromper
  el JSON si el proceso muere a mitad.

### 2.2. EmbeddingService — texto a vector

Convierte un texto en un vector de 384 números (con `all-MiniLM-L6-v2`) que
captura su *significado*. Estrategia provider-agnostic con dos rutas:

1. **Endpoint HTTP `/v1/embeddings`** (Ollama, vLLM, llama.cpp, LiteLLM) si está
   configurado en `memory.embeddingEndpoint`. Tiene *fast-fail*: si no responde
   en pocos segundos, un latch de proceso evita reintentarlo en cada llamada.
2. **ONNX local** `@xenova/transformers` (fallback de cero configuración). Carga
   diferida (lazy) y cacheada en `~/.stratum/models`. Incluye un guard para el
   bug de symlinks de HuggingFace en Windows.

Todos los vectores se **normalizan L2**, de modo que la similitud coseno entre
dos es simplemente su producto punto. Si ningún backend está disponible,
`embed()` devuelve `null` y el sistema degrada a memoria sin índice semántico
(pero sigue guardando en `decisions.json`).

Con `memory.embeddingWarmup: true`, el modelo ONNX se precarga en background al
arrancar `chat`, para que la primera operación de memoria no pague la latencia.

### 2.3. VectorStore — el índice de búsqueda

Guarda el vector de cada decisión bajo su `embedding_ref` y resuelve KNN
(k vecinos más cercanos). Tiene **dos backends** con la misma interfaz:

- **`sqlite-vec`** (primario): tabla virtual `vec0` con `distance_metric=cosine`.
  Se cargan `better-sqlite3` + `sqlite-vec` por import dinámico.
- **brute-force JS** (fallback): si las dependencias nativas no están instaladas
  o fallan al compilar, cae a un índice en memoria persistido en
  `vectors.fallback.json`. Calcula coseno contra todos los vectores (O(n) por
  búsqueda; de sobra para el volumen de una sesión).

El índice es **reconstruible**: nunca es la fuente de verdad. Si se borra o se
corrompe, `reindex()` lo regenera desde `decisions.json`.

## 3. Camino de ESCRITURA (cómo se guarda una decisión)

Hay **dos disparadores** que terminan en el mismo pipeline:

1. **Tool `store_decision`** — el agente la invoca él mismo cuando toma una
   decisión significativa. El system prompt le indica cuándo usarla. Coste cero
   si no hay nada que guardar. Es `serialized` (nunca corre en paralelo consigo
   misma).
2. **Extracción automática** (`extractor.ts`) — tras cada respuesta del agente,
   en background, un LLM relee los últimos mensajes y extrae decisiones
   duraderas (máx. 2). Es best-effort: tolera el ruido de modelos de
   razonamiento (`<think>`, fences ```json```) y, si falla, solo se loguea.

Pipeline común en `DecisionMemory.save()`:

```
texto (title + content)
        │
        ▼
EmbeddingService.embed(texto)         ── vector de 384 dims (normalizado)
        │
        ▼
VectorStore.findSimilar(vec, 0.9)     ── ¿existe un near-duplicado?
        │
        ├── sí → NO se duplica; se devuelve la decisión existente (deduped)
        │
        └── no
             ▼
        DecisionStore.add()           ── append atómico a decisions.json (verdad)
             ▼
        VectorStore.add(ref, vec)     ── inserta el vector en el índice
```

El umbral de dedup (`memory.similarityThreshold`, 0.9 por defecto) es alto: solo
se considera duplicado algo casi idéntico.

## 4. Camino de LECTURA (cómo se recupera)

El agente usa la tool **`recall_decisions`** cuando necesita recordar algo
("¿por qué elegimos sqlite-vec?"). Flujo KNN semántico en
`DecisionMemory.search()`:

```
consulta en lenguaje natural
        │
        ▼
EmbeddingService.embed(consulta)      ── vector de la consulta
        │
        ▼
VectorStore.search(vec, topK)         ── K vecinos más cercanos (default K=5)
        │
        ▼
para cada match: cargar el registro completo desde decisions.json
        │
        ▼
filtrar score < 0.2 (ruido)           ── RETRIEVAL_MIN_SCORE
        │
        ▼
devolver [{ decisión, score }]  → al agente (texto) y guardado en lastRecall
```

Cuando la recuperación devuelve algo, el bucle (`harness.ts`) consume
`takeLastRecall()` y **emite el evento `memory_retrieved`** con las decisiones
estructuradas. La UI muestra un indicador discreto:
`↳ memoria recuperada: N decisiones relevantes`.

Nota: el umbral de recuperación (0.2) es mucho más bajo que el de dedup (0.9).
Con embeddings reales (MiniLM) los resultados relevantes suelen caer en
0.3–0.6, así que un filtro alto dañaría el recall.

## 5. Invariante de robustez

La regla de oro: **`decisions.json` nunca se pierde**.

- Si el embedder o el índice vectorial fallan al guardar, la decisión igual se
  persiste en el JSON; solo te quedas sin búsqueda semántica hasta que
  `reindex()` reconstruya el índice.
- Todas las operaciones de la Capa 3 capturan sus errores y degradan en vez de
  lanzar. La memoria es **auxiliar**: un fallo suyo jamás tumba una sesión del
  agente.

## 6. Acceso (config, archivos, comandos)

Configuración (`.stratumrc.json`, bloque `memory`):

| Clave | Default | Qué hace |
|---|---|---|
| `decisionsFile` | `~/.stratum/memory/decisions.json` | Fuente de verdad |
| `vectorDb` | `~/.stratum/memory/vectors.db` | Índice sqlite-vec |
| `embeddingModel` | `Xenova/all-MiniLM-L6-v2` | Modelo ONNX local |
| `embeddingDimension` | `384` | Dimensión del vector |
| `embeddingEndpoint` | — | Endpoint HTTP opcional `/v1/embeddings` |
| `retrievalTopK` | `5` | Vecinos a recuperar |
| `similarityThreshold` | `0.9` | Umbral de dedup |
| `autoExtract` | `true` | Extracción automática en background |
| `extractionModel` | — | Modelo para la extracción (si no, el activo) |
| `embeddingWarmup` | `false` | Precarga ONNX al arrancar |

Archivos en disco (`~/.stratum/memory/`):
- `decisions.json` — registros (fuente de verdad).
- `vectors.db` — índice sqlite-vec (si las deps nativas están).
- `vectors.fallback.json` — índice brute-force (si no lo están).

Comandos:
- En el chat: `/memory show`, `/memory list`, `/memory search <consulta>`,
  `/memory forget <id>`.
- En CLI: `stratum memory list | search <q> | forget <id> | show`.

## 7. Mapa de archivos del código

| Archivo | Contenido |
|---|---|
| `src/memory/decisions.ts` | `DecisionStore` (CRUD JSON atómico, ids) |
| `src/memory/embeddings.ts` | `EmbeddingService` (HTTP + ONNX local) |
| `src/memory/vectors.ts` | `VectorStore` (sqlite-vec + fallback brute-force) |
| `src/memory/decision-memory.ts` | `DecisionMemory` (orquestador, singleton) |
| `src/memory/extractor.ts` | Extracción automática LLM-based |
| `src/tools/memory/store-decision.ts` | Tool `store_decision` |
| `src/tools/memory/recall-decisions.ts` | Tool `recall_decisions` |
| `src/agent/harness.ts` | Emisión del evento `memory_retrieved` |
| `src/cli/commands/memory.ts` | Comandos CLI |
| `src/cli/ui/App.tsx` | Comandos `/memory ...` y el indicador en el chat |

> Visualización interactiva del flujo: abrir `memoria-visual.html` en esta misma
> carpeta.
