/**
 * M21 — almacén de los recordatorios del `companion`
 * (`~/.stratum/companion/reminders.json`, `docs/protocol.md` §30).
 *
 * Mismas reglas que el resto del estado en disco:
 *  - escritura atómica (`writeFileAtomic`, que crea el directorio padre);
 *  - Zod al leer, con `schemaVersion`;
 *  - un fichero de una versión más nueva, ilegible o que no valida deja el
 *    almacén en solo lectura: nunca se reescribe ni se borra;
 *  - `passthrough` en la raíz y en cada recordatorio, para no perder campos de
 *    una versión compatible al reescribir.
 *
 * El texto del aviso lo escribió la persona: **nunca** va a los logs.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { writeFileAtomic } from '../config/writer.js';
import { checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';
import { REMINDER_LIMITS, type ProtocolReminder } from '../protocol/index.js';

const log = getLogger('reminders');

/** Versión del formato de `reminders.json` que entiende este core. */
export const REMINDERS_SCHEMA_VERSION = 1;
export const REMINDERS_FILE = 'reminders.json';

export function remindersFile(companionDir: string): string {
  return join(companionDir, REMINDERS_FILE);
}

/** Quién lo creó: la persona (CLI, Dot) o el `companion` con su tool. Solo procedencia. */
export type ReminderOrigin = ProtocolReminder['origin'];

export interface NewReminder {
  text: string;
  /** Cuándo vence (ms). */
  dueAt: number;
  origin: ReminderOrigin;
}

export type ReminderStoreErrorCode = 'invalid' | 'not-found' | 'read-only';

export class ReminderStoreError extends Error {
  readonly code: ReminderStoreErrorCode;
  constructor(code: ReminderStoreErrorCode, message: string) {
    super(message);
    this.name = 'ReminderStoreError';
    this.code = code;
  }
}

// ─── Esquemas ────────────────────────────────────────────────────────────────

/** Lo que valida el usuario al crear uno. */
const NewReminderSchema = z.object({
  text: z.string().trim().min(1).max(REMINDER_LIMITS.textChars),
  dueAt: z.number().int(),
  origin: z.enum(['agent', 'person']),
});

/** Lo que se lee del disco: la forma ya normalizada, con campos desconocidos preservados. */
const StoredReminderSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).max(REMINDER_LIMITS.textChars),
    dueAt: z.number().int(),
    createdAt: z.number().int(),
    origin: z.enum(['agent', 'person']),
    status: z.enum(['pending', 'delivered', 'cancelled']),
    endedAt: z.number().int().optional(),
    late: z.boolean().optional(),
  })
  .passthrough();

const RemindersFileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    reminders: z.array(StoredReminderSchema),
  })
  .passthrough();

type StoredReminder = z.infer<typeof StoredReminderSchema>;
type StoredFile = z.infer<typeof RemindersFileSchema>;

const nano10 = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function describeZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  const path = issue.path.join('.');
  return path ? `Invalid ${path}: ${issue.message}` : `Invalid reminder: ${issue.message}`;
}

function copyReminder(r: StoredReminder): ProtocolReminder {
  return structuredClone(r) as ProtocolReminder;
}

/** Cuándo dejó de estar pendiente (o cuándo venció, si el fichero no lo dice). */
function endedAtOf(r: StoredReminder): number {
  return r.endedAt ?? r.dueAt;
}

/** Los terminados caducan: se listan durante `keepEndedMs` y después se purgan al escribir. */
function stillListed(r: StoredReminder, now: number): boolean {
  return r.status === 'pending' || endedAtOf(r) >= now - REMINDER_LIMITS.keepEndedMs;
}

function purge(reminders: StoredReminder[], now: number): StoredReminder[] {
  return reminders.filter((r) => stillListed(r, now));
}

// ─── Almacén ─────────────────────────────────────────────────────────────────

export class ReminderStore {
  private readonly file: string;
  private readonly newId: () => string;
  private reminders: StoredReminder[] = [];
  /** Raíz parseada del fichero (con campos desconocidos), sobre la que se reescribe. */
  private root: StoredFile | null = null;
  private _readOnly = false;
  private _loadProblem: 'newer' | 'unreadable' | 'invalid' | null = null;

  constructor(file: string, opts: { newId?: () => string } = {}) {
    this.file = file;
    this.newId = opts.newId ?? (() => `rem_${nano10()}`);
  }

  get readOnly(): boolean {
    return this._readOnly;
  }

  get loadProblem(): 'newer' | 'unreadable' | 'invalid' | null {
    return this._loadProblem;
  }

  /** Lee del disco (síncrono). Sin fichero → vacío y escribible. */
  load(): void {
    this.reminders = [];
    this.root = null;
    this._readOnly = false;
    this._loadProblem = null;
    if (!existsSync(this.file)) return;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (err) {
      this.block('unreadable', 'reminders file is unreadable; it will not be modified', err);
      return;
    }
    const check = checkSchemaVersion(
      (raw as { schemaVersion?: unknown } | null)?.schemaVersion,
      REMINDERS_SCHEMA_VERSION,
    );
    if (!check.ok) {
      this.block(
        check.reason === 'newer' ? 'newer' : 'invalid',
        check.reason === 'newer'
          ? 'reminders file has a newer schemaVersion; it will not be modified'
          : 'reminders file has an invalid schemaVersion; it will not be modified',
      );
      return;
    }
    const parsed = RemindersFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.block('invalid', 'reminders file failed validation; it will not be modified');
      return;
    }
    this.root = parsed.data;
    this.reminders = parsed.data.reminders;
  }

  /** Pendientes y terminados de la ventana (`keepEndedMs`), por `dueAt`. */
  list(now: number): ProtocolReminder[] {
    return this.reminders
      .filter((r) => stillListed(r, now))
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
      .map(copyReminder);
  }

  /** Lo que vence, para el planificador: pendientes, por `dueAt`. */
  pending(): ProtocolReminder[] {
    return this.reminders
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
      .map(copyReminder);
  }

  add(input: NewReminder, now: number): ProtocolReminder {
    this.assertWritable();
    const parsed = NewReminderSchema.safeParse(input);
    if (!parsed.success) throw new ReminderStoreError('invalid', describeZodError(parsed.error));
    const v = parsed.data;

    const lead = v.dueAt - now;
    if (lead < REMINDER_LIMITS.minLeadMs) {
      throw new ReminderStoreError(
        'invalid',
        'Invalid dueAt: a reminder has to be at least 1 minute away.',
      );
    }
    if (lead > REMINDER_LIMITS.maxLeadMs) {
      throw new ReminderStoreError(
        'invalid',
        'Invalid dueAt: a reminder cannot be more than a year away.',
      );
    }
    const waiting = this.reminders.filter((r) => r.status === 'pending').length;
    if (waiting >= REMINDER_LIMITS.pending) {
      throw new ReminderStoreError(
        'invalid',
        `Invalid pending: there are already ${REMINDER_LIMITS.pending} pending reminders; cancel one first.`,
      );
    }

    let id = this.newId();
    while (this.reminders.some((r) => r.id === id)) id = this.newId();

    const reminder: StoredReminder = {
      id,
      text: v.text,
      dueAt: v.dueAt,
      createdAt: now,
      origin: v.origin,
      status: 'pending',
    };
    this.persist([...purge(this.reminders, now), reminder]);
    return copyReminder(reminder);
  }

  /** Cancela uno pendiente. Cancelar solo resta: el aviso no se entregará. */
  cancel(id: string, now: number): ProtocolReminder {
    this.assertWritable();
    const current = this.reminders.find((r) => r.id === id);
    if (!current) throw new ReminderStoreError('not-found', `Reminder "${id}" not found.`);
    if (current.status !== 'pending') {
      throw new ReminderStoreError(
        'invalid',
        `Invalid status: reminder "${id}" is not pending anymore.`,
      );
    }
    const next: StoredReminder = { ...current, status: 'cancelled', endedAt: now };
    this.persist(
      purge(
        this.reminders.map((r) => (r.id === id ? next : r)),
        now,
      ),
    );
    return copyReminder(next);
  }

  /** Lo marca entregado. El planificador lo hace **antes** de entregar: nunca dos veces. */
  markDelivered(id: string, now: number, late: boolean): ProtocolReminder {
    this.assertWritable();
    const current = this.reminders.find((r) => r.id === id);
    if (!current) throw new ReminderStoreError('not-found', `Reminder "${id}" not found.`);
    if (current.status !== 'pending') {
      throw new ReminderStoreError(
        'invalid',
        `Invalid status: reminder "${id}" is not pending anymore.`,
      );
    }
    const next: StoredReminder = { ...current, status: 'delivered', endedAt: now };
    if (late) next.late = true;
    this.persist(
      purge(
        this.reminders.map((r) => (r.id === id ? next : r)),
        now,
      ),
    );
    return copyReminder(next);
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  private block(problem: 'newer' | 'unreadable' | 'invalid', msg: string, err?: unknown): void {
    this._readOnly = true;
    this._loadProblem = problem;
    // Solo el nombre del error: el de un `JSON.parse` de Node arrastra un trozo
    // del fichero, y con él el texto de un aviso. Ese texto no va a los logs.
    log.warn(msg, {
      path: this.file,
      ...(err instanceof Error ? { error: err.name } : {}),
    });
  }

  private assertWritable(): void {
    if (this._readOnly) {
      throw new ReminderStoreError(
        'read-only',
        `Reminders file ${this.file} cannot be modified (${this._loadProblem}).`,
      );
    }
  }

  /** Escribe y solo entonces adopta el nuevo estado: un fallo de disco no deja el almacén a medias. */
  private persist(reminders: StoredReminder[]): void {
    const root = { ...(this.root ?? {}), schemaVersion: REMINDERS_SCHEMA_VERSION, reminders };
    writeFileAtomic(this.file, JSON.stringify(root, null, 2) + '\n');
    this.root = root as StoredFile;
    this.reminders = reminders;
  }
}
