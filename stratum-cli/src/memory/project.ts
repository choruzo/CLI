import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { resolveMemoryPaths } from '../config/paths.js';

export interface ProjectMemory {
  projectContent: string;
  globalContent: string;
  projectPath: string;
  globalPath: string;
}

/**
 * Qué `STRATUM.md` ve una sesión. `project` (el agente de código): solo el del
 * proyecto. `global` (el asistente): solo `~/.stratum/STRATUM.md`. Ninguna ve
 * las dos: la memoria de un proyecto no sale de él y la del asistente no entra
 * en ningún proyecto.
 */
export type MemoryScope = 'project' | 'global';

/**
 * Carga el STRATUM.md del proyecto (desde `cwd`, el de la sesión) o el global
 * (~/.stratum/STRATUM.md), según `scope`; el otro queda vacío. Nunca lanza por
 * ausencia — devuelve strings vacíos si los archivos no existen.
 */
export function loadProjectMemory(
  config: StratumConfig,
  cwd: string,
  scope: MemoryScope = 'project',
): ProjectMemory {
  const paths = resolveMemoryPaths(config);

  // El projectFile puede ser relativo → resolver desde cwd
  const projectPath = resolve(cwd, paths.projectFile);
  const globalPath = paths.globalFile;

  const projectContent =
    scope === 'project' && existsSync(projectPath) ? readFileSync(projectPath, 'utf-8').trim() : '';

  const globalContent =
    scope === 'global' && existsSync(globalPath) ? readFileSync(globalPath, 'utf-8').trim() : '';

  return { projectContent, globalContent, projectPath, globalPath };
}
