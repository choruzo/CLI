import { existsSync, statSync } from 'fs';
import type { Message, Plan } from '../agent/types.js';
import { buildResumePreamble } from '../agent/plan.js';
import { planSubagentResume } from '../agent/subagent.js';
import { PlanStore } from './plan-store.js';
import { SubagentStore, type SubagentFile } from './subagent-store.js';

/**
 * Qué hay que reconstruir al reanudar una sesión guardada: el plan que quedó a
 * medias y los subagentes huérfanos. Único punto para `chat --resume` y
 * `/sessions resume` en caliente — antes cada uno hacía su parte y divergían.
 */

/** Plan `in_progress` que la sesión puede retomar. */
export interface ResumablePlan {
  ref: string;
  plan: Plan;
  task: string;
  createdAt: string;
  /** Proyecto donde vive el fichero: ahí se siguen persistiendo los pasos. */
  root: string;
}

export interface SessionResumeContext {
  /** Proyecto de la sesión (donde viven sus planes y subagentes). */
  projectRoot: string;
  plan: ResumablePlan | null;
  /** Huérfanos a avisar; se marcan tras guardar (`SubagentStore.deferInterrupted`). */
  orphans: SubagentFile[];
  /** Store de `projectRoot`, al que pertenecen los `orphans`. */
  subagentStore: SubagentStore;
  /** Preámbulo del plan y de los subagentes, en ese orden. null si no hay nada. */
  preamble: string | null;
  /** Avisos para el usuario (plan dañado, de otra versión…). */
  warnings: string[];
}

interface SavedSessionLike {
  id: string;
  project?: string;
  planRef?: string | null;
  messages: Message[];
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Los ficheros de plan y de subagente viven en el proyecto de la sesión, no en
 * el cwd de quien la reanuda (`stratum sessions resume` desde otra carpeta).
 */
export function sessionProjectRoot(saved: { project?: string }, cwd: string): string {
  return saved.project && existsSync(saved.project) && isDirectory(saved.project)
    ? saved.project
    : cwd;
}

/** Carga el plan reanudable de una sesión. Nunca lanza: un plan dañado no impide reanudar. */
export function loadResumablePlan(
  root: string,
  planRef: string | null | undefined,
): { plan: ResumablePlan | null; warning?: string } {
  if (!planRef) return { plan: null };
  const found = new PlanStore(root).inspect(planRef);
  switch (found.kind) {
    case 'ok':
      if (found.file.status !== 'in_progress') return { plan: null };
      return {
        plan: {
          ref: planRef,
          plan: found.file.plan,
          task: found.file.task,
          createdAt: found.file.createdAt,
          root,
        },
      };
    case 'missing':
      return { plan: null };
    case 'newer':
      return {
        plan: null,
        warning: `El plan ${planRef} lo guardó una versión más nueva de Stratum: se reanuda sin él.`,
      };
    case 'corrupt':
      return {
        plan: null,
        warning: `El plan ${planRef} está dañado (${found.reason}): se reanuda sin él.`,
      };
  }
}

/**
 * Prepara la reanudación. Único efecto en disco: marca `interrupted` los
 * huérfanos que el historial ya avisó (ese aviso ya es durable).
 */
export function prepareSessionResume(saved: SavedSessionLike, cwd: string): SessionResumeContext {
  const projectRoot = sessionProjectRoot(saved, cwd);
  const warnings: string[] = [];

  const loaded = loadResumablePlan(projectRoot, saved.planRef);
  if (loaded.warning) warnings.push(loaded.warning);

  const subagentStore = new SubagentStore(projectRoot);
  const subPlan = planSubagentResume(subagentStore.findOrphaned(saved.id), saved.messages);
  subPlan.alreadyReported.forEach((o) => subagentStore.markInterrupted(o.id));

  const parts = [loaded.plan ? buildResumePreamble(loaded.plan.plan) : null, subPlan.preamble];
  const present = parts.filter((p): p is string => p !== null);
  return {
    projectRoot,
    plan: loaded.plan,
    orphans: subPlan.report,
    subagentStore,
    preamble: present.length > 0 ? present.join('\n\n') : null,
    warnings,
  };
}
