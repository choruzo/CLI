import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve } from 'path';
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
  vectorFallback: string; // sidecar JSON para el índice brute-force (sin sqlite-vec)
  modelsDir: string; // caché de modelos ONNX (~/.stratum/models)
  sessionsDir: string; // ruta absoluta del directorio de sesiones
}

/** Busca la raíz del repo git ascendiendo desde `cwd`. Devuelve `cwd` si no hay repo. */
export function findWorktreeRoot(cwd: string): { worktree: string; isGitRepo: boolean } {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      return { worktree: dir, isGitRepo: true };
    }
    const parent = dirname(dir);
    if (parent === dir) return { worktree: cwd, isGitRepo: false };
    dir = parent;
  }
}

/**
 * La memoria de decisiones de un proyecto vive en su raíz: `decisionsFile` y
 * `vectorDb` relativos se anclan a la raíz del worktree de `startDir`, así que
 * la CLI lanzada desde una subcarpeta ve la misma memoria. Una ruta absoluta o
 * con `~` la eligió el usuario y se respeta. La aplica `loadConfig`: todo el
 * que carga la config de un directorio (CLI, daemon, tools) ve la misma ruta.
 */
export function anchorMemoryPaths(config: StratumConfig, startDir: string): StratumConfig {
  const root = findWorktreeRoot(startDir).worktree;
  const anchor = (p: string): string =>
    isAbsolute(p) || expandHome(p) !== p ? p : resolve(root, p);
  return {
    ...config,
    memory: {
      ...config.memory,
      decisionsFile: anchor(config.memory.decisionsFile),
      vectorDb: anchor(config.memory.vectorDb),
    },
  };
}

/** Resuelve las rutas de memoria a rutas absolutas, expandiendo `~`. */
export function resolveMemoryPaths(config: StratumConfig): MemoryPaths {
  const vectorDb = expandHome(config.memory.vectorDb);
  return {
    projectFile: expandHome(config.memory.projectFile),
    globalFile: expandHome(config.memory.globalFile),
    decisionsFile: expandHome(config.memory.decisionsFile),
    vectorDb,
    vectorFallback: vectorDb.replace(/\.db$/i, '') + '.fallback.json',
    modelsDir: expandHome('~/.stratum/models'),
    sessionsDir: expandHome('~/.stratum/sessions'),
  };
}
