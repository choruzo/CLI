/**
 * M18 parte 6E — las imágenes que el asistente (`companion`) envía al chat con
 * `send_image` (`docs/PRD_STRATUM_DOT.md` §23.11).
 *
 * Al enviarla, la imagen se **copia** aquí (`~/.stratum/companion/shared/`): la
 * conversación lleva solo su id, y quien la enseña (Dot por `images.get`, el
 * canal de Telegram) lee esta copia, así que lo que el asistente haga luego con
 * el original de `/exchange` no cambia el historial. Caduca como lo pegado
 * (`IMAGE_RETENTION_MS`); la purga va al guardar, sin proceso propio.
 *
 * Leer es una frontera: el id llega de un cliente. Solo vale un id con la forma
 * que da `saveSharedImage` (sin separadores de ruta), y lo leído se comprueba
 * otra vez (≤ `USER_IMAGE_LIMITS.maxBytes`, firma de imagen admitida).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sniffImageMime, USER_IMAGE_LIMITS, type UserImageMime } from '../agent/user-images.js';
import { purgeExpiredImages, UserImageError } from './store.js';

/** `<fecha>-<sha256 corto>.<ext>` sin la extensión: no puede salir de su carpeta. */
export const SHARED_IMAGE_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;

const EXT: Record<UserImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function sharedImagesDir(companionDataDir: string): string {
  return join(companionDataDir, 'shared');
}

export interface SharedImageInfo {
  id: string;
  mime: UserImageMime;
  bytes: number;
}

export interface SharedImage extends SharedImageInfo {
  data: Buffer;
}

function check(bytes: Uint8Array): UserImageMime {
  if (bytes.length > USER_IMAGE_LIMITS.maxBytes) {
    throw new UserImageError(
      `The image is too large (${Math.round(bytes.length / 1024)} KB; the limit is ${USER_IMAGE_LIMITS.maxBytes / 1024 / 1024} MB).`,
    );
  }
  const mime = sniffImageMime(bytes);
  if (!mime) throw new UserImageError('The file is not a PNG, JPEG, WebP or GIF image.');
  return mime;
}

/**
 * Copia una imagen al almacén y devuelve su id. Escritura atómica.
 *
 * @throws UserImageError si no es una imagen admitida o pesa demasiado.
 */
export function saveSharedImage(
  bytes: Uint8Array,
  opts: { dir: string; now?: number },
): SharedImageInfo {
  const mime = check(bytes);
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  purgeExpiredImages(opts.dir, opts.now);
  const stamp = new Date(opts.now ?? Date.now()).toISOString().replace(/[-:]|\.\d+/g, '');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const id = `${stamp}-${sha.slice(0, 16)}`;
  const path = join(opts.dir, `${id}.${EXT[mime]}`);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return { id, mime, bytes: bytes.length };
}

/**
 * Lee una imagen del almacén por su id, o `null` si no existe (caducó o nunca
 * estuvo). Un id con otra forma es `null` sin tocar el disco.
 *
 * @throws UserImageError si lo que hay ya no es una imagen admitida.
 */
export function readSharedImage(id: string, dir: string): SharedImage | null {
  if (!SHARED_IMAGE_ID_RE.test(id)) return null;
  for (const [mime, ext] of Object.entries(EXT) as [UserImageMime, string][]) {
    const path = join(dir, `${id}.${ext}`);
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size > USER_IMAGE_LIMITS.maxBytes) throw new UserImageError('The image is too large.');
    const data = readFileSync(path);
    if (check(data) !== mime) throw new UserImageError('The image does not match its type.');
    return { id, mime, bytes: data.length, data };
  }
  return null;
}
