import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  type Stats,
} from 'fs';
import { basename, dirname, join } from 'path';
import { createHash, randomBytes } from 'crypto';

/**
 * E/S de texto de `write_file` / `edit_file`: los ficheros son del usuario, no
 * de Stratum, así que perder uno es peor que perder una sesión.
 *
 * - **Atómica**: temporal en el mismo directorio + fsync + rename. Un proceso
 *   que muere a mitad deja el fichero anterior intacto, nunca uno truncado.
 * - **Conserva** BOM, finales de línea (CRLF), permisos y el destino de un
 *   symlink (se escribe en el fichero real, el enlace sigue siendo enlace). Con
 *   varios hard links se escribe en sitio: el rename rompería el enlace.
 * - **Rechaza** lo que no sabe reescribir sin corromperlo: binarios, UTF-16 y
 *   UTF-8 inválido. Decodificar con reemplazo (U+FFFD) y volver a escribir
 *   destrozaría todo el fichero en silencio, no solo la línea editada.
 * - **Concurrencia optimista**: si el fichero cambió entre la lectura y el
 *   rename, no se escribe (`FileChangedError`).
 */

export type Eol = 'lf' | 'crlf';

export interface TextFile {
  /** Contenido sin BOM. */
  text: string;
  bom: boolean;
  /** Final de línea dominante. `lf` si no hay ninguno. */
  eol: Eol;
  /** Firma del fichero leído, para detectar cambios antes de reescribirlo. */
  signature: FileSignature;
}

export interface FileSignature {
  mtimeMs: number;
  size: number;
  /** sha1 del contenido crudo: un `touch` o un checkout idéntico no es un cambio. */
  hash: string;
}

/** El fichero no se puede tratar como texto UTF-8 sin corromperlo. */
export class UnsupportedEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEncodingError';
  }
}

/** El fichero cambió en disco entre la lectura y la escritura. */
export class FileChangedError extends Error {
  constructor(message = 'the file changed on disk while it was being edited') {
    super(message);
    this.name = 'FileChangedError';
  }
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BINARY_SNIFF_BYTES = 8192;

export function hashContent(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function signatureOf(buf: Buffer, st: Pick<Stats, 'mtimeMs' | 'size'>): FileSignature {
  return { mtimeMs: st.mtimeMs, size: st.size, hash: hashContent(buf) };
}

/** Decodifica un buffer como texto editable o lanza `UnsupportedEncodingError`. */
export function decodeText(buf: Buffer): { text: string; bom: boolean } {
  if (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  ) {
    throw new UnsupportedEncodingError('the file is UTF-16 encoded; only UTF-8 can be edited');
  }
  const bom = buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM);
  const body = bom ? buf.subarray(3) : buf;
  if (body.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new UnsupportedEncodingError('the file looks binary (contains NUL bytes)');
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    return { text, bom };
  } catch {
    throw new UnsupportedEncodingError(
      'the file is not valid UTF-8 (legacy encoding such as Latin-1/Windows-1252?); ' +
        'rewriting it would corrupt every non-ASCII character',
    );
  }
}

/** Final de línea dominante: CRLF solo si hay más `\r\n` que `\n` sueltos. */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text[i - 1] === '\r') crlf++;
    else lf++;
  }
  return crlf > lf ? 'crlf' : 'lf';
}

/** Convierte los `\n` sueltos en `\r\n`; los `\r\n` existentes no se duplican. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export function readTextFile(path: string): TextFile {
  const buf = readFileSync(path);
  const st = statSync(path);
  const { text, bom } = decodeText(buf);
  return { text, bom, eol: detectEol(text), signature: signatureOf(buf, st) };
}

/** Firma actual del fichero, o `null` si no existe. */
export function currentSignature(path: string): FileSignature | null {
  let st: Stats;
  try {
    st = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!st.isFile()) return null;
  return signatureOf(readFileSync(path), st);
}

/** ¿Es la misma versión? mtime+tamaño iguales bastan; si no, decide el contenido. */
export function sameVersion(a: FileSignature, b: FileSignature): boolean {
  if (a.size !== b.size) return false;
  if (a.mtimeMs === b.mtimeMs) return true;
  return a.hash === b.hash;
}

export interface WriteTextOptions {
  bom?: boolean;
  /**
   * Firma que el fichero debe tener justo antes del rename. Ausente → no se
   * comprueba (fichero nuevo o sobrescritura sin lectura previa).
   */
  expected?: FileSignature;
}

/** Códigos con los que Windows rechaza un rename sobre un fichero abierto por otro proceso. */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename con reintentos: en Windows un antivirus o un indexador que tiene el
 * destino abierto un instante hace fallar el rename con EPERM/EBUSY.
 */
export function renameWithRetry(from: string, to: string): void {
  let delay = 10;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME.has(code) || attempt >= 8) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

function assertUnchanged(path: string, expected: FileSignature | undefined): void {
  if (!expected) return;
  const now = currentSignature(path);
  if (!now || !sameVersion(expected, now)) throw new FileChangedError();
}

/**
 * Escribe `text` en `path` de forma atómica. Devuelve la firma del fichero
 * escrito (para registrar la nueva versión como «leída»).
 */
export function writeTextFileAtomic(
  path: string,
  text: string,
  opts: WriteTextOptions = {},
): FileSignature {
  const body = Buffer.from(text, 'utf-8');
  const data = opts.bom ? Buffer.concat([UTF8_BOM, body]) : body;

  let existing: Stats | null = null;
  let target = path;
  try {
    // Un symlink se sigue: se reescribe el fichero real y el enlace se conserva.
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
    existing = statSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing && !existing.isFile()) {
    throw new Error(`"${path}" exists and is not a regular file`);
  }
  mkdirSync(dirname(target), { recursive: true });

  if (existing && existing.nlink > 1) {
    // Hard links: el rename dejaría a los demás nombres con el contenido viejo.
    // Se escribe en sitio, sin atomicidad, que es lo que el usuario espera.
    assertUnchanged(target, opts.expected);
    writeFileSync(target, data);
    return signatureOf(data, statSync(target));
  }

  const mode = existing ? existing.mode & 0o7777 : 0o666;
  const tmp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.stratum-tmp`,
  );
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      let off = 0;
      while (off < data.length) off += writeSync(fd, data, off, data.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // `openSync` aplica la umask; los permisos del original se restauran tal cual.
    if (existing) chmodSync(tmp, mode);
    assertUnchanged(target, opts.expected);
    renameWithRetry(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return signatureOf(data, statSync(target));
}
