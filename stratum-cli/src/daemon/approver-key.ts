/**
 * Qué acredita a un cliente como **aprobador**.
 *
 * El token de `endpoint.json` autentica el acceso al canal y nada más: con él
 * solo, ninguna conexión obtiene la capacidad `approve`. Para resolver una
 * aprobación, una pregunta o un plan desde otro cliente hace falta además una
 * **clave de aprobador**: una frase que elige la persona y que teclea en cada
 * cliente que quiera aprobar.
 *
 * De esa clave, en disco solo hay una derivación (`scrypt`, con sal) en
 * `~/.stratum/daemon/approver.json`: quien lea el fichero no obtiene la clave.
 * La clave no se pasa por argumentos ni por variables de entorno, no se guarda
 * en claro, no se registra y no viaja en ningún evento.
 *
 * Sin el fichero no hay aprobadores: toda resolución remota se deniega, y las
 * solicitudes se contestan en la terminal del anfitrión, como antes.
 *
 * **Lo que esto no es.** No es una frontera frente a un proceso del mismo
 * usuario: ese proceso puede sustituir el fichero y reiniciar el daemon, o
 * leer la memoria de quien teclea la clave. Cierra los caminos ordinarios (un
 * comando lanzado por el agente que conoce el token no puede aprobar), no los
 * de un atacante con el control de la cuenta. Ver `docs/protocol.md` §15.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

export const APPROVER_KEY_FILE = 'approver.json';
/** Longitud mínima de la clave: se teclea, pero no puede ser trivial. */
export const APPROVER_KEY_MIN_CHARS = 8;

const KEY_BYTES = 32;
const DEFAULT_PARAMS = { N: 1 << 15, r: 8, p: 1 };

const hex = z.string().regex(/^[0-9a-f]+$/);
const fileSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('scrypt'),
    N: z
      .number()
      .int()
      .min(1 << 14)
      .max(1 << 20),
    r: z.number().int().min(8).max(32),
    p: z.number().int().min(1).max(4),
    salt: hex.min(32).max(128),
    hash: hex.length(KEY_BYTES * 2),
    createdAt: z.string(),
  })
  .strict();

type ApproverKeyFile = z.infer<typeof fileSchema>;

/** Comprueba una clave de aprobador. Nunca la guarda ni la registra. */
export interface ApproverAuth {
  verify(key: string): Promise<boolean>;
}

export function approverKeyPath(dir: string): string {
  return join(dir, APPROVER_KEY_FILE);
}

function derive(key: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      key.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { ...params, maxmem: 256 * params.N * params.r },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
}

function authFrom(file: ApproverKeyFile): ApproverAuth {
  const salt = Buffer.from(file.salt, 'hex');
  const expected = Buffer.from(file.hash, 'hex');
  return {
    async verify(key) {
      try {
        const got = await derive(key, salt, file);
        return got.length === expected.length && timingSafeEqual(got, expected);
      } catch {
        return false;
      }
    },
  };
}

/**
 * La acreditación de aprobadores configurada en esa carpeta, o `null` si no hay
 * ninguna. Un fichero que no valida es como si no existiera —**falla cerrado**:
 * sin aprobadores—, y se dice por `onInvalid`.
 */
export function loadApproverAuth(dir: string, onInvalid?: () => void): ApproverAuth | null {
  let text: string;
  try {
    text = readFileSync(approverKeyPath(dir), 'utf8');
  } catch {
    return null;
  }
  try {
    return authFrom(fileSchema.parse(JSON.parse(text)));
  } catch {
    onInvalid?.();
    return null;
  }
}

/**
 * Guarda la derivación de una clave nueva, sustituyendo la que hubiera. El
 * daemon la lee al arrancar: uno en marcha sigue con la anterior.
 *
 * @throws Error si la clave es demasiado corta.
 */
export async function writeApproverKey(dir: string, key: string): Promise<string> {
  if (key.normalize('NFKC').length < APPROVER_KEY_MIN_CHARS) {
    throw new Error(`The approver key needs at least ${APPROVER_KEY_MIN_CHARS} characters.`);
  }
  const salt = randomBytes(16);
  const hash = await derive(key, salt, DEFAULT_PARAMS);
  const file: ApproverKeyFile = {
    version: 1,
    algorithm: 'scrypt',
    ...DEFAULT_PARAMS,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = approverKeyPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* sin permisos POSIX (Windows): el fichero queda con los de la carpeta */
  }
  renameSync(tmp, path);
  return path;
}

/** Acreditación en memoria, para tests y para quien inyecta la suya. */
export async function approverAuthFromKey(key: string): Promise<ApproverAuth> {
  const salt = randomBytes(16);
  const params = { N: 1 << 14, r: 8, p: 1 };
  const hash = await derive(key, salt, params);
  return authFrom({
    version: 1,
    algorithm: 'scrypt',
    ...params,
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    createdAt: '',
  });
}
