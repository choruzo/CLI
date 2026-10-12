/**
 * Publicación de `endpoint.json`: dónde escucha el daemon y con qué token. Es
 * el único estado que el daemon deja en disco, y hace además de exclusión: quien
 * lo tiene es **el** daemon de ese directorio.
 *
 * Reglas:
 *  - se crea de forma **atómica y exclusiva** (un enlace duro desde un temporal
 *    ya escrito): nadie lee un fichero a medias y dos arranques no lo ganan a
 *    la vez;
 *  - si ya existe y su dueño está vivo y contesta, no se toca
 *    (`DaemonAlreadyRunningError`);
 *  - si su dueño murió —el pid ya no existe, o existe pero nadie escucha en su
 *    pipe (un pid reutilizado)— es **rancio** y se sustituye;
 *  - al apagar solo se borra si sigue siendo el nuestro.
 *
 * El token no se registra ni viaja en ningún error.
 */
import { randomBytes } from 'crypto';
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { createConnection } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { ENDPOINT_FILE, processAlive, type Endpoint } from '../client/discovery.js';

/** Ya hay un daemon vivo publicado en ese directorio. */
export class DaemonAlreadyRunningError extends Error {
  override readonly name = 'DaemonAlreadyRunningError';

  constructor(readonly pid: number) {
    super(`A Stratum daemon is already running (pid ${pid}).`);
  }
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/** Límite práctico de la ruta de un unix socket (`sun_path`). */
const MAX_SOCKET_PATH = 100;

/** Nombre del canal, aleatorio en cada arranque. */
export function newIpcPath(dir: string, platform: NodeJS.Platform = process.platform): string {
  const name = `stratumd-${randomBytes(8).toString('hex')}`;
  if (platform === 'win32') return `\\\\.\\pipe\\${name}`;
  const inDir = join(dir, `${name}.sock`);
  return inDir.length <= MAX_SOCKET_PATH ? inDir : join(tmpdir(), `${name}.sock`);
}

/** ¿Hay alguien escuchando ahí? Solo conecta y cuelga: no envía nada. */
export function probeIpc(ipcPath: string, timeoutMs = 750): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(ipcPath);
    const done = (alive: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface ClaimOptions {
  /** Carpeta del endpoint (`~/.stratum/daemon/`). Se crea si falta. */
  dir: string;
  endpoint: Endpoint;
  /** Inyectables para tests. */
  isAlive?: (pid: number) => boolean;
  probe?: (ipcPath: string) => Promise<boolean>;
}

export interface EndpointClaim {
  readonly file: string;
  readonly endpoint: Endpoint;
  /** `true` si se sustituyó un endpoint rancio. */
  readonly replacedStale: boolean;
  /** Borra el endpoint si sigue siendo el nuestro. Idempotente; nunca lanza. */
  release(): Promise<void>;
}

/** Lo justo de un endpoint ajeno para saber si su dueño vive. Tolera otras versiones. */
function ownerOf(text: string): { pid: number; ipcPath: string } | null {
  try {
    const raw = JSON.parse(text) as { pid?: unknown; ipcPath?: unknown };
    return typeof raw.pid === 'number' && typeof raw.ipcPath === 'string' && raw.pid > 0
      ? { pid: raw.pid, ipcPath: raw.ipcPath }
      : null;
  } catch {
    return null;
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Publica el endpoint. Hay que llamarlo **con el servidor ya escuchando**: en
 * cuanto el fichero existe, un cliente puede conectarse.
 *
 * @throws DaemonAlreadyRunningError si hay otro daemon vivo.
 */
export async function claimEndpoint(opts: ClaimOptions): Promise<EndpointClaim> {
  const isAlive = opts.isAlive ?? processAlive;
  const probe = opts.probe ?? probeIpc;
  const file = join(opts.dir, ENDPOINT_FILE);
  const mine = JSON.stringify(opts.endpoint, null, 2) + '\n';

  await mkdir(opts.dir, { recursive: true, mode: 0o700 });
  // `mode` solo cuenta al crear: una carpeta que ya existía se ajusta aparte.
  await chmod(opts.dir, 0o700).catch(() => undefined);

  const tmp = join(opts.dir, `.endpoint-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, mine, { mode: 0o600, flag: 'wx' });

  let replacedStale = false;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        // Crear el enlace falla si el destino existe: exclusión atómica, y el
        // fichero aparece ya completo.
        await link(tmp, file);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
      }

      const current = await readOrNull(file);
      if (current === null) continue; // lo acaban de borrar: otra vuelta
      const owner = ownerOf(current);
      if (owner && isAlive(owner.pid) && (await probe(owner.ipcPath))) {
        throw new DaemonAlreadyRunningError(owner.pid);
      }
      if (attempt >= 3) throw new DaemonAlreadyRunningError(owner?.pid ?? 0);

      // Rancio. Solo se sustituye si sigue siendo el mismo fichero rancio que
      // se acaba de comprobar: otro arranque pudo adelantarse.
      if ((await readOrNull(file)) !== current) continue;
      await rename(tmp, file);
      replacedStale = true;
      // Dos arranques pudieron pasar la comprobación a la vez; gana el último
      // `rename`, y el que pierde lo ve aquí.
      await new Promise((r) => setTimeout(r, 25));
      const after = await readOrNull(file);
      if (after !== mine) throw new DaemonAlreadyRunningError(ownerOf(after ?? '')?.pid ?? 0);
      break;
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  await chmod(file, 0o600).catch(() => undefined);

  let released = false;
  return {
    file,
    endpoint: opts.endpoint,
    replacedStale,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Solo si sigue siendo el nuestro: tras un relevo, el fichero es de otro.
      if ((await readOrNull(file)) === mine) await unlink(file).catch(() => undefined);
    },
  };
}
