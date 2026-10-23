/**
 * API pública del módulo de snapshots (UX-1): deshacer por turno con un git en
 * la sombra. El contrato completo está en `.brief.md`; en fase 1 todo vive a
 * nivel de módulo (`SnapshotStore`) — la fachada en `StratumAgent` llega en la
 * fase 2 junto al cableado de `runTurn`.
 */
export {
  normalizeRootForId,
  snapshotDirForRoot,
  snapshotRootId,
} from './paths.js';
export { snapshotGitEnv, type SnapshotGitEnvOptions } from './env.js';
export {
  SNAPSHOT_TURNS_SCHEMA_VERSION,
  loadTurnsFile,
  saveTurnsFile,
  type LoadTurnsResult,
  type TurnFileEntry,
  type TurnFileStatus,
  type TurnRecord,
} from './registry.js';
export {
  chunk,
  formatFilesReverted,
  SnapshotStore,
  type RevertPlan,
  type RevertResult,
  type SkippedPath,
  type SnapshotResult,
  type SnapshotStoreOptions,
  type TrackedTurn,
} from './store.js';
export { gitRun, mergeTreeDiff, parseNameStatusZ, parseNumstatZ, tail } from './git.js';

/**
 * Aviso de alcance para la UI (punto 7 del brief): deshacer solo restaura
 * ficheros del work-tree. Los efectos fuera de él (SSH, otros directorios,
 * procesos, servicios) no se deshacen.
 */
export const REVERT_SCOPE_NOTE =
  'Nota: deshacer solo restaura ficheros dentro del work-tree de este proyecto. ' +
  'Los efectos fuera de él (SSH, otros directorios, procesos o servicios) no se deshacen.';
