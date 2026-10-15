/**
 * La carpeta del daemon (`~/.stratum/daemon/`) y su canal, **privados** (M9).
 *
 * Ahí viven `endpoint.json` (con el token del canal), `approver.json` (la
 * derivación de la clave de aprobador) y, en POSIX, el unix socket. Quien pueda
 * escribir en esa carpeta puede sustituir el endpoint; quien pueda conectar al
 * socket puede intentar el saludo. Por eso, antes de publicar nada:
 *
 *  - la carpeta no puede ser un enlace simbólico (no se sigue a otro sitio);
 *  - en POSIX tiene que ser **de este usuario** y quedar en `0700` (si queda
 *    accesible a otros tras el `chmod`, no se arranca: falla cerrado);
 *  - en POSIX el socket queda en `0600`: el núcleo solo deja conectar a quien
 *    puede escribir en él, es decir, a este usuario (o a root).
 *
 * En Windows no se comprueba el dueño ni la ACL: la carpeta hereda la del
 * perfil del usuario, y el named pipe se crea con la DACL por defecto (Node no
 * permite otra). Lo que eso deja dentro y fuera está en `docs/protocol.md` §15.3.
 */
import { chmodSync, lstatSync, mkdirSync, statSync, type Stats } from 'fs';
import { chmod, lstat, mkdir, stat } from 'fs/promises';

/** La carpeta o el canal del daemon no son de fiar: no se arranca. */
export class InsecureDaemonDirError extends Error {
  override readonly name = 'InsecureDaemonDirError';

  constructor(readonly reason: string) {
    super(`The Stratum daemon folder is not private: ${reason}.`);
  }
}

function check(link: Stats, platform: NodeJS.Platform): void {
  if (link.isSymbolicLink()) throw new InsecureDaemonDirError('it is a symbolic link');
  if (!link.isDirectory()) throw new InsecureDaemonDirError('it is not a directory');
  if (platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && link.uid !== uid)
    throw new InsecureDaemonDirError('it belongs to another user');
}

function checkMode(after: Stats, platform: NodeJS.Platform): void {
  if (platform !== 'win32' && (after.mode & 0o077) !== 0) {
    throw new InsecureDaemonDirError('other users can access it');
  }
}

/** Crea (si falta) y comprueba la carpeta del daemon. @throws InsecureDaemonDirError */
export async function ensurePrivateDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  check(await lstat(dir), platform);
  if (platform === 'win32') return;
  // `mode` solo cuenta al crear: una carpeta que ya existía se ajusta aquí.
  await chmod(dir, 0o700);
  checkMode(await stat(dir), platform);
}

/** Lo mismo, síncrono (para `stratum approvals set-key`). */
export function ensurePrivateDirSync(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  check(lstatSync(dir), platform);
  if (platform === 'win32') return;
  chmodSync(dir, 0o700);
  checkMode(statSync(dir), platform);
}

/**
 * Deja el unix socket solo para este usuario. En Windows (named pipe) no hace
 * nada. Se llama tras escuchar y **antes** de publicar el endpoint.
 * @throws si no se puede (falla cerrado: el daemon no publica un canal abierto).
 */
export async function restrictSocket(
  ipcPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') return;
  await chmod(ipcPath, 0o600);
  const after = await stat(ipcPath);
  if ((after.mode & 0o077) !== 0)
    throw new InsecureDaemonDirError('the socket is accessible by other users');
}
