/**
 * Entorno de cada invocación de git del almacén de snapshots (UX-1).
 *
 * El snapshot vive en un repo git propio cuyo work-tree es el proyecto del
 * usuario. Todas las invocaciones pasan por aquí para que git no pueda salirse:
 *  - parte de `scrubGitEnv()`: un `GIT_DIR` heredado del proceso haría que el
 *    snapshot midiera otro repositorio (ver `git/env.ts`);
 *  - fija GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE: el repo es el de la sombra y el
 *    índice es **por sesión** (dos sesiones en el mismo proyecto no comparten);
 *  - `GIT_CONFIG_NOSYSTEM=1` y `GIT_CONFIG_GLOBAL=<empty.gitconfig>`: la config
 *    global del usuario podría traer `core.hooksPath` o drivers de filtro que
 *    ejecutarían código ajeno en cada `add`;
 *  - `GIT_TERMINAL_PROMPT=0`: un credential helper preguntando colgaría el turno;
 *  - `GIT_LITERAL_PATHSPECS=1`: los pathspecs son literales. Un fichero llamado
 *    `a[1].txt` es una ruta, no un glob que no casa con nada; el precio es que
 *    la magia `:(exclude)` deja de existir aquí, así que las exclusiones se
 *    hacen filtrando el listado (ver `store.ts`).
 */
import { scrubGitEnv } from '../git/env.js';

export interface SnapshotGitEnvOptions {
  /** GIT_DIR del repo de la sombra. */
  gitDir: string;
  /** Work-tree: la raíz del worktree del proyecto del usuario. */
  workTree: string;
  /** GIT_INDEX_FILE propio de la sesión. */
  indexFile: string;
  /** Fichero de config global vacío que sustituye al del usuario. */
  globalConfig: string;
  /** Entorno base; por defecto el del proceso. */
  base?: NodeJS.ProcessEnv;
}

/** Entorno cerrado para una invocación de git del snapshot. */
export function snapshotGitEnv(opts: SnapshotGitEnvOptions): NodeJS.ProcessEnv {
  const env = scrubGitEnv(opts.base ?? process.env);
  env.GIT_DIR = opts.gitDir;
  env.GIT_WORK_TREE = opts.workTree;
  env.GIT_INDEX_FILE = opts.indexFile;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = opts.globalConfig;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_LITERAL_PATHSPECS = '1';
  return env;
}
