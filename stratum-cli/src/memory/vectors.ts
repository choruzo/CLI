import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { dirname } from 'path';
import { writeFileAtomic } from '../config/writer.js';
import { getLogger } from '../logging/index.js';
import { importOptional } from '../runtime/optional-import.js';

const log = getLogger('memory');

export interface VectorMatch {
  ref: string;
  score: number;
}

export interface VectorEntry {
  ref: string;
  vec: Float32Array;
}

/** Backend de índice vectorial. Dos implementaciones: sqlite-vec y brute-force. */
interface VectorBackend {
  readonly name: string;
  add(ref: string, vec: Float32Array): void;
  remove(ref: string): void;
  has(ref: string): boolean;
  count(): number;
  search(vec: Float32Array, k: number): VectorMatch[];
  rebuild(entries: VectorEntry[]): void;
  close(): void;
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Backend brute-force en JS puro (fallback portable, sin dependencias nativas).
// Persiste en un sidecar JSON. O(n) por búsqueda; suficiente para el volumen de
// decisiones de una sesión y garantiza que la memoria semántica funcione aunque
// sqlite-vec / better-sqlite3 no estén instalados o fallen al compilar.
//
// El sidecar es un derivado de `decisions.json`, así que lo que no se entiende
// se descarta en vez de apartarse; lo que importa es que el índice no se quede
// incompleto sin que nadie lo note (ver `DecisionMemory.ensureIndexed`):
// - Varias instancias (dos `chat`, CLI + Desktop) comparten el fichero: cada
//   escritura relee el disco y aplica solo su cambio, y las lecturas recargan
//   si el fichero cambió desde la última vez.
// - Entradas con forma inválida o con otra dimensión (se cambió el modelo de
//   embeddings) se descartan al cargar: solo harían ruido con score 0.
// ---------------------------------------------------------------------------
export class BruteForceBackend implements VectorBackend {
  readonly name = 'brute-force';
  private entries = new Map<string, Float32Array>();
  /** `mtimeMs:size` del fichero la última vez que se leyó o escribió. */
  private signature: string | null = null;

  constructor(
    private readonly file: string,
    private readonly dim?: number,
  ) {
    this.refresh();
  }

  private currentSignature(): string | null {
    try {
      const st = statSync(this.file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  /** Recarga del disco si el fichero cambió (u otra instancia lo escribió). */
  private refresh(): void {
    const sig = this.currentSignature();
    if (sig !== null && sig === this.signature) return;
    this.signature = sig;
    this.entries = sig === null ? new Map() : this.readFile();
  }

  private readFile(): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (err) {
      log.warn('vector fallback index unreadable; it will be rebuilt from decisions', {
        file: this.file,
        err,
      });
      return out;
    }
    const list = (raw as { entries?: unknown } | null)?.entries;
    if (!Array.isArray(list)) return out;
    let dropped = 0;
    for (const e of list) {
      const vec = validVector(e, this.dim);
      if (vec) out.set((e as { ref: string }).ref, vec);
      else dropped++;
    }
    if (dropped > 0) {
      log.debug('vector fallback entries dropped', { file: this.file, dropped });
    }
    return out;
  }

  /** Relee el disco, aplica el cambio y persiste: no pisa lo de otra instancia. */
  private mutate(change: (entries: Map<string, Float32Array>) => boolean): void {
    this.refresh();
    if (!change(this.entries)) return;
    const payload = {
      entries: Array.from(this.entries.entries()).map(([ref, vec]) => ({
        ref,
        vec: Array.from(vec),
      })),
    };
    writeFileAtomic(this.file, JSON.stringify(payload));
    this.signature = this.currentSignature();
  }

  add(ref: string, vec: Float32Array): void {
    this.mutate((entries) => {
      entries.set(ref, vec);
      return true;
    });
  }

  remove(ref: string): void {
    this.mutate((entries) => entries.delete(ref));
  }

  has(ref: string): boolean {
    this.refresh();
    return this.entries.has(ref);
  }

  count(): number {
    this.refresh();
    return this.entries.size;
  }

  search(vec: Float32Array, k: number): VectorMatch[] {
    this.refresh();
    const scored: VectorMatch[] = [];
    for (const [ref, v] of this.entries) {
      scored.push({ ref, score: cosine(vec, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  rebuild(entries: VectorEntry[]): void {
    this.mutate((current) => {
      current.clear();
      for (const e of entries) current.set(e.ref, e.vec);
      return true;
    });
  }

  close(): void {
    /* nada que cerrar */
  }
}

/** Vector de una entrada del sidecar, o `null` si no tiene la forma esperada. */
function validVector(entry: unknown, dim: number | undefined): Float32Array | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { ref, vec } = entry as { ref?: unknown; vec?: unknown };
  if (typeof ref !== 'string' || !ref || !Array.isArray(vec) || vec.length === 0) return null;
  if (dim !== undefined && vec.length !== dim) return null;
  if (!vec.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return Float32Array.from(vec as number[]);
}

// ---------------------------------------------------------------------------
// Backend sqlite-vec (primario, §"Decisiones técnicas"). Import dinámico para
// no exigir las dependencias nativas si no están instaladas.
// ---------------------------------------------------------------------------
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

/** Dimensión declarada de `vec_decisions`, o `null` si la tabla no existe. */
function tableDimension(db: SqliteDb): number | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_decisions'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const m = /float\[(\d+)\]/i.exec(row.sql);
  return m ? Number(m[1]) : null;
}

class SqliteVecBackend implements VectorBackend {
  readonly name = 'sqlite-vec';

  private constructor(
    private readonly db: SqliteDb,
    private readonly dim: number,
  ) {}

  static async create(dbPath: string, dim: number): Promise<SqliteVecBackend> {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const DatabaseMod = await importOptional<{
      default: new (path: string) => SqliteDb;
    }>('better-sqlite3');
    const sqliteVec = await importOptional<{
      load: (db: unknown) => void;
    }>('sqlite-vec');

    const db = new DatabaseMod.default(dbPath);
    sqliteVec.load(db);
    // Cambiar `memory.embeddingDimension` (otro modelo) dejaba la tabla con la
    // dimensión vieja y todo `add` fallaba. El índice es derivado: se recrea y
    // `DecisionMemory.ensureIndexed` lo vuelve a llenar desde decisions.json.
    const existing = tableDimension(db);
    if (existing !== null && existing !== dim) {
      log.warn('vector index dimension changed; recreating it', {
        dbPath,
        from: existing,
        to: dim,
      });
      db.exec('DROP TABLE vec_decisions');
    }
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_decisions USING vec0(
         embedding_ref TEXT PRIMARY KEY,
         embedding float[${dim}] distance_metric=cosine
       );`,
    );
    return new SqliteVecBackend(db, dim);
  }

  add(ref: string, vec: Float32Array): void {
    const json = JSON.stringify(Array.from(vec));
    this.db.prepare('DELETE FROM vec_decisions WHERE embedding_ref = ?').run(ref);
    this.db
      .prepare('INSERT INTO vec_decisions(embedding_ref, embedding) VALUES (?, ?)')
      .run(ref, json);
  }

  remove(ref: string): void {
    this.db.prepare('DELETE FROM vec_decisions WHERE embedding_ref = ?').run(ref);
  }

  has(ref: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM vec_decisions WHERE embedding_ref = ? LIMIT 1')
      .get(ref);
  }

  count(): number {
    const row = this.db.prepare('SELECT count(*) AS c FROM vec_decisions').get() as { c: number };
    return row?.c ?? 0;
  }

  search(vec: Float32Array, k: number): VectorMatch[] {
    const json = JSON.stringify(Array.from(vec));
    const rows = this.db
      .prepare(
        `SELECT embedding_ref, distance FROM vec_decisions
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(json, k) as Array<{ embedding_ref: string; distance: number }>;
    // distance_metric=cosine → distancia coseno = 1 - similitud.
    return rows.map((r) => ({ ref: r.embedding_ref, score: 1 - r.distance }));
  }

  rebuild(entries: VectorEntry[]): void {
    this.db.exec('DELETE FROM vec_decisions');
    const stmt = this.db.prepare(
      'INSERT INTO vec_decisions(embedding_ref, embedding) VALUES (?, ?)',
    );
    for (const e of entries) stmt.run(e.ref, JSON.stringify(Array.from(e.vec)));
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* noop */
    }
  }
}

// ---------------------------------------------------------------------------
// VectorStore — fachada que elige backend y nunca propaga errores de backend.
// ---------------------------------------------------------------------------
export interface VectorStoreOptions {
  dbPath: string;
  fallbackPath: string;
  dimension: number;
  /** Fuerza el backend brute-force (tests / sin deps nativas). */
  forceFallback?: boolean;
}

export class VectorStore {
  private backend: VectorBackend | null = null;
  private initPromise: Promise<VectorBackend> | null = null;
  private warned = false;

  constructor(private readonly opts: VectorStoreOptions) {}

  /** Nombre del backend activo (tras inicializar). */
  async backendName(): Promise<string> {
    return (await this.ensure()).name;
  }

  private async ensure(): Promise<VectorBackend> {
    if (this.backend) return this.backend;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.opts.forceFallback) {
          try {
            const sqlite = await SqliteVecBackend.create(this.opts.dbPath, this.opts.dimension);
            this.backend = sqlite;
            return sqlite;
          } catch (err) {
            this.warn(`sqlite-vec no disponible (${String(err)}); usando índice brute-force JS`);
          }
        }
        const bf = new BruteForceBackend(this.opts.fallbackPath, this.opts.dimension);
        this.backend = bf;
        return bf;
      })();
    }
    return this.initPromise;
  }

  async add(ref: string, vec: Float32Array): Promise<void> {
    try {
      (await this.ensure()).add(ref, vec);
    } catch (err) {
      this.warn(`add falló para ${ref}: ${String(err)}`);
    }
  }

  async remove(ref: string): Promise<void> {
    try {
      (await this.ensure()).remove(ref);
    } catch (err) {
      this.warn(`remove falló para ${ref}: ${String(err)}`);
    }
  }

  async has(ref: string): Promise<boolean> {
    try {
      return (await this.ensure()).has(ref);
    } catch {
      return false;
    }
  }

  async count(): Promise<number> {
    try {
      return (await this.ensure()).count();
    } catch {
      return 0;
    }
  }

  async search(vec: Float32Array, k: number): Promise<VectorMatch[]> {
    try {
      return (await this.ensure()).search(vec, k);
    } catch (err) {
      this.warn(`search falló: ${String(err)}`);
      return [];
    }
  }

  /** Detección de near-duplicado: devuelve el ref si supera el umbral, si no null. */
  async findSimilar(vec: Float32Array, threshold: number): Promise<string | null> {
    const top = await this.search(vec, 1);
    if (top[0] && top[0].score >= threshold) return top[0].ref;
    return null;
  }

  async rebuild(entries: VectorEntry[]): Promise<void> {
    try {
      (await this.ensure()).rebuild(entries);
    } catch (err) {
      this.warn(`rebuild falló: ${String(err)}`);
    }
  }

  async close(): Promise<void> {
    if (this.backend) this.backend.close();
  }

  private warn(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[memory] ${msg}\n`);
  }
}
