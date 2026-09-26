import { existsSync } from 'fs';
import type { SessionStore } from './store.js';
import { SubagentStore } from './subagent-store.js';

/**
 * Limpieza de sesiones que arrastra sus registros de subagente (8B endurecido). Las
 * sesiones son globales (`~/.stratum/sessions/`) y los registros viven en el
 * proyecto de cada una (`<project>/.stratum/subagents/`), así que se usa el
 * `project` guardado en la sesión, no el cwd de quien borra.
 */

function subagentsOf(project: string | undefined): SubagentStore | null {
  return project && existsSync(project) ? new SubagentStore(project) : null;
}

/** Borra la sesión y sus registros de subagente. Lanza si la sesión no existe. */
export function deleteSessionAndSubagents(store: SessionStore, id: string): { subagents: number } {
  let project: string | undefined;
  try {
    project = store.load(id).project;
  } catch {
    // Sesión ilegible o de un Stratum más nuevo: se borra igual, sin registros.
  }
  store.delete(id);
  return { subagents: subagentsOf(project)?.deleteSession(id) ?? 0 };
}

/**
 * `sessions prune`: sesiones más antiguas que `olderThanMs`, sus registros de
 * subagente y, con el mismo umbral, los registros viejos de `cwd` y de cada
 * proyecto tocado (huérfanos de sesiones que ya no existen).
 */
export function pruneSessionsAndSubagents(
  store: SessionStore,
  olderThanMs: number,
  cwd: string,
): { sessions: number; subagents: number } {
  const projects = new Set<string>([cwd]);
  let subagents = 0;
  const sessions = store.prune(olderThanMs, (s) => {
    subagents += subagentsOf(s.project)?.deleteSession(s.id) ?? 0;
    if (s.project) projects.add(s.project);
  });
  for (const project of projects) subagents += subagentsOf(project)?.prune(olderThanMs) ?? 0;
  return { sessions, subagents };
}
