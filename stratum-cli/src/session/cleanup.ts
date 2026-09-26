import { existsSync } from 'fs';
import type { SessionStore } from './store.js';
import { SubagentStore } from './subagent-store.js';
import { PlanStore, normalizePlanRef } from './plan-store.js';

/**
 * Limpieza de sesiones que arrastra sus artefactos de proyecto: registros de
 * subagente y plan. Las sesiones son globales (`~/.stratum/sessions/`) y los
 * artefactos viven en el proyecto de cada una (`<project>/.stratum/…`), así que
 * se usa el `project` guardado en la sesión, no el cwd de quien borra.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function projectOf(project: string | undefined): string | null {
  return project && existsSync(project) ? project : null;
}

/** Refs de plan que alguna sesión guardada todavía puede reanudar. null si no se pueden leer. */
function referencedPlanRefs(store: SessionStore): Set<string> | null {
  try {
    const { sessions, skipped } = store.scan();
    // Una sesión ilegible puede referenciar cualquier plan: no se borra ninguno.
    if (skipped.length > 0) return null;
    const refs = new Set<string>();
    for (const s of sessions) {
      const ref = s.planRef ? normalizePlanRef(s.planRef) : null;
      if (ref) refs.add(ref);
    }
    return refs;
  } catch {
    return null;
  }
}

/** Borra la sesión, sus registros de subagente y su plan. Lanza si la sesión no existe. */
export function deleteSessionWithArtifacts(
  store: SessionStore,
  id: string,
): { subagents: number; plans: number } {
  let project: string | null = null;
  let planRef: string | null | undefined;
  try {
    const saved = store.load(id);
    project = projectOf(saved.project);
    planRef = saved.planRef;
  } catch {
    // Sesión ilegible o de un Stratum más nuevo: se borra igual, sin artefactos.
  }
  store.delete(id);
  if (!project) return { subagents: 0, plans: 0 };
  const subagents = new SubagentStore(project).deleteSession(id);
  // Un plan que otra sesión adoptó (`/sessions resume` en caliente) sigue en uso.
  // Si las sesiones no se pueden leer, se da por en uso.
  const bare = planRef ? normalizePlanRef(planRef) : null;
  const inUse = bare !== null && (referencedPlanRefs(store)?.has(bare) ?? true);
  const plans = bare && !inUse && new PlanStore(project).delete(bare) ? 1 : 0;
  return { subagents, plans };
}

/**
 * `sessions prune`: sesiones más antiguas que `olderThanMs` con sus artefactos
 * y, con el mismo umbral, los artefactos viejos de `cwd` y de cada proyecto
 * tocado (restos de sesiones que ya no existen). Un plan que una sesión
 * superviviente puede reanudar no se borra.
 */
export function pruneSessionsWithArtifacts(
  store: SessionStore,
  olderThanMs: number,
  cwd: string,
): { sessions: number; subagents: number; plans: number } {
  const projects = new Set<string>([cwd]);
  let subagents = 0;
  let plans = 0;
  const orphanedPlans: Array<{ project: string; ref: string }> = [];
  const sessions = store.prune(olderThanMs, (s) => {
    const project = projectOf(s.project);
    if (!project) return;
    projects.add(project);
    subagents += new SubagentStore(project).deleteSession(s.id);
    if (s.planRef) orphanedPlans.push({ project, ref: s.planRef });
  });
  const keep = referencedPlanRefs(store);
  for (const { project, ref } of orphanedPlans) {
    const bare = normalizePlanRef(ref);
    if (keep && bare && !keep.has(bare) && new PlanStore(project).delete(bare)) plans++;
  }
  for (const project of projects) {
    if (!existsSync(project)) continue;
    subagents += new SubagentStore(project).prune(olderThanMs);
    if (keep) plans += new PlanStore(project).prune(olderThanMs, keep);
  }
  return { sessions, subagents, plans };
}

/** Sufijo legible con lo que arrastró el borrado de una sesión (vacío si nada). */
export function describeArtifacts(removed: { subagents: number; plans: number }): string {
  const parts: string[] = [];
  if (removed.subagents > 0) parts.push(`${removed.subagents} registro(s) de subagente`);
  if (removed.plans > 0) parts.push(`${removed.plans} plan(es)`);
  return parts.length > 0 ? ` (y ${parts.join(' y ')})` : '';
}

/** Retención automática de planes al arrancar `chat` (`session.planRetentionDays`). */
export function pruneOldPlans(store: SessionStore, cwd: string, days: number): number {
  if (days <= 0) return 0;
  const keep = referencedPlanRefs(store);
  return keep ? new PlanStore(cwd).prune(days * DAY_MS, keep) : 0;
}
