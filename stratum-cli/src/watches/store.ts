/**
 * M22 — almacén de los vigilantes del `companion`
 * (`~/.stratum/companion/watches.json`, PRD de Dot §23.11, M22 parte 1).
 *
 * Mismas reglas que el resto del estado en disco (como `reminders/store.ts`):
 *  - escritura atómica, Zod al leer y `schemaVersion`;
 *  - un fichero más nuevo, ilegible o que no valida deja el almacén en solo
 *    lectura: nunca se reescribe ni se borra, y el planificador no evalúa nada;
 *  - `passthrough` en la raíz y en cada vigilante, para no perder campos de una
 *    versión compatible al reescribir;
 *  - solo lo escribe el daemon.
 *
 * Con cada vigilante va su último estado (`state`), para que reiniciar el daemon
 * con la condición aún cumplida no vuelva a avisar. Se escribe solo cuando el
 * estado cambia, no en cada evaluación.
 *
 * Los argumentos y el nombre los escribió la persona (o el agente): no van a los logs.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';
import { WATCH_LIMITS } from '../protocol/index.js';
import { WatchConditionSchema, type WatchCondition } from './condition.js';
import { INITIAL_WATCH_STATE, type WatchState } from './engine.js';
import type { WatchDefinition } from './define.js';

const log = getLogger('watches');

export const WATCHES_SCHEMA_VERSION = 1;
export const WATCHES_FILE = 'watches.json';

export function watchesFile(companionDir: string): string {
  return join(companionDir, WATCHES_FILE);
}

export type WatchStoreErrorCode = 'invalid' | 'not-found' | 'read-only';

export class WatchStoreError extends Error {
  readonly code: WatchStoreErrorCode;
  constructor(code: WatchStoreErrorCode, message: string) {
    super(message);
    this.name = 'WatchStoreError';
    this.code = code;
  }
}

export type WatchStatus = 'active' | 'paused';

export interface StoredWatch {
  id: string;
  name: string;
  connector: string;
  check: string;
  args: Record<string, string | number | boolean>;
  condition: WatchCondition;
  intervalSec: number;
  cooldownMinutes: number;
  notifyResolved: boolean;
  status: WatchStatus;
  origin: 'agent' | 'person';
  createdAt: number;
  state: WatchState;
}

const nullableTime = z.number().int().nullable();

const StateSchema = z
  .object({
    firing: z.boolean(),
    pendingSince: nullableTime,
    reference: z.string().max(200).nullable(),
    lastFiredAt: nullableTime,
    failures: z.number().int().min(0),
    failingNotified: z.boolean(),
    suspendedNotified: z.boolean(),
  })
  .passthrough();

const StoredWatchSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(WATCH_LIMITS.nameChars),
    connector: z.string().min(1),
    check: z.string().min(1),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    condition: WatchConditionSchema,
    intervalSec: z.number().int().min(60),
    cooldownMinutes: z.number().int().min(0).max(WATCH_LIMITS.maxCooldownMinutes),
    notifyResolved: z.boolean(),
    status: z.enum(['active', 'paused']),
    origin: z.enum(['agent', 'person']),
    createdAt: z.number().int(),
    state: StateSchema,
  })
  .passthrough();

const WatchesFileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    watches: z.array(StoredWatchSchema),
  })
  .passthrough();

type StoredFile = z.infer<typeof WatchesFileSchema>;

const nano10 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function copy(w: StoredWatch): StoredWatch {
  return structuredClone(w);
}

function sameState(a: WatchState, b: WatchState): boolean {
  return (
    a.firing === b.firing &&
    a.pendingSince === b.pendingSince &&
    a.reference === b.reference &&
    a.lastFiredAt === b.lastFiredAt &&
    a.failures === b.failures &&
    a.failingNotified === b.failingNotified &&
    a.suspendedNotified === b.suspendedNotified
  );
}

export class WatchStore {
  private readonly file: string;
  private readonly newId: () => string;
  private watches: StoredWatch[] = [];
  private root: StoredFile | null = null;
  private _readOnly = false;
  private _loadProblem: 'newer' | 'unreadable' | 'invalid' | null = null;

  constructor(file: string, opts: { newId?: () => string } = {}) {
    this.file = file;
    this.newId = opts.newId ?? (() => `wat_${nano10()}`);
  }

  get readOnly(): boolean {
    return this._readOnly;
  }

  get loadProblem(): 'newer' | 'unreadable' | 'invalid' | null {
    return this._loadProblem;
  }

  /** Lee del disco (síncrono). Sin fichero → vacío y escribible. */
  load(): void {
    this.watches = [];
    this.root = null;
    this._readOnly = false;
    this._loadProblem = null;
    if (!existsSync(this.file)) return;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (err) {
      this.block('unreadable', 'watches file is unreadable; it will not be modified', err);
      return;
    }
    const check = checkSchemaVersion(
      (raw as { schemaVersion?: unknown } | null)?.schemaVersion,
      WATCHES_SCHEMA_VERSION,
    );
    if (!check.ok) {
      this.block(
        check.reason === 'newer' ? 'newer' : 'invalid',
        check.reason === 'newer'
          ? 'watches file has a newer schemaVersion; it will not be modified'
          : 'watches file has an invalid schemaVersion; it will not be modified',
      );
      return;
    }
    const parsed = WatchesFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.block('invalid', 'watches file failed validation; it will not be modified');
      return;
    }
    this.root = parsed.data;
    this.watches = parsed.data.watches as StoredWatch[];
  }

  /** Todos, por fecha de creación. */
  list(): StoredWatch[] {
    return [...this.watches]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(copy);
  }

  get(id: string): StoredWatch | undefined {
    const w = this.watches.find((x) => x.id === id);
    return w ? copy(w) : undefined;
  }

  /** Un vigilante ya validado (`define.ts`). */
  add(def: WatchDefinition, now: number): StoredWatch {
    this.assertWritable();
    if (this.watches.length >= WATCH_LIMITS.watches) {
      throw new WatchStoreError(
        'invalid',
        `There are already ${WATCH_LIMITS.watches} watches; remove one first.`,
      );
    }
    let id = this.newId();
    while (this.watches.some((w) => w.id === id)) id = this.newId();
    const watch: StoredWatch = {
      id,
      ...structuredClone(def),
      status: 'active',
      createdAt: now,
      state: { ...INITIAL_WATCH_STATE },
    };
    this.persist([...this.watches, watch]);
    return copy(watch);
  }

  /**
   * Pausar o reanudar. Reanudar parte de cero en la cuenta de «durante N
   * minutos» y en los avisos de fallo, pero conserva si estaba saltado.
   */
  setStatus(id: string, status: WatchStatus): StoredWatch {
    this.assertWritable();
    const current = this.require(id);
    const next: StoredWatch = {
      ...current,
      status,
      state: {
        ...current.state,
        pendingSince: null,
        failures: 0,
        failingNotified: false,
        suspendedNotified: false,
      },
    };
    this.persist(this.watches.map((w) => (w.id === id ? next : w)));
    return copy(next);
  }

  remove(id: string): StoredWatch {
    this.assertWritable();
    const current = this.require(id);
    this.persist(this.watches.filter((w) => w.id !== id));
    return copy(current);
  }

  /**
   * Guarda el estado nuevo de una evaluación, solo si cambió. Devuelve si
   * escribió. Un vigilante que ya no existe (se borró a mitad) se ignora.
   */
  saveState(id: string, state: WatchState): boolean {
    this.assertWritable();
    const current = this.watches.find((w) => w.id === id);
    if (!current || sameState(current.state, state)) return false;
    const next: StoredWatch = { ...current, state: { ...current.state, ...state } };
    this.persist(this.watches.map((w) => (w.id === id ? next : w)));
    return true;
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  private require(id: string): StoredWatch {
    const current = this.watches.find((w) => w.id === id);
    if (!current) throw new WatchStoreError('not-found', `Watch "${id}" not found.`);
    return current;
  }

  private block(problem: 'newer' | 'unreadable' | 'invalid', msg: string, err?: unknown): void {
    this._readOnly = true;
    this._loadProblem = problem;
    // Solo el nombre del error: el mensaje de `JSON.parse` arrastra un trozo del fichero.
    log.warn(msg, {
      path: this.file,
      ...(err instanceof Error ? { error: err.name } : {}),
    });
  }

  private assertWritable(): void {
    if (this._readOnly) {
      throw new WatchStoreError(
        'read-only',
        `Watches file ${this.file} cannot be modified (${this._loadProblem}).`,
      );
    }
  }

  /** Escribe y solo entonces adopta el nuevo estado. */
  private persist(watches: StoredWatch[]): void {
    const root = { ...(this.root ?? {}), schemaVersion: WATCHES_SCHEMA_VERSION, watches };
    writeFileAtomic(this.file, JSON.stringify(root, null, 2) + '\n');
    this.root = root as StoredFile;
    this.watches = watches;
  }
}
