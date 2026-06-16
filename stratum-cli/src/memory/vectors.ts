import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

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
// ---------------------------------------------------------------------------
export class BruteForceBackend implements VectorBackend {
  readonly name = 'brute-force';
  private entries = new Map<string, Float32Array>();

  constructor(private readonly file: string) {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as {
        entries?: Array<{ ref: string; vec: number[] }>;
      };
      for (const e of raw.entries ?? []) {
        this.entries.set(e.ref, Float32Array.from(e.vec));
      }
    } catch {
      /* índice corrupto → empezar vacío; se reconstruye desde decisions.json */
    }
  }

  private persist(): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      entries: Array.from(this.entries.entries()).map(([ref, vec]) => ({
        ref,
        vec: Array.from(vec),
      })),
    };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    renameSync(tmp, this.file);
  }

  add(ref: string, vec: Float32Array): void {
    this.entries.set(ref, vec);
    this.persist();
  }

  remove(ref: string): void {
    if (this.entries.delete(ref)) this.persist();
  }

  has(ref: string): boolean {
    return this.entries.has(ref);
  }

  count(): number {
    return this.entries.size;
  }

  search(vec: Float32Array, k: number): VectorMatch[] {
    const scored: VectorMatch[] = [];
    for (const [ref, v] of this.entries) {
      scored.push({ ref, score: cosine(vec, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  rebuild(entries: VectorEntry[]): void {
    this.entries.clear();
    for (const e of entries) this.entries.set(e.ref, e.vec);
    this.persist();
  }

  close(): void {
    /* nada que cerrar */
  }
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

class SqliteVecBackend implements VectorBackend {
  readonly name = 'sqlite-vec';

  private constructor(
    private readonly db: SqliteDb,
    private readonly dim: number,
  ) {}

  static async create(dbPath: string, dim: number): Promise<SqliteVecBackend> {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const DatabaseMod = (await import(/* @vite-ignore */ 'better-sqlite3' as string)) as {
      default: new (path: string) => SqliteDb;
    };
    const sqliteVec = (await import(/* @vite-ignore */ 'sqlite-vec' as string)) as {
      load: (db: unknown) => void;
    };

    const db = new DatabaseMod.default(dbPath);
    sqliteVec.load(db);
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
            this.warn(
              `sqlite-vec no disponible (${String(err)}); usando índice brute-force JS`,
            );
          }
        }
        const bf = new BruteForceBackend(this.opts.fallbackPath);
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
