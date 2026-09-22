import { createHash } from 'crypto';
import { createReadStream, createWriteStream, lstatSync, readdirSync } from 'fs';
import { mkdir, open, rm } from 'fs/promises';
import { dirname, join, posix, resolve, sep } from 'path';
import { Transform, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import * as tar from 'tar-stream';

/**
 * Compresión de un workspace a `tar.gz` (Stratum Desktop D3). JS puro —`zlib`
 * de Node y `tar-stream`—, porque tiene que funcionar dentro del SEA.
 *
 * Solo se archivan directorios y ficheros regulares: los enlaces se saltan (no
 * se sigue nada que apunte fuera del workspace) y al extraer se rechaza todo
 * tipo de entrada que no sea esos dos, igual que cualquier nombre absoluto o
 * con `..`. El archivo es nuestro, pero vive en disco y se puede manipular.
 */

export interface ArchiveEntry {
  /** Ruta relativa con `/`. Los directorios terminan sin barra. */
  path: string;
  type: 'file' | 'directory';
  size: number;
  /** sha256 en hexadecimal (solo ficheros). */
  sha256?: string;
}

export type ArchiveManifest = ArchiveEntry[];

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

interface Walked {
  path: string;
  abs: string;
  type: 'file' | 'directory';
  size: number;
  mode: number;
  mtime: Date;
}

function walk(dir: string, rel: string, out: Walked[]): void {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push({ path, abs, type: 'directory', size: 0, mode: 0o755, mtime: st.mtime });
      walk(abs, path, out);
    } else if (st.isFile()) {
      out.push({ path, abs, type: 'file', size: st.size, mode: 0o644, mtime: st.mtime });
    }
  }
}

/** Transform que calcula el sha256 y cuenta bytes de lo que pasa por él. */
function hashing(): Transform & { digest(): string; bytes(): number } {
  const hash = createHash('sha256');
  let bytes = 0;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  }) as Transform & { digest(): string; bytes(): number };
  t.digest = () => hash.digest('hex');
  t.bytes = () => bytes;
  return t;
}

/** Escribe el fichero y lo lleva a disco antes de devolver (sobrevive a un corte de luz). */
async function fsyncFile(path: string): Promise<void> {
  const fh = await open(path, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Empaqueta `dir` en `archivePath` (se sobrescribe) y devuelve lo que metió.
 * El fichero queda sincronizado en disco. Lanza si algo cambia de tamaño
 * mientras se empaqueta: el llamador descarta el archivo y conserva la carpeta.
 */
export async function packDirectory(dir: string, archivePath: string): Promise<ArchiveManifest> {
  const entries: Walked[] = [];
  walk(dir, '', entries);
  const pack = tar.pack();
  const manifest: ArchiveManifest = [];

  const feed = (async () => {
    for (const e of entries) {
      if (e.type === 'directory') {
        await new Promise<void>((res, rej) =>
          pack.entry({ name: e.path, type: 'directory', mode: e.mode, mtime: e.mtime }, (err) =>
            err ? rej(err) : res(),
          ),
        );
        manifest.push({ path: e.path, type: 'directory', size: 0 });
        continue;
      }
      const h = hashing();
      let entry!: NodeJS.WritableStream;
      // tar-stream valida el tamaño declarado al cerrar la entrada: si el
      // fichero creció o encogió, el callback llega con error.
      const done = new Promise<void>((res, rej) => {
        entry = pack.entry(
          { name: e.path, type: 'file', size: e.size, mode: e.mode, mtime: e.mtime },
          (err) => (err ? rej(err) : res()),
        ) as unknown as NodeJS.WritableStream;
      });
      await Promise.all([pipeline(createReadStream(e.abs), h, entry), done]);
      if (h.bytes() !== e.size) {
        throw new ArchiveError(`«${e.path}» cambió de tamaño mientras se comprimía`);
      }
      manifest.push({ path: e.path, type: 'file', size: e.size, sha256: h.digest() });
    }
    pack.finalize();
  })();
  // Si el feed falla, el pack se destruye para que el pipeline no quede colgado.
  feed.catch((err: Error) => pack.destroy(err));

  await Promise.all([
    feed,
    pipeline(
      pack as unknown as NodeJS.ReadableStream,
      createGzip({ level: 6 }),
      createWriteStream(archivePath),
    ),
  ]);
  await fsyncFile(archivePath);
  return manifest;
}

/** Nombre de entrada seguro: relativo, sin `..`, sin unidad, sin barra invertida. */
function safeEntryPath(name: string): string | null {
  const trimmed = name.replace(/\/+$/, '');
  if (trimmed === '' || trimmed.includes('\\') || trimmed.includes('\0')) return null;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return null;
  const norm = posix.normalize(trimmed);
  if (norm !== trimmed || norm === '..' || norm.startsWith('../') || norm === '.') return null;
  return norm;
}

/**
 * Recorre el archivo entrada a entrada. Con `destDir`, además extrae. Devuelve
 * el manifiesto de lo leído (con sha256 de cada fichero).
 */
async function readArchive(archivePath: string, destDir?: string): Promise<ArchiveManifest> {
  const extract = tar.extract();
  const manifest: ArchiveManifest = [];
  const root = destDir ? resolve(destDir) : null;

  const consume = (async () => {
    for await (const entry of extract) {
      const { header } = entry;
      const path = safeEntryPath(header.name);
      if (!path) throw new ArchiveError(`entrada con nombre no válido: ${header.name}`);
      const target = root ? resolve(root, ...path.split('/')) : null;
      if (target && !target.startsWith(root + sep)) {
        throw new ArchiveError(`entrada fuera del destino: ${header.name}`);
      }
      if (header.type === 'directory') {
        if (target) await mkdir(target, { recursive: true });
        manifest.push({ path, type: 'directory', size: 0 });
        entry.resume();
        continue;
      }
      if (header.type !== 'file') {
        throw new ArchiveError(`tipo de entrada no admitido (${header.type}): ${header.name}`);
      }
      const h = hashing();
      if (target) {
        await mkdir(dirname(target), { recursive: true });
        await pipeline(
          entry as unknown as NodeJS.ReadableStream,
          h,
          createWriteStream(target, { flags: 'wx' }),
        );
      } else {
        await pipeline(
          entry as unknown as NodeJS.ReadableStream,
          h,
          new Writable({
            write(_c, _e, cb) {
              cb();
            },
          }),
        );
      }
      manifest.push({ path, type: 'file', size: h.bytes(), sha256: h.digest() });
    }
  })();
  consume.catch(() => extract.destroy());

  await Promise.all([
    pipeline(
      createReadStream(archivePath),
      createGunzip(),
      extract as unknown as NodeJS.WritableStream,
    ),
    consume,
  ]);
  return manifest;
}

function sameManifest(a: ArchiveManifest, b: ArchiveManifest): string | null {
  const key = (e: ArchiveEntry) => `${e.type}:${e.path}:${e.size}:${e.sha256 ?? ''}`;
  const left = new Set(a.map(key));
  const right = new Set(b.map(key));
  for (const k of left) if (!right.has(k)) return k.split(':')[1] ?? k;
  for (const k of right) if (!left.has(k)) return k.split(':')[1] ?? k;
  return null;
}

/**
 * Lee el archivo entero y comprueba que contiene exactamente `expected`
 * (mismas rutas, tamaños y sha256). Lanza `ArchiveError` si no.
 */
export async function verifyArchive(archivePath: string, expected: ArchiveManifest): Promise<void> {
  let actual: ArchiveManifest;
  try {
    actual = await readArchive(archivePath);
  } catch (err) {
    throw new ArchiveError(
      `el archivo no se puede leer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const diff = sameManifest(expected, actual);
  if (diff !== null) throw new ArchiveError(`el archivo no coincide con la carpeta (${diff})`);
}

/**
 * Extrae `archivePath` en `destDir` (que no debe existir) y devuelve el
 * manifiesto. Si falla, borra lo que llegó a extraer.
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<ArchiveManifest> {
  await mkdir(destDir, { recursive: false });
  try {
    return await readArchive(archivePath, destDir);
  } catch (err) {
    await rm(destDir, { recursive: true, force: true });
    throw err instanceof ArchiveError
      ? err
      : new ArchiveError(`no se pudo extraer: ${err instanceof Error ? err.message : String(err)}`);
  }
}
