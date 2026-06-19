import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import type { Plan } from '../agent/types.js';
import { isPlanComplete } from '../agent/plan.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent');

/**
 * Fichero de plan persistido (§12.6 / Hito 7). Se escribe de forma incremental
 * en cada cambio de estado de paso, de modo que la reanudación funciona incluso
 * tras un cuelgue duro donde el guardado de sesión nunca llegó a ejecutarse.
 */
export interface PlanFile {
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

/**
 * Almacén de planes en `<projectRoot>/.stratum/plans/`. El `ref` que se guarda
 * en la sesión es relativo a esa carpeta (solo el nombre de fichero `.json`).
 */
export class PlanStore {
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.stratum', 'plans');
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(ref: string): string {
    // `ref` es el nombre de fichero relativo; normalizamos por si trae .json o no.
    const file = ref.endsWith('.json') ? ref : `${ref}.json`;
    return join(this.dir, file);
  }

  /** Escritura atómica (tmp + rename). Best-effort: nunca lanza. */
  write(ref: string, file: PlanFile): void {
    try {
      this.ensureDir();
      const target = this.pathFor(ref);
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
      task,
      status: isPlanComplete(plan) ? 'done' : 'in_progress',
      plan,
      createdAt,
      updatedAt: now,
    });
  }

  /** Lee un plan persistido. Devuelve null si no existe o está corrupto. */
  read(ref: string): PlanFile | null {
    try {
      const target = this.pathFor(ref);
      if (!existsSync(target)) return null;
      return JSON.parse(readFileSync(target, 'utf-8')) as PlanFile;
    } catch (err) {
      log.warn('plan read failed', { ref, err });
      return null;
    }
  }
}
