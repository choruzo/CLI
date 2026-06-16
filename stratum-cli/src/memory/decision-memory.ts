import type { StratumConfig } from '../config/schema.js';
import { resolveMemoryPaths } from '../config/paths.js';
import { DecisionStore, type DecisionInput, type DecisionRecord } from './decisions.js';
import { VectorStore } from './vectors.js';
import { EmbeddingService, type EmbeddingServiceOptions } from './embeddings.js';

export interface SaveResult {
  record: DecisionRecord;
  /** true si se detectó un near-duplicado y NO se creó una entrada nueva. */
  deduped: boolean;
  duplicateOf?: string;
}

export interface RecallResult {
  record: DecisionRecord;
  score: number;
}

export interface DecisionMemoryOptions {
  embedding?: EmbeddingServiceOptions;
  forceFallbackVectors?: boolean;
}

/**
 * Orquesta las Capas 2 y 3: `DecisionStore` (fuente de verdad) +
 * `VectorStore` (índice semántico) + `EmbeddingService`.
 *
 * Invariante de robustez: `decisions.json` siempre se actualiza; un fallo del
 * índice vectorial o del embedder degrada a memoria sin búsqueda semántica pero
 * nunca pierde una decisión ni lanza.
 */
/**
 * Umbral mínimo de similitud para incluir un resultado en la recuperación.
 * Independiente del umbral de dedup (mucho más alto): con embeddings reales
 * (MiniLM) los resultados relevantes suelen caer en 0.3–0.6.
 */
const RETRIEVAL_MIN_SCORE = 0.2;

export class DecisionMemory {
  readonly store: DecisionStore;
  readonly vectors: VectorStore;
  readonly embedder: EmbeddingService;
  private readonly topK: number;
  private readonly threshold: number;

  constructor(config: StratumConfig, opts?: DecisionMemoryOptions) {
    const paths = resolveMemoryPaths(config);
    this.store = new DecisionStore(paths.decisionsFile);
    this.vectors = new VectorStore({
      dbPath: paths.vectorDb,
      fallbackPath: paths.vectorFallback,
      dimension: config.memory.embeddingDimension,
      forceFallback: opts?.forceFallbackVectors,
    });
    this.embedder = new EmbeddingService(config, opts?.embedding);
    this.topK = config.memory.retrievalTopK;
    this.threshold = config.memory.similarityThreshold;
  }

  /**
   * Persiste una decisión con dedup semántico previo. Pipeline (§5):
   *   embed(content) → findSimilar ≥ threshold ? dedup : store.add + vectors.add
   */
  async save(input: DecisionInput): Promise<SaveResult> {
    const text = `${input.title}\n${input.content}`;
    const vec = await this.embedder.embedOne(text);

    if (vec) {
      const dupRef = await this.vectors.findSimilar(vec, this.threshold);
      if (dupRef) {
        const existing = this.store.getByRef(dupRef);
        if (existing) {
          return { record: existing, deduped: true, duplicateOf: existing.id };
        }
      }
    }

    const record = this.store.add(input);
    if (vec) await this.vectors.add(record.embedding_ref, vec);
    return { record, deduped: false };
  }

  /** Búsqueda semántica KNN. Devuelve decisiones por encima del umbral de score. */
  async search(query: string, k?: number): Promise<RecallResult[]> {
    const vec = await this.embedder.embedOne(query);
    if (!vec) return [];
    const matches = await this.vectors.search(vec, k ?? this.topK);
    const out: RecallResult[] = [];
    for (const m of matches) {
      const record = this.store.getByRef(m.ref);
      if (record && m.score >= RETRIEVAL_MIN_SCORE) {
        out.push({ record, score: m.score });
      }
    }
    return out;
  }

  /** Elimina una decisión del store y del índice vectorial. */
  async remove(id: string): Promise<boolean> {
    const record = this.store.get(id);
    const removed = this.store.remove(id);
    if (record) await this.vectors.remove(record.embedding_ref);
    return removed;
  }

  list(): DecisionRecord[] {
    return this.store.all();
  }

  /**
   * Reconstruye el índice vectorial desde `decisions.json` (fuente de verdad).
   * Útil tras un borrado del índice o si el embedder estuvo caído al guardar.
   */
  async reindex(): Promise<number> {
    const records = this.store.all();
    const texts = records.map((r) => `${r.title}\n${r.content}`);
    const vecs = await this.embedder.embed(texts);
    if (!vecs) return 0;
    const entries = records.map((r, i) => ({ ref: r.embedding_ref, vec: vecs[i]! }));
    await this.vectors.rebuild(entries);
    return entries.length;
  }
}

// ---------------------------------------------------------------------------
// Singleton por ruta de decisions.json — evita recargar el modelo ONNX y abrir
// la DB varias veces cuando varias tools/comandos acceden a la memoria.
// ---------------------------------------------------------------------------
const instances = new Map<string, DecisionMemory>();

export function getDecisionMemory(
  config: StratumConfig,
  opts?: DecisionMemoryOptions,
): DecisionMemory {
  // Los tests con embedder inyectado deben obtener siempre una instancia fresca.
  if (opts) return new DecisionMemory(config, opts);
  const key = resolveMemoryPaths(config).decisionsFile;
  let inst = instances.get(key);
  if (!inst) {
    inst = new DecisionMemory(config);
    instances.set(key, inst);
  }
  return inst;
}

/** Limpia el cache de instancias (tests). */
export function _resetDecisionMemoryCache(): void {
  instances.clear();
}
