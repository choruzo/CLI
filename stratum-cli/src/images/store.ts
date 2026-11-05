/**
 * Dónde viven las imágenes que pega el usuario y cómo se cargan para el modelo.
 *
 * Una imagen pegada (portapapeles de la CLI o de Desktop) se guarda en
 * `~/.stratum/images/` y caduca a los `IMAGE_RETENTION_MS`: la purga va al
 * guardar y al cargar, sin proceso propio. Un adjunto que ya es un fichero de
 * la sesión (los `inputs/` de Desktop) se lee donde está.
 *
 * Cargar es una frontera: el daemon recibe rutas de un cliente. Solo se lee
 * una ruta cuyo `realpath` cae dentro de las raíces que pasa quien llama (el
 * `cwd` de la sesión y este directorio), que pese como mucho
 * `USER_IMAGE_LIMITS.maxBytes` y cuyos primeros bytes sean de una imagen
 * admitida. Cualquier otra cosa lanza `UserImageError`, nunca se lee a medias.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  sniffImageMime,
  USER_IMAGE_LIMITS,
  type UserImage,
  type UserImageMime,
} from '../agent/user-images.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('images');

/** 15 días. */
export const IMAGE_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;

export function userImagesDir(home: string = homedir()): string {
  return join(home, '.stratum', 'images');
}

export class UserImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserImageError';
  }
}

const EXT: Record<UserImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Borra las imágenes de `dir` con más de `IMAGE_RETENTION_MS`. Nunca lanza: un
 * fallo de la purga no es un fallo de quien guarda o carga una imagen.
 */
export function purgeExpiredImages(dir: string = userImagesDir(), now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && now - st.mtimeMs > IMAGE_RETENTION_MS) {
        rmSync(path, { force: true });
        removed++;
      }
    } catch (err) {
      log.debug('image purge skipped a file', { name, err });
    }
  }
  return removed;
}

/**
 * Guarda una imagen pegada y devuelve su ruta. Escritura atómica (temporal +
 * rename). Lanza `UserImageError` si no es una imagen admitida o pesa demasiado.
 */
export function saveUserImage(
  bytes: Uint8Array,
  opts: { dir?: string; now?: number } = {},
): string {
  const dir = opts.dir ?? userImagesDir();
  const mime = checkBytes(bytes, 'clipboard image');
  mkdirSync(dir, { recursive: true });
  purgeExpiredImages(dir, opts.now);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const stamp = new Date(opts.now ?? Date.now()).toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-${sha.slice(0, 12)}.${EXT[mime]}`);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

function tooLarge(label: string, size: number): UserImageError {
  return new UserImageError(
    `${label} is too large (${Math.round(size / 1024)} KB; the limit is ${USER_IMAGE_LIMITS.maxBytes / 1024 / 1024} MB).`,
  );
}

function checkBytes(bytes: Uint8Array, label: string): UserImageMime {
  if (bytes.length > USER_IMAGE_LIMITS.maxBytes) throw tooLarge(label, bytes.length);
  const mime = sniffImageMime(bytes);
  if (!mime) throw new UserImageError(`${label} is not a PNG, JPEG, WebP or GIF image.`);
  return mime;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Carga la imagen de `path` (absoluta, o relativa a `cwd`) para mandarla al
 * modelo. `roots`: únicos directorios de los que se puede leer, comparados por
 * `realpath` (un enlace que salga de ellos se rechaza).
 */
export function loadUserImage(
  path: string,
  opts: { cwd: string; roots: readonly string[] },
): UserImage {
  const abs = resolve(opts.cwd, path);
  const label = basename(abs) || 'image';
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new UserImageError(`${label}: file not found.`);
  }
  const allowed = opts.roots.some((root) => {
    try {
      return inside(realpathSync(root), real);
    } catch {
      return false;
    }
  });
  if (!allowed)
    throw new UserImageError(
      `${label}: images can only be read from the session folder or ~/.stratum/images.`,
    );
  const st = statSync(real);
  if (!st.isFile()) throw new UserImageError(`${label}: not a file.`);
  // Antes de leer: un fichero enorme no se carga en memoria para rechazarlo.
  if (st.size > USER_IMAGE_LIMITS.maxBytes) throw tooLarge(label, st.size);
  const bytes = readFileSync(real);
  const mime = checkBytes(bytes, label);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    id: `img-${sha256.slice(0, 12)}`,
    name: label,
    mime,
    data: bytes.toString('base64'),
    bytes: bytes.length,
    sha256,
  };
}

/**
 * M18 parte 6E — una imagen que llega en memoria (una foto de Telegram), con
 * las mismas comprobaciones que una leída de disco: firma de imagen admitida y
 * `USER_IMAGE_LIMITS.maxBytes`. No se guarda en ningún sitio.
 *
 * @throws UserImageError si no es una imagen admitida o pesa demasiado.
 */
export function userImageFromBytes(bytes: Uint8Array, name: string): UserImage {
  const mime = checkBytes(bytes, name);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return {
    id: `img-${sha256.slice(0, 12)}`,
    name,
    mime,
    data: buf.toString('base64'),
    bytes: buf.length,
    sha256,
  };
}

/**
 * Carga las imágenes de un mensaje. Todas o ninguna: una que falla rechaza el
 * mensaje entero (el usuario las adjuntó a ese texto). Purga de paso lo caducado.
 */
export function loadUserImages(
  paths: readonly string[],
  opts: { cwd: string; roots?: readonly string[]; home?: string },
): UserImage[] {
  if (paths.length === 0) return [];
  if (paths.length > USER_IMAGE_LIMITS.perMessage) {
    throw new UserImageError(`At most ${USER_IMAGE_LIMITS.perMessage} images per message.`);
  }
  const dir = userImagesDir(opts.home);
  purgeExpiredImages(dir);
  const roots = opts.roots ?? [opts.cwd, dir];
  return paths.map((p) => loadUserImage(p, { cwd: opts.cwd, roots }));
}
