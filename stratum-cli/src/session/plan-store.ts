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
import { join } from 'path';
import { z } from 'zod';
import type { Plan } from '../agent/types.js';
import { isPlanComplete } from '../agent/plan.js';
import { PLAN_SCHEMA_VERSION, checkSchemaVersion } from '../config/schema-version.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent');

/**
 * Fichero de plan persistido (§12.6 / Hito 7). Se escribe de forma incremental
 * en cada cambio de estado de paso, de modo que la reanudación funciona incluso
 * tras un cuelgue duro donde el guardado de sesión nunca llegó a ejecutarse.
 */
export interface PlanFile {
  schemaVersion: number;
  /** Tarea original del usuario que originó el plan. */
  task: string;
  status: 'in_progress' | 'done';
  plan: Plan;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function randomAlpha(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
}

/** Genera un nombre de fichero de plan: `plan_YYYYMMDD_HHMMSS_<rnd>`. */
export function generatePlanId(): string {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `plan_${date}_${time}_${randomAlpha(3)}`;
}

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------

/**
 * Ref de plan válida: la que genera `generatePlanId`, con o sin `.json`. La ref
 * llega del JSON de la sesión, así que sin esta comprobación un `../../x`
 * leería o escribiría fuera de `.stratum/plans/`.
 */
const PLAN_REF_RE = /^plan_[A-Za-z0-9_-]+$/;

/** Normaliza una ref (quita `.json`); null si no es una ref de plan válida. */
export function normalizePlanRef(ref: string): string | null {
  const bare = ref.endsWith('.json') ? ref.slice(0, -'.json'.length) : ref;
  return PLAN_REF_RE.test(bare) ? bare : null;
}

const StepSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    detail: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'done', 'skipped']),
  })
  .passthrough();

// `passthrough`: un campo que añada una versión compatible no se pierde al reescribir.
const PlanFileSchema = z
  .object({
    schemaVersion: z.unknown().optional(),
    task: z.string(),
    status: z.enum(['in_progress', 'done']),
    plan: z.object({ summary: z.string(), steps: z.array(StepSchema).min(1) }).passthrough(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

/** Lo que hay en disco para una ref, sin lanzar nunca. */
export type PlanInspection =
  | { kind: 'ok'; file: PlanFile }
  | { kind: 'missing' }
  /** De un Stratum más nuevo: ni se interpreta, ni se reescribe, ni se borra. */
  | { kind: 'newer'; version: unknown }
  | { kind: 'corrupt'; reason: string };

/** Valida un JSON ya parseado. Puro. */
export function parsePlanFile(raw: unknown): PlanInspection {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'corrupt', reason: 'no es un objeto' };
  }
  const version = checkSchemaVersion(
    (raw as { schemaVersion?: unknown }).schemaVersion,
    PLAN_SCHEMA_VERSION,
  );
  if (!version.ok) {
    return version.reason === 'newer'
      ? { kind: 'newer', version: version.version }
      : { kind: 'corrupt', reason: `schemaVersion inválido: ${JSON.stringify(version.version)}` };
  }
  const parsed = PlanFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      kind: 'corrupt',
      reason: `${issue?.path.join('.') || '(raíz)'}: ${issue?.message ?? 'inválido'}`,
    };
  }
  return {
    kind: 'ok',
    file: { ...(parsed.data as unknown as PlanFile), schemaVersion: version.version },
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Almacén de planes en `<projectRoot>/.stratum/plans/`. El `ref` que se guarda
 * en la sesión es relativo a esa carpeta (el nombre de fichero sin `.json`).
 */
export class PlanStore {
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.stratum', 'plans');
  }

  private pathFor(ref: string): string | null {
    const bare = normalizePlanRef(ref);
    return bare ? join(this.dir, `${bare}.json`) : null;
  }

  /** Lo que hay en disco para esa ref, sin lanzar. */
  inspect(ref: string): PlanInspection {
    const target = this.pathFor(ref);
    if (!target) return { kind: 'corrupt', reason: `ref de plan inválida: ${JSON.stringify(ref)}` };
    try {
      if (!existsSync(target)) return { kind: 'missing' };
      return parsePlanFile(JSON.parse(readFileSync(target, 'utf-8')));
    } catch (err) {
      return { kind: 'corrupt', reason: String(err) };
    }
  }

  /** Escritura atómica (tmp + rename). Best-effort: nunca lanza. */
  write(ref: string, file: PlanFile): void {
    const target = this.pathFor(ref);
    if (!target) {
      log.warn('plan write skipped: invalid ref', { ref });
      return;
    }
    try {
      // Nunca pisar un plan que escribió un Stratum más nuevo.
      if (this.inspect(ref).kind === 'newer') {
        log.warn('plan write skipped: newer schema on disk', { ref });
        return;
      }
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
      renameSync(tmp, target);
    } catch (err) {
      log.warn('plan write failed', { ref, err });
      process.stderr.write(
        `[stratum] Advertencia: no se pudo guardar el plan en .stratum/plans/${ref}.json — ${String(err)}\n`,
      );
    }
  }

  /** Crea/actualiza el fichero de plan con el estado actual del plan. */
  save(ref: string, task: string, plan: Plan, createdAt: string): void {
    const now = new Date().toISOString();
    this.write(ref, {
      schemaVersion: PLAN_SCHEMA_VERSION,
      task,
      status: isPlanComplete(plan) ? 'done' : 'in_progress',
      plan,
      createdAt,
      updatedAt: now,
    });
  }

  /** Lee un plan válido. null si no existe, está corrupto o es más nuevo. */
  read(ref: string): PlanFile | null {
    const found = this.inspect(ref);
    if (found.kind === 'ok') return found.file;
    if (found.kind !== 'missing') log.warn('plan read skipped', { ref, ...found });
    return null;
  }

  private unlink(name: string): boolean {
    try {
      unlinkSync(join(this.dir, name));
      return true;
    } catch (err) {
      log.warn('plan delete failed', { name, err });
      return false;
    }
  }

  /** Borra un plan (el de una sesión que se elimina). Nunca uno más nuevo. */
  delete(ref: string): boolean {
    const bare = normalizePlanRef(ref);
    if (!bare) return false;
    const found = this.inspect(bare);
    if (found.kind === 'missing' || found.kind === 'newer') return false;
    return this.unlink(`${bare}.json`);
  }

  /**
   * Retención: borra los planes que llevan más de `olderThanMs` sin tocarse,
   * los corruptos y los temporales huérfanos, salvo las refs de `keep` (las que
   * una sesión guardada todavía puede reanudar). Un plan de un Stratum más
   * nuevo nunca se borra.
   */
  prune(olderThanMs: number, keep: ReadonlySet<string> = new Set()): number {
    if (!existsSync(this.dir)) return 0;
    const cutoff = Date.now() - olderThanMs;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      log.warn('plan list failed', { err });
      return 0;
    }
    let deleted = 0;
    for (const name of names) {
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
      const ref = name.slice(0, -'.json'.length);
      if (keep.has(ref)) continue;
      const found = this.inspect(ref);
      if (found.kind === 'ok') {
        const updated = Date.parse(found.file.updatedAt);
        if ((Number.isFinite(updated) ? updated : mtime) < cutoff && this.unlink(name)) deleted++;
      } else if (found.kind === 'corrupt' && mtime < cutoff && this.unlink(name)) {
        deleted++;
      }
    }
    return deleted;
  }
}
