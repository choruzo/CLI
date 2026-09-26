import { existsSync, readFileSync, renameSync } from 'fs';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('memory');

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function yyyymmdd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Esquema de una entrada en disco. Los campos desconocidos se ignoran al leer. */
const DecisionRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string(),
  type: z.enum([
    'architectural',
    'tooling',
    'convention',
    'bug_fix',
    'security',
    'user_preference',
  ]),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  importance: z.enum(['low', 'medium', 'high']),
  embedding_ref: z.string().min(1),
  project: z.string().optional(),
  source: z.enum(['agent', 'auto']).optional(),
  session_id: z.string().optional(),
});

/**
 * El fichero no se puede reescribir sin perder datos: su forma no es la de v1
 * (un array) y no está dañado, sino escrito por un Stratum más nuevo.
 */
export class DecisionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionStoreError';
  }
}

type ReadOutcome =
  | { kind: 'ok'; entries: unknown[] }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'newer'; version: unknown };

/**
 * DecisionStore — Capa 2. CRUD sobre `decisions.json`.
 *
 * Es la **fuente de verdad** de la memoria a largo plazo; el índice vectorial
 * es un derivado reconstruible, así que ninguna ruta puede sobrescribirlo a
 * ciegas:
 *
 * - Leer nunca lanza: un fichero ausente, dañado o de un Stratum más nuevo se
 *   ve como `[]` (la memoria es best-effort) y lo dañado se avisa.
 * - Escribir parte **siempre** del contenido crudo recién leído. Las entradas
 *   que no validan (una versión más nueva con un `type` que esta no conoce) se
 *   conservan tal cual; solo se ocultan a la lectura.
 * - Un fichero dañado se aparta a `decisions.json.corrupt-<fecha>` antes de
 *   escribir el nuevo, nunca se pisa. Uno de un Stratum más nuevo (`{
 *   schemaVersion, … }` en vez de un array) no se toca: la escritura lanza.
 * - Escritura atómica con temporal único por proceso (`writeFileAtomic`).
 *
 * El formato sigue siendo un array sin `schemaVersion` a propósito: un Stratum
 * anterior leería cualquier otra forma como vacía y la reescribiría.
 */
export class DecisionStore {
  /** Para avisar una sola vez por fichero dañado, no en cada lectura. */
  private warnedCorrupt = false;

  constructor(private readonly file: string) {}

  /** Genera un id `dec_YYYYMMDD_<nanoid6>` sin leer el JSON previo (§5). */
  static generateId(now: Date = new Date()): string {
    return `dec_${yyyymmdd(now)}_${nano6()}`;
  }

  private readRaw(): ReadOutcome {
    if (!existsSync(this.file)) return { kind: 'ok', entries: [] };
    // Un error de E/S (permisos, EBUSY) sí lanza: no dice nada de si el fichero
    // está dañado, y apartarlo por eso sería perder la memoria por un antivirus.
    const raw = readFileSync(this.file, 'utf-8');
    if (!raw.trim()) return { kind: 'ok', entries: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { kind: 'corrupt', reason: `JSON inválido (${(err as Error).message})` };
    }
    if (Array.isArray(parsed)) return { kind: 'ok', entries: parsed };
    if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
      return { kind: 'newer', version: (parsed as { schemaVersion: unknown }).schemaVersion };
    }
    return { kind: 'corrupt', reason: 'no es una lista de decisiones' };
  }

  load(): DecisionRecord[] {
    let outcome: ReadOutcome;
    try {
      outcome = this.readRaw();
    } catch (err) {
      log.warn('decisions read failed', { file: this.file, err });
      return [];
    }
    if (outcome.kind === 'corrupt') {
      if (!this.warnedCorrupt) {
        this.warnedCorrupt = true;
        log.warn('decisions file is corrupt; it will be set aside on the next write', {
          file: this.file,
          reason: outcome.reason,
        });
      }
      return [];
    }
    if (outcome.kind === 'newer') return [];
    const records: DecisionRecord[] = [];
    for (const entry of outcome.entries) {
      const parsed = DecisionRecordSchema.safeParse(entry);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  /**
   * Lee el contenido crudo para modificarlo. Aparta un fichero dañado y parte
   * de una lista vacía; lanza con uno de un Stratum más nuevo.
   */
  private entriesForWrite(): unknown[] {
    const outcome = this.readRaw();
    if (outcome.kind === 'ok') return outcome.entries;
    if (outcome.kind === 'newer') {
      throw new DecisionStoreError(
        `${this.file} lo escribió un Stratum más nuevo (schemaVersion ${String(outcome.version)}); ` +
          'no se modifica. Actualiza Stratum para guardar decisiones.',
      );
    }
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(this.file, aside);
    this.warnedCorrupt = false;
    log.warn('corrupt decisions file set aside', {
      file: this.file,
      movedTo: aside,
      reason: outcome.reason,
    });
    return [];
  }

  private writeEntries(entries: unknown[]): void {
    writeFileAtomic(this.file, JSON.stringify(entries, null, 2));
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
    const entries = this.entriesForWrite();
    entries.push(record);
    this.writeEntries(entries);
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
    const entries = this.entriesForWrite();
    const next = entries.filter((e) => !(isObject(e) && e.id === id));
    if (next.length === entries.length) return false;
    this.writeEntries(next);
    return true;
  }

  all(): DecisionRecord[] {
    return this.load();
  }
}
