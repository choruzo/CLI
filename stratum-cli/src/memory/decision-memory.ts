import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { findWorktreeRoot, resolveMemoryPaths } from '../config/paths.js';
import { writeFileAtomic } from '../config/writer.js';
import { getLogger } from '../logging/index.js';
import { DecisionStore, type DecisionInput, type DecisionRecord } from './decisions.js';
import { VectorStore } from './vectors.js';
import { EmbeddingService, type EmbeddingServiceOptions } from './embeddings.js';
import { Mutex } from '../agent/concurrency.js';

const log = getLogger('memory');

/** Lo derivado de la memoria de un proyecto: se reconstruye desde `decisions.json`. */
const DERIVED_INDEX_IGNORE = ['vectors.db*', '*.fallback.json', ''].join('\n');

/**
 * El índice vectorial de un proyecto (`<repo>/.stratum/memory/`) es binario y
 * derivado: no debe acabar en git. Se deja un `.gitignore` junto a él la
 * primera vez, solo con la forma por defecto (`.stratum/memory` dentro de un
 * repo) — una ruta elegida por el usuario no se toca — y nunca se pisa uno
 * existente. `decisions.json` queda versionable. Un fallo solo se avisa.
 */
export function ignoreDerivedIndex(vectorDb: string): void {
  const dir = dirname(vectorDb);
  if (basename(dir) !== 'memory' || basename(dirname(dir)) !== '.stratum') return;
  if (!findWorktreeRoot(dir).isGitRepo) return;
  const file = join(dir, '.gitignore');
  if (existsSync(file)) return;
  try {
    writeFileAtomic(file, DERIVED_INDEX_IGNORE);
  } catch (err) {
    log.warn('memory .gitignore write failed', { file, err });
  }
}

export interface SaveResult {
  record: DecisionRecord;
  /** true si se detectó un near-duplicado y NO se creó una entrada nueva. */
  deduped: boolean;
  duplicateOf?: string;
  /** false si el embedder no estaba disponible: la decisión se guardó en
   *  decisions.json pero NO se indexó (no será recuperable semánticamente). */
  indexed: boolean;
}

export interface RecallResult {
  record: DecisionRecord;
  score: number;
}

/**
 * Quién intentó guardar: la sesión y la vía. Es un dato del **intento**, no del
 * registro: con dedup, el registro que queda es el original —de otra sesión,
 * quizá— y su `session_id` no dice nada de quien acaba de llamar.
 */
export interface SaveAttempt {
  sessionId?: string;
  source: 'tool' | 'auto-extract' | 'user';
}

/**
 * Lo que cambia en la memoria de decisiones, para quien la observa
 * (`DecisionMemory.subscribe`). `saved` llega también cuando el guardado se
 * resolvió como near-duplicado (`deduped`): no se escribió nada, pero alguien
 * intentó guardar. `record` es lo que quedó almacenado; `attempt`, quién lo
 * intentó (ausente si quien llamó no lo dijo).
 */
export type DecisionMemoryEvent =
  | {
      type: 'saved';
      record: DecisionRecord;
      deduped: boolean;
      indexed: boolean;
      attempt?: SaveAttempt;
    }
  | { type: 'removed'; id: string };

export type DecisionMemoryListener = (event: DecisionMemoryEvent) => void;

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
  /** Últimos resultados de search(); consumidos por el loop para emitir memory_retrieved. */
  private lastRecall: RecallResult[] = [];
  /**
   * Serializa el pipeline de escritura (§12.16, Hito 8C). Con subagentes en
   * paralelo, dos `save()` concurrentes podrían entrelazar embed→findSimilar→add
   * y crear duplicados o corromper el índice; este mutex garantiza que cada
   * escritura ve el estado completo de la anterior. Singleton por ruta → protege
   * a todos los agentes que comparten el store.
   */
  private readonly writeLock = new Mutex();
  private readonly vectorDbPath: string;
  private indexIgnored = false;
  private readonly listeners = new Set<DecisionMemoryListener>();

  constructor(config: StratumConfig, opts?: DecisionMemoryOptions) {
    const paths = resolveMemoryPaths(config);
    this.vectorDbPath = paths.vectorDb;
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
   * Observa las escrituras de esta memoria: toda decisión guardada o eliminada,
   * venga de la tool `store_decision`, de la extracción automática o de un
   * comando. La instancia es única por fichero de decisiones, así que quien se
   * suscribe ve las de todos los agentes que lo comparten. Un listener no puede
   * hacer fallar una escritura: sus excepciones se descartan. Devuelve la
   * función que lo retira.
   */
  subscribe(listener: DecisionMemoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: DecisionMemoryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* la memoria no depende de quien la observa */
      }
    }
  }

  /**
   * Persiste una decisión con dedup semántico previo. Pipeline (§5):
   *   embed(content) → findSimilar ≥ threshold ? dedup : store.add + vectors.add
   */
  async save(input: DecisionInput, attempt?: SaveAttempt): Promise<SaveResult> {
    const result = await this.saveLocked(input);
    this.emit({
      type: 'saved',
      record: result.record,
      deduped: result.deduped,
      indexed: result.indexed,
      ...(attempt ? { attempt } : {}),
    });
    return result;
  }

  private saveLocked(input: DecisionInput): Promise<SaveResult> {
    // Serializado (Hito 8C): el pipeline dedup+add debe ser atómico frente a
    // escrituras concurrentes de subagentes paralelos que comparten el store.
    return this.writeLock.runExclusive(async () => {
      const text = `${input.title}\n${input.content}`;
      const vec = await this.embedder.embedOne(text);
      // El dedup solo ve lo indexado: sin esto, una decisión que falta en el
      // índice se guardaría otra vez como nueva.
      if (vec) await this.ensureIndexed();

      if (vec) {
        const dupRef = await this.vectors.findSimilar(vec, this.threshold);
        if (dupRef) {
          const existing = this.store.getByRef(dupRef);
          if (existing) {
            return { record: existing, deduped: true, duplicateOf: existing.id, indexed: true };
          }
        }
      }

      const record = this.store.add(input);
      if (vec) await this.vectors.add(record.embedding_ref, vec);
      return { record, deduped: false, indexed: vec !== null };
    });
  }

  /** Búsqueda semántica KNN. Devuelve decisiones por encima del umbral de score. */
  async search(query: string, k?: number): Promise<RecallResult[]> {
    const vec = await this.embedder.embedOne(query);
    if (!vec) return [];
    await this.ensureIndexed();
    const matches = await this.vectors.search(vec, k ?? this.topK);
    const out: RecallResult[] = [];
    for (const m of matches) {
      const record = this.store.getByRef(m.ref);
      if (record && m.score >= RETRIEVAL_MIN_SCORE) {
        out.push({ record, score: m.score });
      }
    }
    this.lastRecall = out;
    return out;
  }

  /** Devuelve y limpia los resultados del último search() (consumo único). */
  takeLastRecall(): RecallResult[] {
    const r = this.lastRecall;
    this.lastRecall = [];
    return r;
  }

  /** Elimina una decisión del store y del índice vectorial. */
  async remove(id: string): Promise<boolean> {
    const record = this.store.get(id);
    const removed = this.store.remove(id);
    if (record) await this.vectors.remove(record.embedding_ref);
    if (removed) this.emit({ type: 'removed', id });
    return removed;
  }

  list(): DecisionRecord[] {
    return this.store.all();
  }

  /**
   * Auto-reparación: indexa las decisiones de `decisions.json` que faltan en el
   * índice — guardadas con el embedder caído, un sidecar dañado que se empezó
   * de cero, un cambio de dimensión, u otra instancia que escribió a la vez.
   * Antes solo se reparaba un índice vacío: con uno incompleto, el recall no
   * encontraba esas decisiones nunca. Solo se calculan los embeddings que faltan.
   */
  private async ensureIndexed(): Promise<void> {
    // Todo lo que escribe el índice pasa por aquí antes (guardar y buscar).
    if (!this.indexIgnored) {
      this.indexIgnored = true;
      ignoreDerivedIndex(this.vectorDbPath);
    }
    const missing: DecisionRecord[] = [];
    for (const r of this.store.all()) {
      if (!(await this.vectors.has(r.embedding_ref))) missing.push(r);
    }
    if (missing.length === 0) return;
    const vecs = await this.embedder.embed(missing.map((r) => `${r.title}\n${r.content}`));
    if (!vecs) return;
    for (let i = 0; i < missing.length; i++) {
      const vec = vecs[i];
      if (vec) await this.vectors.add(missing[i]!.embedding_ref, vec);
    }
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

/** Fija la instancia que verá quien pida la memoria de esa config (tests con embedder inyectado). */
export function _setDecisionMemory(config: StratumConfig, memory: DecisionMemory): void {
  instances.set(resolveMemoryPaths(config).decisionsFile, memory);
}

/** Limpia el cache de instancias (tests). */
export function _resetDecisionMemoryCache(): void {
  instances.clear();
}
