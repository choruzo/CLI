import { homedir } from 'os';
import { join } from 'path';
import type { StratumConfig } from './schema.js';

/** Expande `~` inicial al directorio home del usuario. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export interface MemoryPaths {
  projectFile: string; // ruta absoluta del STRATUM.md del proyecto
  globalFile: string; // ruta absoluta del STRATUM.md global (~/.stratum/STRATUM.md)
  decisionsFile: string; // ruta absoluta de decisions.json
  vectorDb: string; // ruta absoluta de vectors.db
  sessionsDir: string; // ruta absoluta del directorio de sesiones
}

/** Resuelve las rutas de memoria a rutas absolutas, expandiendo `~`. */
export function resolveMemoryPaths(config: StratumConfig): MemoryPaths {
  return {
    projectFile: expandHome(config.memory.projectFile),
    globalFile: expandHome(config.memory.globalFile),
    decisionsFile: expandHome(config.memory.decisionsFile),
    vectorDb: expandHome(config.memory.vectorDb),
    sessionsDir: expandHome('~/.stratum/sessions'),
  };
}
