import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { customAlphabet } from 'nanoid';

export type DecisionType =
  | 'architectural'
  | 'tooling'
  | 'convention'
  | 'bug_fix'
  | 'security'
  | 'user_preference';

export type DecisionImportance = 'low' | 'medium' | 'high';

/** Entrada completa persistida en decisions.json (§5, Capa 2). */
export interface DecisionRecord {
  id: string;
  timestamp: string;
  type: DecisionType;
  title: string;
  content: string;
  tags: string[];
  importance: DecisionImportance;
  embedding_ref: string;
  project?: string;
  /** Origen: 'agent' (tool store_decision) o 'auto' (extracción en background). */
  source?: 'agent' | 'auto';
  session_id?: string;
}

/** Campos que aporta quien crea la decisión; el resto se deriva. */
export interface DecisionInput {
  title: string;
  content: string;
  type: DecisionType;
  tags: string[];
  importance: DecisionImportance;
  project?: string;
  source?: 'agent' | 'auto';
  session_id?: string;
}

// nanoid sin guiones ni guiones bajos para que el id sea limpio en CLI/paths.
const nano6 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * DecisionStore — Capa 2. CRUD sobre `decisions.json`.
 *
 * Es la **fuente de verdad** de la memoria a largo plazo; el índice vectorial
 * es un derivado reconstruible. Nunca lanza por archivo ausente o corrupto:
 * `load()` devuelve `[]`. Las escrituras son atómicas (tmp + rename).
 */
export class DecisionStore {
  constructor(private readonly file: string) {}

  /** Genera un id `dec_YYYYMMDD_<nanoid6>` sin leer el JSON previo (§5). */
  static generateId(now: Date = new Date()): string {
    return `dec_${yyyymmdd(now)}_${nano6()}`;
  }

  load(): DecisionRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = readFileSync(this.file, 'utf-8').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as DecisionRecord[]) : [];
    } catch {
      return [];
    }
  }

  save(records: DecisionRecord[]): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
    renameSync(tmp, this.file);
  }

  /**
   * Crea y persiste una nueva decisión. Genera `id` y `embedding_ref` antes de
   * escribir (sin riesgo de colisión entre sesiones concurrentes).
   */
  add(input: DecisionInput, now: Date = new Date()): DecisionRecord {
    const id = DecisionStore.generateId(now);
    const record: DecisionRecord = {
      id,
      timestamp: now.toISOString(),
      type: input.type,
      title: input.title,
      content: input.content,
      tags: input.tags,
      importance: input.importance,
      embedding_ref: `vec_${id}`,
      ...(input.project ? { project: input.project } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
    };
    const all = this.load();
    all.push(record);
    this.save(all);
    return record;
  }

  get(id: string): DecisionRecord | undefined {
    return this.load().find((r) => r.id === id);
  }

  getByRef(ref: string): DecisionRecord | undefined {
    return this.load().find((r) => r.embedding_ref === ref);
  }

  /** Elimina una decisión por id. Devuelve true si existía. */
  remove(id: string): boolean {
    const all = this.load();
    const next = all.filter((r) => r.id !== id);
    if (next.length === all.length) return false;
    this.save(next);
    return true;
  }

  all(): DecisionRecord[] {
    return this.load();
  }
}
