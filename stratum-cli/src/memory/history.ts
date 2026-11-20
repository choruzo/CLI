/**
 * Historial de los cambios que el propio agente hace en su memoria: corregir un
 * recuerdo que ya no es cierto o retirar uno obsoleto (`memory/revision.ts`).
 *
 * Un cambio nunca borra nada sin dejar rastro: guarda el recuerdo **entero tal
 * como estaba**, para poder deshacerlo. Vive junto a `decisions.json`
 * (`memory-history.json`), uno por memoria, y sigue las reglas de todo estado
 * en disco: escritura atómica, Zod al leer, uno dañado se aparta y uno de un
 * Stratum más nuevo (`schemaVersion` mayor) no se toca.
 *
 * `decisions.json` no cambia de formato: un recuerdo retirado no está en él,
 * así que el índice, el recall, el índice del prompt, las páginas `wiki/` y el
 * protocolo no tienen que saber nada de esto.
 */
import { existsSync, readFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { resolveMemoryPaths } from '../config/paths.js';
import type { StratumConfig } from '../config/schema.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('memory.history');

export const MEMORY_HISTORY_SCHEMA_VERSION = 1;

/** Cuántos cambios se conservan: los más antiguos se descartan al escribir. */
export const MAX_HISTORY_ENTRIES = 200;

const nano6 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 6);

/** Quién hizo el cambio. Solo el agente, por ahora; dreaming y la persona vendrán después. */
const bySchema = z.enum(['agent']);

/** Lo que identifica el estado que dejó un cambio, para saber al deshacer si se ha tocado después. */
const afterSchema = z.object({
  title: z.string(),
  content: z.string(),
  summary: z.string().optional(),
  updatedAt: z.string().optional(),
});

const entrySchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  action: z.enum(['corrected', 'retired']),
  decisionId: z.string().min(1),
  by: bySchema,
  reason: z.string(),
  sessionId: z.string().optional(),
  /** El recuerdo entero, tal como estaba antes del cambio. */
  before: z.record(z.unknown()),
  /** Solo en `corrected`. */
  after: afterSchema.optional(),
  undoneAt: z.string().optional(),
});

export type MemoryChange = z.infer<typeof entrySchema>;
export type MemoryChangeDraft = Omit<MemoryChange, 'id' | 'at'>;

const fileSchema = z.object({
  schemaVersion: z.number().int(),
  changes: z.array(z.unknown()),
});

export class MemoryHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryHistoryError';
  }
}

export function newChangeId(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `chg_${d}_${nano6()}`;
}

type Outcome =
  | { kind: 'ok'; entries: unknown[] }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'newer'; version: number };

export class MemoryHistoryStore {
  private warnedCorrupt = false;

  constructor(readonly file: string) {}

  private read(): Outcome {
    if (!existsSync(this.file)) return { kind: 'ok', entries: [] };
    const raw = readFileSync(this.file, 'utf-8');
    if (!raw.trim()) return { kind: 'ok', entries: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { kind: 'corrupt', reason: `JSON inválido (${(err as Error).message})` };
    }
    const file = fileSchema.safeParse(parsed);
    if (!file.success) return { kind: 'corrupt', reason: 'no es una lista de cambios' };
    if (file.data.schemaVersion > MEMORY_HISTORY_SCHEMA_VERSION) {
      return { kind: 'newer', version: file.data.schemaVersion };
    }
    return { kind: 'ok', entries: file.data.changes };
  }

  /** Los cambios que validan, del más reciente al más antiguo. Leer nunca lanza. */
  list(): MemoryChange[] {
    let outcome: Outcome;
    try {
      outcome = this.read();
    } catch (err) {
      log.warn('memory history read failed', { file: this.file, err });
      return [];
    }
    if (outcome.kind === 'corrupt') {
      if (!this.warnedCorrupt) {
        this.warnedCorrupt = true;
        log.warn('memory history is corrupt; it will be set aside on the next write', {
          file: this.file,
          reason: outcome.reason,
        });
      }
      return [];
    }
    if (outcome.kind === 'newer') return [];
    return outcome.entries
      .flatMap((e) => {
        const c = entrySchema.safeParse(e);
        return c.success ? [c.data] : [];
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  get(id: string): MemoryChange | undefined {
    return this.list().find((c) => c.id === id);
  }

  private entriesForWrite(): unknown[] {
    const outcome = this.read();
    if (outcome.kind === 'ok') return outcome.entries;
    if (outcome.kind === 'newer') {
      throw new MemoryHistoryError(
        `${this.file} lo escribió un Stratum más nuevo (schemaVersion ${outcome.version}); no se modifica.`,
      );
    }
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(this.file, aside);
    this.warnedCorrupt = false;
    log.warn('corrupt memory history set aside', { file: this.file, movedTo: aside });
    return [];
  }

  /** Recorta a los `MAX_HISTORY_ENTRIES` más recientes; lo que no valida se conserva al final. */
  private write(entries: unknown[]): void {
    const valid: MemoryChange[] = [];
    const other: unknown[] = [];
    for (const e of entries) {
      const c = entrySchema.safeParse(e);
      if (c.success) valid.push(c.data);
      else other.push(e);
    }
    valid.sort((a, b) => b.at.localeCompare(a.at));
    writeFileAtomic(
      this.file,
      JSON.stringify(
        {
          schemaVersion: MEMORY_HISTORY_SCHEMA_VERSION,
          changes: [...valid.slice(0, MAX_HISTORY_ENTRIES), ...other],
        },
        null,
        2,
      ),
    );
  }

  /**
   * Comprueba que se puede escribir antes de tocar la memoria: con un fichero
   * de un Stratum más nuevo, el cambio no se hace (sin historial no hay
   * deshacer). Lanza `MemoryHistoryError`.
   */
  assertWritable(): void {
    const outcome = this.read();
    if (outcome.kind === 'newer') {
      throw new MemoryHistoryError(
        `${this.file} lo escribió un Stratum más nuevo (schemaVersion ${outcome.version}); no se modifica.`,
      );
    }
  }

  add(draft: MemoryChangeDraft, now: Date = new Date()): MemoryChange {
    const change: MemoryChange = { ...draft, id: newChangeId(now), at: now.toISOString() };
    const parsed = entrySchema.parse(change);
    this.write([...this.entriesForWrite(), parsed]);
    return parsed;
  }

  /** Marca un cambio como deshecho. `undefined` si no está o ya estaba deshecho. */
  markUndone(id: string, now: Date = new Date()): MemoryChange | undefined {
    const entries = this.entriesForWrite();
    let marked: MemoryChange | undefined;
    const next = entries.map((e) => {
      const c = entrySchema.safeParse(e);
      if (!c.success || c.data.id !== id || c.data.undoneAt) return e;
      marked = { ...c.data, undoneAt: now.toISOString() };
      return marked;
    });
    if (!marked) return undefined;
    this.write(next);
    return marked;
  }
}

/** El historial de una memoria: junto a su `decisions.json`. */
export function openMemoryHistory(config: StratumConfig): MemoryHistoryStore {
  const dir = dirname(resolveMemoryPaths(config).decisionsFile);
  return new MemoryHistoryStore(join(dir, 'memory-history.json'));
}
