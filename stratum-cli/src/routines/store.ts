/**
 * Almacén de rutinas del asistente: `~/.stratum/companion/routines.json` (M16).
 *
 * Mismas reglas que el resto del estado en disco:
 *  - escritura atómica (`writeFileAtomic`, que crea el directorio padre);
 *  - Zod al leer, con `schemaVersion`;
 *  - un fichero de una versión más nueva, ilegible o que no valida deja el
 *    almacén en solo lectura: nunca se reescribe ni se borra;
 *  - `passthrough` en la raíz y en cada rutina, para no perder campos de una
 *    versión compatible al reescribir.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';
import { parseSchedule } from './schedule.js';

const log = getLogger('routines');

/** Versión del formato de `routines.json` que entiende este core. */
export const ROUTINES_SCHEMA_VERSION = 1;
export const ROUTINES_FILE = 'routines.json';

export function routinesFile(companionDir: string): string {
  return join(companionDir, ROUTINES_FILE);
}

export interface RoutineLimits {
  maxIterations?: number;
  timeoutMinutes?: number;
}

export interface Routine {
  /** `rt_` + 10 caracteres [0-9a-z]. */
  id: string;
  name: string;
  /** Texto del horario, ya validado con `parseSchedule`. */
  schedule: string;
  prompt: string;
  model?: string;
  enabled: boolean;
  limits?: RoutineLimits;
  /** ISO 8601; es el anchor de los intervalos. */
  createdAt: string;
  /**
   * Quién la creó: la persona (CLI, Dot) o el agente con `propose_routine`, que
   * una persona aprobó. Solo procedencia. Ausente en las de antes de saberlo.
   */
  origin?: RoutineOrigin;
}

export type RoutineOrigin = 'person' | 'agent';

export interface NewRoutine {
  name: string;
  schedule: string;
  prompt: string;
  model?: string;
  enabled?: boolean;
  limits?: RoutineLimits;
  origin?: RoutineOrigin;
}

/** La procedencia no se edita. */
export type RoutinePatch = Partial<
  Pick<Routine, 'name' | 'schedule' | 'prompt' | 'model' | 'enabled' | 'limits'>
>;

export type RoutineStoreErrorCode = 'invalid' | 'not-found' | 'read-only' | 'duplicate-name';

export class RoutineStoreError extends Error {
  readonly code: RoutineStoreErrorCode;
  constructor(code: RoutineStoreErrorCode, message: string) {
    super(message);
    this.name = 'RoutineStoreError';
    this.code = code;
  }
}

// ─── Esquemas ────────────────────────────────────────────────────────────────

const LimitsSchema = z
  .object({
    maxIterations: z.number().int().min(1).max(200).optional(),
    timeoutMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .strict();

// Lo que valida el usuario (add/update).
const NameSchema = z.string().trim().min(1).max(80);
const PromptSchema = z.string().trim().min(1).max(8000);
const ScheduleSchema = z
  .string()
  .trim()
  .superRefine((text, ctx) => {
    const r = parseSchedule(text);
    if (!r.ok) ctx.addIssue({ code: 'custom', message: r.error });
  });
const ModelSchema = z.string().trim();

const NewRoutineSchema = z.object({
  name: NameSchema,
  schedule: ScheduleSchema,
  prompt: PromptSchema,
  model: ModelSchema.optional(),
  enabled: z.boolean().optional(),
  limits: LimitsSchema.optional(),
  origin: z.enum(['person', 'agent']).optional(),
});
const PatchSchema = NewRoutineSchema.omit({ origin: true }).partial();

// Lo que se lee del disco: forma ya normalizada, con campos desconocidos preservados.
const StoredRoutineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    schedule: z.string().min(1),
    prompt: z.string().min(1),
    model: z.string().optional(),
    enabled: z.boolean(),
    limits: LimitsSchema.optional(),
    createdAt: z.string().min(1),
    origin: z.enum(['person', 'agent']).optional(),
  })
  .passthrough();

const RoutinesFileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    routines: z.array(StoredRoutineSchema),
  })
  .passthrough();

type StoredRoutine = z.infer<typeof StoredRoutineSchema>;
type StoredFile = z.infer<typeof RoutinesFileSchema>;

const nano10 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function describeZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = issue.path.join('.');
  return path ? `Invalid ${path}: ${issue.message}` : `Invalid routine: ${issue.message}`;
}

function copyRoutine(r: StoredRoutine): Routine {
  return structuredClone(r) as Routine;
}

// ─── Almacén ─────────────────────────────────────────────────────────────────

export class RoutineStore {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private routines: StoredRoutine[] = [];
  /** Raíz parseada del fichero (con campos desconocidos), sobre la que se reescribe. */
  private root: StoredFile | null = null;
  private _readOnly = false;
  private _loadProblem: 'newer' | 'unreadable' | 'invalid' | null = null;

  constructor(file: string, opts: { now?: () => Date; newId?: () => string } = {}) {
    this.file = file;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => `rt_${nano10()}`);
  }

  get readOnly(): boolean {
    return this._readOnly;
  }

  get loadProblem(): 'newer' | 'unreadable' | 'invalid' | null {
    return this._loadProblem;
  }

  /** Lee del disco (síncrono). Sin fichero → vacío y escribible. */
  load(): void {
    this.routines = [];
    this.root = null;
    this._readOnly = false;
    this._loadProblem = null;
    if (!existsSync(this.file)) return;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (err) {
      this.block('unreadable', 'routines file is unreadable; it will not be modified', err);
      return;
    }
    const check = checkSchemaVersion(
      (raw as { schemaVersion?: unknown } | null)?.schemaVersion,
      ROUTINES_SCHEMA_VERSION,
    );
    if (!check.ok) {
      this.block(
        check.reason === 'newer' ? 'newer' : 'invalid',
        check.reason === 'newer'
          ? 'routines file has a newer schemaVersion; it will not be modified'
          : 'routines file has an invalid schemaVersion; it will not be modified',
      );
      return;
    }
    const parsed = RoutinesFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.block('invalid', 'routines file failed validation; it will not be modified');
      return;
    }
    this.root = parsed.data;
    this.routines = parsed.data.routines;
  }

  list(): Routine[] {
    return this.routines.map(copyRoutine);
  }

  get(id: string): Routine | undefined {
    const r = this.routines.find((x) => x.id === id);
    return r ? copyRoutine(r) : undefined;
  }

  add(input: NewRoutine): Routine {
    this.assertWritable();
    const parsed = NewRoutineSchema.safeParse(input);
    if (!parsed.success) throw new RoutineStoreError('invalid', describeZodError(parsed.error));
    const v = parsed.data;
    this.assertNameFree(v.name);

    let id = this.newId();
    while (this.routines.some((r) => r.id === id)) id = this.newId();

    const routine: StoredRoutine = {
      id,
      name: v.name,
      schedule: v.schedule,
      prompt: v.prompt,
      enabled: v.enabled ?? true,
      createdAt: this.now().toISOString(),
    };
    if (v.model) routine.model = v.model;
    if (v.limits) routine.limits = v.limits;
    if (v.origin) routine.origin = v.origin;

    this.persist([...this.routines, routine]);
    return copyRoutine(routine);
  }

  update(id: string, patch: RoutinePatch): Routine {
    this.assertWritable();
    const current = this.routines.find((r) => r.id === id);
    if (!current) throw new RoutineStoreError('not-found', `Routine "${id}" not found.`);
    // `id` y `createdAt` no se tocan aunque lleguen en el parche.
    const parsed = PatchSchema.safeParse(patch);
    if (!parsed.success) throw new RoutineStoreError('invalid', describeZodError(parsed.error));
    const v = parsed.data;
    if (v.name !== undefined) this.assertNameFree(v.name, id);

    const next: StoredRoutine = { ...current };
    if (v.name !== undefined) next.name = v.name;
    if (v.schedule !== undefined) next.schedule = v.schedule;
    if (v.prompt !== undefined) next.prompt = v.prompt;
    if (v.enabled !== undefined) next.enabled = v.enabled;
    // `model`/`limits` presentes en el parche con valor vacío o `undefined` los quitan.
    if ('model' in patch) {
      if (v.model) next.model = v.model;
      else delete next.model;
    }
    if ('limits' in patch) {
      if (v.limits) next.limits = v.limits;
      else delete next.limits;
    }

    this.persist(this.routines.map((r) => (r.id === id ? next : r)));
    return copyRoutine(next);
  }

  remove(id: string): Routine {
    this.assertWritable();
    const current = this.routines.find((r) => r.id === id);
    if (!current) throw new RoutineStoreError('not-found', `Routine "${id}" not found.`);
    this.persist(this.routines.filter((r) => r.id !== id));
    return copyRoutine(current);
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  private block(problem: 'newer' | 'unreadable' | 'invalid', msg: string, err?: unknown): void {
    this._readOnly = true;
    this._loadProblem = problem;
    log.warn(msg, { path: this.file, ...(err ? { err } : {}) });
  }

  private assertWritable(): void {
    if (this._readOnly) {
      throw new RoutineStoreError(
        'read-only',
        `Routines file ${this.file} cannot be modified (${this._loadProblem}).`,
      );
    }
  }

  private assertNameFree(name: string, exceptId?: string): void {
    const key = name.toLowerCase();
    if (this.routines.some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === key)) {
      throw new RoutineStoreError('duplicate-name', `A routine named "${name}" already exists.`);
    }
  }

  /** Escribe y solo entonces adopta el nuevo estado: un fallo de disco no deja el almacén a medias. */
  private persist(routines: StoredRoutine[]): void {
    const root = { ...(this.root ?? {}), schemaVersion: ROUTINES_SCHEMA_VERSION, routines };
    writeFileAtomic(this.file, JSON.stringify(root, null, 2) + '\n');
    this.root = root as StoredFile;
    this.routines = routines;
  }
}
