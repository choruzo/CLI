import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { z } from 'zod';
import type { SubagentPersist, SubagentResult, SubagentStatus } from '../agent/types.js';
import { SUBAGENT_SCHEMA_VERSION, checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent.subagent');

/** Cada cuánto el proceso dueño refresca `owner.heartbeatAt` mientras el hijo corre. */
export const SUBAGENT_HEARTBEAT_MS = 30_000;
/**
 * Sin latido durante este tiempo, el dueño se da por muerto aunque su pid
 * exista: cubre la reutilización de pids y los registros escritos desde otra
 * máquina (carpeta compartida), donde el pid no se puede comprobar.
 */
export const SUBAGENT_STALE_MS = 3 * 60_000;

/** Proceso que lanzó el subagente. Lo que permite distinguir huérfano de vivo. */
export interface SubagentOwner {
  pid: number;
  host: string;
  /** ISO 8601. Se refresca cada `SUBAGENT_HEARTBEAT_MS` mientras está `running`. */
  heartbeatAt: string;
}

/**
 * Fichero de subagente persistido (§12.16 / Hito 8B). Se escribe una marca
 * `running` justo antes de lanzar el hijo y el resultado terminal al terminar.
 * Si el proceso muere entre ambas, el registro queda `running` con un dueño
 * muerto, y al reanudar **su** sesión se detecta como huérfano — el padre debe
 * verificar el estado real antes de decidir (NO se reejecuta automáticamente).
 */
export interface SubagentFile {
  schemaVersion: number;
  id: string;
  /** Sesión del padre. `null` en registros anteriores a que existiera el campo. */
  sessionId: string | null;
  /** `null` en registros anteriores a que existiera el campo. */
  owner: SubagentOwner | null;
  profile: string;
  task: string;
  /** `running` mientras se ejecuta; un `SubagentStatus` terminal al terminar. */
  status: SubagentStatus | 'running';
  /** Ausente mientras `running` (y en `interrupted`); presente en estado terminal. */
  result: SubagentResult | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

const STATUSES = ['completed', 'failed', 'cancelled', 'budget_exceeded', 'interrupted'] as const;

/** Ids que genera `generateSubagentId`: nunca contienen separadores de ruta. */
const SUBAGENT_ID_RE = /^sub_[A-Za-z0-9_-]+$/;

const ResultSchema = z
  .object({
    id: z.string(),
    status: z.enum(STATUSES),
    summary: z.string(),
    filesChanged: z.array(
      z.object({ path: z.string(), action: z.enum(['created', 'modified', 'deleted']) }),
    ),
    usage: z.object({ iterations: z.number(), durationMs: z.number() }).passthrough(),
  })
  .passthrough();

const OwnerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  heartbeatAt: z.string(),
});

// `passthrough`: un campo que añada una versión compatible (misma schemaVersion)
// no se pierde al reescribir el registro.
const FileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    id: z.string().regex(SUBAGENT_ID_RE),
    sessionId: z.string().nullable().optional(),
    owner: OwnerSchema.nullable().optional(),
    profile: z.string(),
    task: z.string(),
    status: z.enum([...STATUSES, 'running']),
    result: ResultSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough()
  .superRefine((f, ctx) => {
    // El estado del registro y el del resultado no pueden contradecirse.
    if (f.status === 'running' && f.result !== null) {
      ctx.addIssue({ code: 'custom', message: 'running con resultado' });
    }
    if (f.status !== 'running' && f.status !== 'interrupted') {
      if (f.result === null) ctx.addIssue({ code: 'custom', message: 'terminal sin resultado' });
      else if (f.result.status !== f.status) {
        ctx.addIssue({ code: 'custom', message: 'estado distinto del resultado' });
      }
    }
  });

/** Lo que hay en disco para un nombre de fichero, sin lanzar nunca. */
export type SubagentInspection =
  | { kind: 'ok'; record: SubagentFile }
  | { kind: 'missing' }
  /** De un Stratum más nuevo: ni se interpreta, ni se reescribe, ni se borra. */
  | { kind: 'newer'; version: unknown }
  | { kind: 'corrupt'; reason: string };

/** Valida un JSON ya parseado. Puro, para los tests y para `inspect`. */
export function parseSubagentFile(raw: unknown, expectedId?: string): SubagentInspection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'corrupt', reason: 'no es un objeto' };
  }
  const version = checkSchemaVersion(
    (raw as { schemaVersion?: unknown }).schemaVersion,
    SUBAGENT_SCHEMA_VERSION,
  );
  if (!version.ok) {
    return version.reason === 'newer'
      ? { kind: 'newer', version: version.version }
      : { kind: 'corrupt', reason: `schemaVersion inválido: ${JSON.stringify(version.version)}` };
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'corrupt',
      reason: `${issue?.path.join('.') || '(raíz)'}: ${issue?.message ?? 'inválido'}`,
    };
  }
  if (expectedId !== undefined && parsed.data.id !== expectedId) {
    return { kind: 'corrupt', reason: `el id ${parsed.data.id} no coincide con el fichero` };
  }
  const d = parsed.data;
  return {
    kind: 'ok',
    record: {
      ...d,
      schemaVersion: version.version,
      sessionId: d.sessionId ?? null,
      owner: d.owner ?? null,
      result: d.result as SubagentResult | null,
    },
  };
}

// ---------------------------------------------------------------------------
// Vida del dueño
// ---------------------------------------------------------------------------

/** Contexto para decidir si el dueño de un registro sigue vivo. Inyectable en tests. */
export interface LivenessProbe {
  pid: number;
  host: string;
  now: number;
  pidAlive(pid: number): boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: existe pero es de otro usuario. Solo ESRCH significa que no existe.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function localProbe(): LivenessProbe {
  return { pid: process.pid, host: hostname(), now: Date.now(), pidAlive: processIsAlive };
}

/**
 * Estado del dueño de un registro `running`:
 *  - `alive`   — su proceso sigue ejecutándolo (o no se puede descartar);
 *  - `dead`    — huérfano: el proceso murió sin escribir el estado terminal;
 *  - `unknown` — registro anterior al campo `owner`: no se puede saber.
 *
 * Ante la duda, `alive`: dar por interrumpido un subagente que sigue corriendo
 * en otra terminal le haría al padre de esta sesión decidir sobre algo falso.
 */
export function ownerState(
  rec: Pick<SubagentFile, 'owner'>,
  probe: LivenessProbe,
): 'alive' | 'dead' | 'unknown' {
  const owner = rec.owner;
  if (!owner) return 'unknown';
  const sameHost = owner.host === probe.host;
  if (sameHost && owner.pid === probe.pid) return 'alive';
  const beat = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(beat) || probe.now - beat > SUBAGENT_STALE_MS) return 'dead';
  if (sameHost && !probe.pidAlive(owner.pid)) return 'dead';
  return 'alive';
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Almacén de resultados de subagentes en `<projectRoot>/.stratum/subagents/`.
 * Escritura atómica (tmp + rename), best-effort: nunca lanza. Mismo patrón que
 * `PlanStore` (§12.15).
 */
export class SubagentStore {
  private readonly dir: string;
  private readonly probe: () => LivenessProbe;
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  /** Huérfanos ya contados al modelo, a marcar cuando el aviso quede guardado. */
  private readonly deferred = new Map<string, SubagentStore>();

  constructor(projectRoot: string, opts?: { probe?: () => LivenessProbe }) {
    this.dir = join(projectRoot, '.stratum', 'subagents');
    this.probe = opts?.probe ?? localProbe;
  }

  private pathFor(id: string): string | null {
    return SUBAGENT_ID_RE.test(id) ? join(this.dir, `${id}.json`) : null;
  }

  private write(file: SubagentFile): void {
    const target = this.pathFor(file.id);
    if (!target) {
      log.warn('subagent write skipped: invalid id', { id: file.id });
      return;
    }
    try {
      // Nunca pisar un registro que escribió un Stratum más nuevo.
      const current = this.inspect(file.id);
      if (current.kind === 'newer') {
        log.warn('subagent write skipped: newer schema on disk', { id: file.id });
        return;
      }
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
      renameSync(tmp, target);
    } catch (err) {
      log.warn('subagent write failed', { id: file.id, err });
      process.stderr.write(
        `[stratum] Advertencia: no se pudo guardar el subagente en .stratum/subagents/${file.id}.json — ${String(err)}\n`,
      );
    }
  }

  private owner(): SubagentOwner {
    const p = this.probe();
    return { pid: p.pid, host: p.host, heartbeatAt: new Date(p.now).toISOString() };
  }

  /** Lo que hay en disco para ese id, sin lanzar. */
  inspect(id: string): SubagentInspection {
    const target = this.pathFor(id);
    if (!target) return { kind: 'corrupt', reason: 'id inválido' };
    try {
      if (!existsSync(target)) return { kind: 'missing' };
      return parseSubagentFile(JSON.parse(readFileSync(target, 'utf-8')), id);
    } catch (err) {
      return { kind: 'corrupt', reason: String(err) };
    }
  }

  /**
   * Marca `running` antes de ejecutar y arranca el latido. Preserva `createdAt`
   * si el fichero existe.
   */
  saveRunning(id: string, profile: string, task: string, opts?: { sessionId?: string }): void {
    const now = new Date().toISOString();
    const prev = this.read(id);
    this.write({
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
      id,
      sessionId: opts?.sessionId ?? prev?.sessionId ?? null,
      owner: this.owner(),
      profile,
      task,
      status: 'running',
      result: null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
    this.startHeartbeat(id);
  }

  /** Persiste el resultado terminal, sobrescribiendo la marca `running`. */
  saveResult(
    id: string,
    profile: string,
    task: string,
    result: SubagentResult,
    opts?: { sessionId?: string },
  ): void {
    this.stopHeartbeat(id);
    const now = new Date().toISOString();
    const prev = this.read(id);
    this.write({
      schemaVersion: SUBAGENT_SCHEMA_VERSION,
      id,
      sessionId: opts?.sessionId ?? prev?.sessionId ?? null,
      owner: prev?.owner ?? this.owner(),
      profile,
      task,
      status: result.status,
      result,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  /** Destino directo de `RunOptions.onSubagentPersist`. */
  persist(rec: SubagentPersist): void {
    const opts = rec.sessionId ? { sessionId: rec.sessionId } : undefined;
    if (rec.result) this.saveResult(rec.id, rec.profile, rec.task, rec.result, opts);
    else this.saveRunning(rec.id, rec.profile, rec.task, opts);
  }

  private startHeartbeat(id: string): void {
    this.stopHeartbeat(id);
    const timer = setInterval(() => {
      const prev = this.read(id);
      // Otro proceso lo dio por huérfano, o ya terminó: el latido sobra.
      if (!prev || prev.status !== 'running') {
        this.stopHeartbeat(id);
        return;
      }
      this.write({ ...prev, owner: this.owner() });
    }, SUBAGENT_HEARTBEAT_MS);
    // El latido no puede mantener vivo el proceso (§12.12).
    timer.unref();
    this.heartbeats.set(id, timer);
  }

  private stopHeartbeat(id: string): void {
    const timer = this.heartbeats.get(id);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(id);
  }

  /** Detiene todos los latidos (teardown). No toca el disco. */
  dispose(): void {
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
  }

  /**
   * Marca un registro `running` como `interrupted`, para que no se vuelva a
   * detectar. Solo si su dueño está muerto: nunca se marca uno que sigue vivo.
   */
  markInterrupted(id: string): void {
    const prev = this.read(id);
    if (!prev || prev.status !== 'running') return;
    if (ownerState(prev, this.probe()) === 'alive') return;
    this.stopHeartbeat(id);
    this.write({ ...prev, status: 'interrupted', updatedAt: new Date().toISOString() });
  }

  /**
   * Aplaza `markInterrupted` hasta `commitDeferred`: el aviso al modelo solo es
   * durable cuando la sesión que lo contiene se guarda. Marcar antes y perder la
   * sesión (proceso muerto antes de guardar) borraría el aviso para siempre.
   */
  deferInterrupted(ids: Iterable<string>, owner: SubagentStore = this): void {
    // `owner`: el store del proyecto de la sesión reanudada, que puede no ser
    // el del cwd (reanudar desde otra carpeta).
    for (const id of ids) this.deferred.set(id, owner);
  }

  /** Marca los aplazados. Llamar tras guardar la sesión. */
  commitDeferred(): void {
    for (const [id, owner] of this.deferred) owner.markInterrupted(id);
    this.deferred.clear();
  }

  /** Lee un registro válido. null si no existe, está corrupto o es más nuevo. */
  read(id: string): SubagentFile | null {
    const found = this.inspect(id);
    if (found.kind === 'ok') return found.record;
    if (found.kind !== 'missing') log.warn('subagent read skipped', { id, ...found });
    return null;
  }

  private fileNames(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir);
    } catch (err) {
      log.warn('subagent list failed', { err });
      return [];
    }
  }

  /** Todos los registros válidos (para inspección/limpieza). Best-effort. */
  list(): SubagentFile[] {
    return this.fileNames()
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(f.slice(0, -'.json'.length)))
      .filter((r): r is SubagentFile => r !== null);
  }

  /**
   * Registros de `sessionId` que quedaron `running` con el dueño muerto: un
   * cuelgue duro dejó la marca sin estado terminal. Los de otra sesión, los que
   * siguen vivos (otra terminal) y los anteriores a `owner` no aparecen.
   */
  findOrphaned(sessionId: string): SubagentFile[] {
    const probe = this.probe();
    return this.list().filter(
      (r) => r.status === 'running' && r.sessionId === sessionId && ownerState(r, probe) === 'dead',
    );
  }

  /** ¿Se puede borrar sin romper una ejecución en curso? */
  private removable(rec: SubagentFile, probe: LivenessProbe): boolean {
    return rec.status !== 'running' || ownerState(rec, probe) !== 'alive';
  }

  private unlink(name: string): boolean {
    try {
      unlinkSync(join(this.dir, name));
      return true;
    } catch (err) {
      log.warn('subagent delete failed', { name, err });
      return false;
    }
  }

  /** Borra los registros de una sesión (salvo los que siguen corriendo). */
  deleteSession(sessionId: string): number {
    const probe = this.probe();
    let deleted = 0;
    for (const rec of this.list()) {
      if (rec.sessionId !== sessionId || !this.removable(rec, probe)) continue;
      if (this.unlink(`${rec.id}.json`)) deleted++;
    }
    return deleted;
  }

  /**
   * Retención: borra lo que lleva más de `olderThanMs` sin tocarse — registros
   * válidos que no estén corriendo, ficheros corruptos y temporales huérfanos.
   * Un registro de un Stratum más nuevo nunca se borra.
   */
  prune(olderThanMs: number): number {
    const probe = this.probe();
    const cutoff = probe.now - olderThanMs;
    let deleted = 0;
    for (const name of this.fileNames()) {
      let mtime: number;
      try {
        mtime = statSync(join(this.dir, name)).mtimeMs;
      } catch {
        continue;
      }
      if (name.endsWith('.json.tmp')) {
        if (mtime < cutoff && this.unlink(name)) deleted++;
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const found = this.inspect(name.slice(0, -'.json'.length));
      if (found.kind === 'ok') {
        const updated = Date.parse(found.record.updatedAt);
        const age = Number.isFinite(updated) ? updated : mtime;
        if (age < cutoff && this.removable(found.record, probe) && this.unlink(name)) deleted++;
      } else if (found.kind === 'corrupt' && mtime < cutoff && this.unlink(name)) {
        deleted++;
      }
    }
    return deleted;
  }
}
