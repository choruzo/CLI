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
 * Carga el STRATUM.md del proyecto (desde cwd) y el global (~/.stratum/STRATUM.md).
 * Nunca lanza por ausencia — devuelve strings vacíos si los archivos no existen.
 */
export function loadProjectMemory(config: StratumConfig): ProjectMemory {
  const paths = resolveMemoryPaths(config);

  // El projectFile puede ser relativo → resolver desde cwd
  const projectPath = resolve(process.cwd(), paths.projectFile);
  const globalPath = paths.globalFile;

  const projectContent = existsSync(projectPath) ? readFileSync(projectPath, 'utf-8').trim() : '';

  const globalContent = existsSync(globalPath) ? readFileSync(globalPath, 'utf-8').trim() : '';

  return { projectContent, globalContent, projectPath, globalPath };
}
