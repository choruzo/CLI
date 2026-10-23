/**
 * Ubicación del almacén de snapshots (UX-1).
 *
 * Un proyecto → un directorio: `~/.stratum/snapshots/<id>/`, con `<id>` = los
 * primeros 16 hex del sha256 de la raíz del worktree. Antes de hashear, la raíz
 * se normaliza (separadores `/` y, en Windows, minúsculas): el mismo proyecto
 * abierto como `D:\Repo`, `d:/repo` o `D:/repo/` ha de caer en el mismo sitio.
 *
 * Nunca se escribe dentro del proyecto: el `.git` del usuario no se toca.
 * El home es inyectable para que los tests no escriban en el `~` real.
 */
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

/** Normaliza una raíz para hashearla: separadores `/` y minúsculas en Windows. */
export function normalizeRootForId(root: string): string {
  const slashed = root.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Id del directorio de snapshots de una raíz: 16 hex de `sha256(raíz normalizada)`. */
export function snapshotRootId(root: string): string {
  return createHash('sha256').update(normalizeRootForId(root)).digest('hex').slice(0, 16);
}

/** `~/.stratum/snapshots/<id>/` para la raíz dada. `home` inyectable (tests). */
export function snapshotDirForRoot(root: string, home: string = homedir()): string {
  return join(home, '.stratum', 'snapshots', snapshotRootId(root));
}
