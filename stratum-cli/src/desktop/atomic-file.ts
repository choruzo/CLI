import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Escritura atómica de los ficheros del sidecar (sesiones, registros de
 * conversación, metadatos de workspace, memoria global): temporal junto al
 * destino + `rename`.
 *
 * - El temporal es único por escritura (pid + contador): dos guardados del
 *   mismo fichero nunca comparten temporal.
 * - En Windows, `rename` falla con `EPERM`/`EBUSY`/`EACCES` mientras otro
 *   proceso tiene abierto el destino (antivirus, indexador, copia de
 *   seguridad). Es transitorio: se reintenta unas pocas veces con esperas
 *   cortas antes de dar el guardado por fallido.
 * - Si falla, el temporal se borra: nunca queda a medias junto al destino.
 */

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Esperas entre reintentos del `rename`, en ms (~0,3 s en total como mucho). */
export const RENAME_RETRY_DELAYS_MS = [15, 40, 90, 160];

/** Sufijo de los temporales: `<destino>.<pid>.<n>.tmp` (y `<destino>.<pid>.tmp`, el formato anterior). */
const TEMP_SUFFIX = /\.json\.\d+(\.\d+)?\.tmp$/;

let seq = 0;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AtomicWriteDeps {
  /** Inyectable en tests para simular un destino bloqueado. */
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
}

export function writeFileAtomicSync(
  path: string,
  content: string,
  deps: AtomicWriteDeps = {},
): void {
  const rename = deps.rename ?? renameSync;
  const sleep = deps.sleep ?? sleepSync;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++seq}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf-8');
    for (let attempt = 0; ; attempt++) {
      try {
        rename(tmp, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !code || !RETRYABLE_RENAME.has(code)) throw err;
        sleep(delay);
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const FS_ERROR_TEXT: Record<string, string> = {
  ENOSPC: 'no queda espacio en disco',
  EDQUOT: 'se ha superado la cuota de disco',
  EPERM: 'otro programa tiene el fichero abierto o es de solo lectura',
  EACCES: 'no hay permiso para escribir el fichero',
  EBUSY: 'otro programa tiene el fichero abierto',
  EROFS: 'el disco es de solo lectura',
  EIO: 'error de entrada/salida del disco',
};

/**
 * Un error de disco en una frase para la UI, sin rutas: `EPERM` con las dos
 * rutas del `rename` no le dice nada a quien usa la app. Lleva el código entre
 * paréntesis para poder buscarlo; el error completo va al log.
 */
export function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code && FS_ERROR_TEXT[code]) return `${FS_ERROR_TEXT[code]} (${code})`;
  if (code) return `error del sistema de ficheros (${code})`;
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * Borra los temporales que dejó un proceso que murió a mitad de una escritura
 * (el `rm` del `catch` no llega a ejecutarse). Solo los de más de `olderThanMs`:
 * uno reciente puede ser de una escritura en curso. Nunca lanza.
 */
export function sweepTempFiles(dir: string, olderThanMs = 10 * 60_000, now = Date.now()): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!TEMP_SUFFIX.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < olderThanMs) continue;
      rmSync(path, { force: true });
      removed++;
    } catch {
      /* ya no está, o no se puede: se reintenta en el siguiente arranque */
    }
  }
  return removed;
}
