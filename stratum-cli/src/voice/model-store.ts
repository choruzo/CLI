/**
 * M25 (voz) — el modelo en disco: `~/.stratum/models/canary-1b-v2/`.
 *
 * Reglas que no se negocian:
 * - la descarga va a una carpeta **temporal** y se publica con un `rename`
 *   atómico; el directorio bueno nunca se ve a medias;
 * - cada fichero se comprueba (tamaño y SHA-256) antes de publicarlo, y una
 *   suma que no cuadra tira la descarga entera;
 * - la marca `stratum-model.json` se escribe de forma atómica y se valida con
 *   Zod al leer;
 * - **falla cerrado**: si el estado no es `ready`, el worker no carga el modelo.
 *
 * **Al cargar no se recalcula el SHA-256**: son ~4 GB y tardan ~75 s en cada
 * arranque del worker, así que la suma se comprueba al descargar y con
 * `stratum voice status --verify`. Lo que se cubre al cargar es la corrupción
 * accidental o un fichero cambiado por error —tamaño, `mtime` e `ino` contra la
 * marca, y que la ruta no pase por ningún enlace—, no a un atacante con
 * escritura en el `home`: ese ya puede cambiar la propia CLI.
 *
 * Todas las funciones aceptan `dir` (y los tests les pasan un manifiesto
 * pequeño): así se prueba con ficheros de verdad, sin 4 GB de por medio.
 */

import { createHash, randomBytes } from 'crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
} from 'fs';
import { statfs as fsStatfs } from 'fs/promises';
import { once } from 'events';
import { basename, dirname, join, resolve } from 'path';
import { z } from 'zod';
import { expandHome } from '../config/paths.js';
import { writeFileAtomic } from '../config/writer.js';
import { VOICE_MODEL_FILES, VOICE_MODEL_ID, type VoiceModelFile } from './manifest.js';

/** Nombre de la marca, dentro del directorio del modelo. */
export const VOICE_MODEL_MARKER = 'stratum-model.json';

/** Versión del formato de la marca. Uno de un Stratum más nuevo no se interpreta. */
export const VOICE_MODEL_MARKER_VERSION = 1;

/** Espacio libre que debe sobrar además del modelo entero (descarga + `rename`). */
export const VOICE_MODEL_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

/** Un cerrojo sin latido en 5 min es de un proceso que ya no está. */
export const VOICE_MODEL_LOCK_STALE_MS = 5 * 60_000;

/** Cada cuánto se refresca el `mtime` del cerrojo mientras dura la descarga. */
export const VOICE_MODEL_LOCK_HEARTBEAT_MS = 30_000;

/** Saltos de redirección que se siguen a mano (una descarga no encadena más). */
export const VOICE_MODEL_MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Errores con nombre: la CLI y el worker dan un mensaje claro para cada uno
// ---------------------------------------------------------------------------

/** Otra descarga tiene el cerrojo tomado y su proceso sigue vivo. */
export class VoiceModelBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelBusyError';
  }
}

/** No hay espacio para el modelo más el margen. */
export class VoiceModelSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelSpaceError';
  }
}

/** Un fichero no cuadra con el tamaño o la suma fijados en el código. */
export class VoiceModelIntegrityError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'VoiceModelIntegrityError';
  }
}

/** El `rename` falló porque alguien (el worker) tiene los ficheros abiertos. */
export class VoiceModelInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelInUseError';
  }
}

/** La descarga respondió algo que no es un 2xx, no trajo cuerpo o saltó a donde no debe. */
export class VoiceModelDownloadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VoiceModelDownloadError';
  }
}

/** El modelo no está listo para cargarse (falta, está a medias o no cuadra). */
export class VoiceModelNotReadyError extends Error {
  constructor(
    message: string,
    readonly state?: VoiceModelState,
  ) {
    super(message);
    this.name = 'VoiceModelNotReadyError';
  }
}

/** El manifiesto del código no es un manifiesto válido (rutas o duplicados). */
export class VoiceModelManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelManifestError';
  }
}

/** `dir` no es un directorio del modelo de voz, o pasa por un enlace. */
export class VoiceModelPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceModelPathError';
  }
}

/** El modelo nuevo no se publicó y el anterior tampoco volvió a su sitio. */
export class VoiceModelRollbackError extends Error {
  constructor(
    message: string,
    /** Dónde quedó el modelo anterior (el `.old-…`). */
    readonly path: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'VoiceModelRollbackError';
  }
}

/** Todo se hizo, pero un temporal no se dejó borrar (queda la ruta en disco). */
export class VoiceModelCleanupError extends Error {
  constructor(readonly path: string) {
    super(`no se pudo borrar el temporal ${path}; bórralo a mano`);
    this.name = 'VoiceModelCleanupError';
  }
}

// ---------------------------------------------------------------------------
// La marca
// ---------------------------------------------------------------------------

const MarkerFileSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mtimeMs: z.number(),
  /**
   * Inodo del fichero, como texto. **Opcional a propósito**: una marca escrita
   * por la primera versión de la fase 2 no lo trae, y eso es corrupción (no se
   * sabe si el fichero es el mismo), no una marca vieja de otro manifiesto.
   */
  ino: z.string().min(1).optional(),
});

const MarkerSchema = z.object({
  schemaVersion: z.literal(VOICE_MODEL_MARKER_VERSION),
  model: z.string().min(1),
  files: z.array(MarkerFileSchema),
});

export type VoiceModelMarker = z.infer<typeof MarkerSchema>;

type MarkerState =
  | { kind: 'missing' }
  /** Existe pero no es una marca válida: no cuadra con el manifiesto del código. */
  | { kind: 'invalid' }
  /** Existe pero no es un fichero normal (un enlace, un directorio): no se abre. */
  | { kind: 'notAFile' }
  | { kind: 'ok'; marker: VoiceModelMarker };

function readMarker(dir: string): MarkerState {
  const file = join(dir, VOICE_MODEL_MARKER);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    return { kind: 'missing' };
  }
  // Solo se abre un fichero normal: ni enlaces ni nada que no sea la marca.
  if (!stat.isFile()) return { kind: 'notAFile' };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return { kind: 'invalid' };
  }
  const parsed = MarkerSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid' };
  if (parsed.data.model !== VOICE_MODEL_ID) return { kind: 'invalid' };
  return { kind: 'ok', marker: parsed.data };
}

/** ¿La marca describe exactamente el manifiesto del código? */
function markerMatchesManifest(
  marker: VoiceModelMarker,
  manifest: readonly VoiceModelFile[],
): boolean {
  if (marker.files.length !== manifest.length) return false;
  const byPath = new Map(marker.files.map((f) => [f.path, f]));
  return manifest.every((file) => {
    const entry = byPath.get(file.path);
    return entry !== undefined && entry.size === file.size && entry.sha256 === file.sha256;
  });
}

/** `ino` del fichero como texto: `bigint` porque un inodo de Windows no cabe en un `number` exacto. */
function inoOf(path: string): string {
  return String(lstatSync(path, { bigint: true }).ino);
}

// ---------------------------------------------------------------------------
// Rutas, manifiesto y estado
// ---------------------------------------------------------------------------

/** `~/.stratum/models/canary-1b-v2`: donde vive el modelo. */
export function voiceModelDir(): string {
  return join(expandHome('~/.stratum/models'), VOICE_MODEL_ID);
}

/**
 * Un `path` del manifiesto es **un nombre de fichero**, no una ruta: sin
 * separadores, sin `..` y sin rutas absolutas. El manifiesto es código, y un
 * `join(dir, path)` con `../..` escribiría fuera del directorio del modelo.
 */
const MODEL_FILE_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validateManifest(manifest: readonly VoiceModelFile[]): void {
  const seen = new Set<string>();
  for (const file of manifest) {
    if (!MODEL_FILE_PATH_RE.test(file.path)) {
      throw new VoiceModelManifestError(
        `el manifiesto trae una ruta que no es un nombre de fichero simple: "${file.path}"`,
      );
    }
    if (seen.has(file.path)) {
      throw new VoiceModelManifestError(`el manifiesto repite el fichero "${file.path}"`);
    }
    seen.add(file.path);
  }
}

/** En Windows la comparación de rutas no distingue mayúsculas. */
function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `dir` tiene que ser exactamente `…/canary-1b-v2`: nada de escribir donde no toca. */
function assertModelDirName(dir: string): void {
  if (basename(resolve(dir)) !== VOICE_MODEL_ID) {
    throw new VoiceModelPathError(
      `"${dir}" no es un directorio del modelo de voz: tiene que llamarse "${VOICE_MODEL_ID}"`,
    );
  }
}

/** Un enlace (o una junction) en el padre podría llevar el modelo a otro sitio. */
function assertParentHasNoLinks(parent: string): void {
  let real: string;
  try {
    real = realpathSync.native(parent);
  } catch (err) {
    throw new VoiceModelPathError(`no se pudo resolver ${parent}: ${errorMessage(err)}`);
  }
  if (!samePath(real, resolve(parent))) {
    throw new VoiceModelPathError(
      `${parent} pasa por un enlace (la ruta real es ${real}); el modelo no se toca ahí`,
    );
  }
}

export type VoiceModelState = 'missing' | 'incomplete' | 'outdated' | 'corrupt' | 'ready';

export interface VoiceModelFileStatus {
  path: string;
  expectedSize: number;
  /** Tamaño real, si el fichero existe. */
  size?: number;
  /** `undefined` cuando no se verificó la suma; nunca `true` sin calcularla. */
  sha256Ok?: boolean;
}

export interface VoiceModelStatus {
  state: VoiceModelState;
  files: VoiceModelFileStatus[];
}

export interface VoiceModelStatusOptions {
  dir: string;
  /** Calcula el SHA-256 de todos los ficheros (lento: son ~4 GB). */
  verify?: boolean;
  /** Manifiesto esperado. Los tests usan uno pequeño. */
  manifest?: readonly VoiceModelFile[];
}

/** SHA-256 y tamaño de un fichero, en streaming (nunca se carga entero en memoria). */
function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve_, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path, { highWaterMark: 1 << 20 });
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve_({ sha256: hash.digest('hex'), bytes }));
  });
}

/**
 * Estado del modelo. Sin `verify` no se calcula ninguna suma (solo `lstat` y
 * la marca); con `verify` se calculan todas, en streaming.
 *
 * Prioridad: `corrupt` (cualquier daño observado o un enlace en la ruta) gana a
 * `incomplete`, y `incomplete` a `outdated`.
 */
export async function voiceModelStatus(opts: VoiceModelStatusOptions): Promise<VoiceModelStatus> {
  const { dir } = opts;
  const manifest = opts.manifest ?? VOICE_MODEL_FILES;
  validateManifest(manifest);
  const files: VoiceModelFileStatus[] = manifest.map((f) => ({
    path: f.path,
    expectedSize: f.size,
  }));

  let dirStat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(dir);
  } catch {
    return { state: 'missing', files };
  }
  if (!dirStat.isDirectory()) return { state: 'corrupt', files };

  let corrupt = false;
  // Sin enlaces en la ruta: `lstat` ya rechaza un enlace en el propio `dir`, y
  // la ruta real rechaza una junction (o un enlace en cualquier ancestro).
  try {
    if (!samePath(realpathSync.native(dir), resolve(dir))) corrupt = true;
  } catch {
    corrupt = true;
  }

  const markerState = readMarker(dir);
  if (markerState.kind === 'notAFile') corrupt = true;
  const marker = markerState.kind === 'ok' ? markerState.marker : undefined;
  const markersByPath = new Map((marker?.files ?? []).map((f) => [f.path, f]));
  const outdated =
    markerState.kind === 'invalid' ||
    (marker !== undefined && !markerMatchesManifest(marker, manifest));

  let incomplete = markerState.kind === 'missing';

  for (let i = 0; i < files.length; i++) {
    const file = manifest[i]!;
    const entry = files[i]!;
    const full = join(dir, file.path);
    let stat: ReturnType<typeof lstatSync>;
    let ino: string;
    try {
      stat = lstatSync(full);
      ino = inoOf(full);
    } catch {
      incomplete = true;
      continue;
    }
    entry.size = stat.size;
    // Un enlace no vale: ONNX Runtime 1.31 rechaza los datos externos que no
    // son ficheros reales («escapes model directory»).
    if (!stat.isFile()) {
      corrupt = true;
      continue;
    }
    if (stat.size !== file.size) corrupt = true;
    const marked = markersByPath.get(file.path);
    // Tamaño, `mtime` e `ino`: los tres, o no se sabe que sea el mismo fichero.
    if (marked && (marked.mtimeMs !== stat.mtimeMs || marked.ino !== ino)) corrupt = true;
    if (opts.verify) {
      const { sha256 } = await hashFile(full);
      entry.sha256Ok = sha256 === file.sha256;
      if (!entry.sha256Ok) corrupt = true;
    }
  }

  const state: VoiceModelState = corrupt
    ? 'corrupt'
    : incomplete
      ? 'incomplete'
      : outdated
        ? 'outdated'
        : 'ready';
  return { state, files };
}

/**
 * Falla cerrado: si el estado sin verificar no es `ready`, lanza. La usa el
 * worker antes de cargar nada.
 */
export async function assertVoiceModelLoadable(dir: string): Promise<void> {
  const status = await voiceModelStatus({ dir });
  if (status.state !== 'ready') {
    throw new VoiceModelNotReadyError(
      `el modelo de voz no está listo en ${dir} (estado: ${status.state}); ` +
        'ejecuta "stratum voice download"',
      status.state,
    );
  }
}

export interface ResealVoiceModelOptions {
  dir: string;
  /** Manifiesto esperado (los tests pasan uno pequeño). */
  manifest?: readonly VoiceModelFile[];
}

/**
 * Reescribe la marca de un modelo **ya descargado**, sin volver a bajarlo.
 *
 * Calcula el SHA-256 de todos los ficheros (como `status --verify`) y solo si
 * los da todos por buenos escribe la marca con el tamaño, el `mtime` y el `ino`
 * que hay en disco ahora. Si alguno no cuadra no escribe nada: una marca nueva
 * sobre un fichero dañado sería peor que no tenerla.
 *
 * Existe porque la marca cambió de formato en la fase 2 (pasó a llevar `ino`) y
 * volver a bajar 4 GB para arreglarla sería absurdo. Es un subcomando oculto.
 */
export async function resealVoiceModel(opts: ResealVoiceModelOptions): Promise<VoiceModelMarker> {
  const manifest = opts.manifest ?? VOICE_MODEL_FILES;
  validateManifest(manifest);
  const { dir } = opts;
  // Lo mismo que `download` y `remove`: el nombre y la ruta, antes de abrir nada.
  assertModelDirName(dir);
  const parent = dirname(resolve(dir));
  let dirStat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(dir);
  } catch {
    throw new VoiceModelNotReadyError(`no hay ningún modelo de voz en ${dir}`, 'missing');
  }
  assertParentHasNoLinks(parent);
  if (!dirStat.isDirectory() || !samePath(realpathSync.native(dir), resolve(dir))) {
    throw new VoiceModelPathError(`${dir} no es un directorio normal (¿un enlace?); no se sella`);
  }

  const lock = acquireLock(dir);
  try {
    // El SHA, el tamaño y la identidad salen **del mismo fichero**: se mira su
    // identidad antes y después de calcular la suma, y si cambia entre medias
    // no se sella nada.
    const files: VoiceModelMarker['files'] = [];
    const wrong: string[] = [];
    for (const file of manifest) {
      const full = join(dir, file.path);
      const before = fileIdentity(full);
      if (!before) {
        wrong.push(file.path);
        continue;
      }
      const { sha256, bytes } = await hashFile(full);
      const after = fileIdentity(full);
      if (!after || !sameIdentity(before, after)) {
        throw new VoiceModelIntegrityError(
          `"${file.path}" ha cambiado mientras se comprobaba; no se sella`,
          file.path,
        );
      }
      if (bytes !== file.size || before.size !== file.size || sha256 !== file.sha256) {
        wrong.push(file.path);
        continue;
      }
      files.push({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        mtimeMs: before.mtimeMs,
        ino: before.ino,
      });
    }
    if (wrong.length > 0) {
      throw new VoiceModelIntegrityError(
        `no se reescribe la marca: ${wrong.join(', ')} no cuadra con el manifiesto`,
      );
    }
    // Justo antes de publicar, otra vez: nada ha cambiado desde que se comprobó.
    for (const entry of files) {
      const now = fileIdentity(join(dir, entry.path));
      if (
        !now ||
        now.mtimeMs !== entry.mtimeMs ||
        now.ino !== entry.ino ||
        now.size !== entry.size
      ) {
        throw new VoiceModelIntegrityError(
          `"${entry.path}" ha cambiado antes de sellar; no se sella`,
          entry.path,
        );
      }
    }
    lock.assertHeld();
    const marker: VoiceModelMarker = {
      schemaVersion: VOICE_MODEL_MARKER_VERSION,
      model: VOICE_MODEL_ID,
      files,
    };
    writeFileAtomic(join(dir, VOICE_MODEL_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    return marker;
  } finally {
    lock.release();
  }
}

interface FileIdentity {
  size: number;
  mtimeMs: number;
  ino: string;
}

/** Tamaño, `mtime` e `ino` de un fichero normal; `undefined` si no existe o no es un fichero. */
function fileIdentity(path: string): FileIdentity | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: inoOf(path) };
  } catch {
    return undefined;
  }
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

// ---------------------------------------------------------------------------
// Cerrojo y restos de pasadas anteriores
// ---------------------------------------------------------------------------

const MODEL_PREFIX = `.${VOICE_MODEL_ID}`;

/**
 * Los restos que se limpian, con la parte aleatoria de `privateName`:
 * - `tmp`: una descarga a medias;
 * - `old`: el modelo anterior que una descarga apartó para publicar el nuevo
 *   (puede ser la única copia buena si la publicación se quedó a medias);
 * - `trash`: lo que `remove` ya decidió borrar (nunca se restaura).
 */
const LEFTOVER_RE = new RegExp(`^\\.${VOICE_MODEL_ID}\\.(tmp|old|trash)-[0-9a-f]+$`);

/**
 * El cerrojo es un **directorio**, `<dir>.lock/`, con `owner.json` dentro
 * (`{ pid, token, createdAt }`). **Nunca existe sin dueño**: se prepara aparte
 * (`<dir>.lock.<token>.new/`, ya con su `owner.json`) y se publica con un
 * `rename`, que falla si ya hay cerrojo. Así nadie ve un cerrojo a medias ni
 * escribe su dueño encima del de otro.
 *
 * - **Latido**: mientras dura la operación se refresca el `mtime` del
 *   directorio. Un cerrojo sin latido en `VOICE_MODEL_LOCK_STALE_MS` es de un
 *   proceso que ya no está, aunque su pid lo haya heredado otro.
 * - **Recuperar** un cerrojo muerto pasa por un segundo cerrojo con dueño,
 *   `<dir>.lock.recover/`, publicado igual: solo un proceso recupera a la vez, y
 *   dentro vuelve a comprobar que el cerrojo sigue siendo el mismo muerto antes
 *   de quitarlo.
 * - **Soltar** (los dos) solo quita el directorio si su `token` es el propio.
 *
 * Riesgo residual, aceptado: un proceso **suspendido** más de 5 min (un
 * portátil que se duerme a mitad de la descarga) pierde el cerrojo, y al volver
 * podría coincidir con otro. Antes de publicar se comprueba que el cerrojo
 * sigue siendo suyo (`assertHeld`), y si no, no publica.
 */
const LOCK_OWNER = 'owner.json';

/** Un `.recover` sin dueño vivo, o más viejo que esto, es de un proceso que murió dentro. */
const LOCK_RECOVER_STALE_MS = 60_000;

const LockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().regex(/^[0-9a-f]{32}$/),
  createdAt: z.number(),
});

type LockOwner = z.infer<typeof LockOwnerSchema>;

function lockPath(dir: string): string {
  return `${dir}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: el proceso existe pero no es nuestro.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockOwner(lock: string): LockOwner | undefined {
  const file = join(lock, LOCK_OWNER);
  try {
    if (!lstatSync(file).isFile()) return undefined;
    const parsed = LockOwnerSchema.safeParse(JSON.parse(readFileSync(file, 'utf-8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function newOwner(): LockOwner {
  return { pid: process.pid, token: randomBytes(16).toString('hex'), createdAt: Date.now() };
}

/**
 * Publica `target` ya con su dueño dentro. `false` si ya había algo en `target`
 * (otro cerrojo, o un fichero de una versión anterior).
 */
function publishOwnedDir(target: string, owner: LockOwner): boolean {
  // En Windows, `rename` de un directorio **sustituye** un fichero que ya esté
  // en el destino (libuv usa `MOVEFILE_REPLACE_EXISTING`); sobre un directorio
  // con contenido sí falla, en Windows y en POSIX. Nuestros cerrojos son siempre
  // directorios con dueño, así que la exclusión entre procesos de Stratum la da
  // el `rename`; un fichero (de una versión anterior o puesto a mano) se mira
  // antes para no pisarlo.
  if (existsSync(target)) return false;
  const staging = `${target}.${owner.token}.new`;
  mkdirSync(staging);
  try {
    writeFileAtomic(join(staging, LOCK_OWNER), `${JSON.stringify(owner)}\n`);
    try {
      renameSync(staging, target);
      return true;
    } catch (err) {
      // `rename` sobre un directorio con contenido (o sobre un fichero) falla:
      // si `target` existe, es que está tomado; si no, el error es otro.
      if (existsSync(target)) return false;
      throw err;
    }
  } finally {
    rmQuietly(staging);
  }
}

/** Quita `target` solo si su dueño es `token`. */
function removeIfOwned(target: string, token: string): void {
  if (readLockOwner(target)?.token !== token) return;
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    // Que ya no esté no es un fallo.
  }
}

/**
 * Borra las preparaciones (`<lock>.<token>.new`, `<lock>.recover.<token>.new`)
 * y los `.dead` que dejó un proceso que murió a mitad. Solo los de más de
 * `LOCK_RECOVER_STALE_MS` (por su `createdAt`, o por su `mtime` si no llegó a
 * tener dueño): una preparación de otro proceso que está tomando el cerrojo
 * ahora mismo dura milisegundos y no se toca.
 */
function removeStaleStaging(lock: string): void {
  const parent = dirname(lock);
  const prefix = `${basename(lock)}.`;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !(name.endsWith('.new') || name.endsWith('.dead'))) continue;
    const path = join(parent, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const born = readLockOwner(path)?.createdAt ?? stat.mtimeMs;
    if (Date.now() - born >= LOCK_RECOVER_STALE_MS) rmQuietly(path);
  }
}

type LockView =
  | { kind: 'absent' }
  | { kind: 'alive'; pid?: number }
  /** `token` del dueño muerto, si se pudo leer: es lo que identifica a este cerrojo. */
  | { kind: 'dead'; token?: string };

function inspectLock(lock: string): LockView {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(lock);
  } catch {
    return { kind: 'absent' };
  }
  const age = Date.now() - stat.mtimeMs;
  // Un fichero o un enlace donde va el cerrojo (de una versión anterior, o
  // puesto a mano): solo se aparta cuando es viejo.
  if (!stat.isDirectory()) {
    return age >= VOICE_MODEL_LOCK_STALE_MS ? { kind: 'dead' } : { kind: 'alive' };
  }
  const owner = readLockOwner(lock);
  // Sin dueño legible no puede ser un cerrojo vivo (se publica ya con él): es
  // un resto de un proceso que murió mientras lo borraba.
  if (!owner) return { kind: 'dead' };
  if (age >= VOICE_MODEL_LOCK_STALE_MS || !pidAlive(owner.pid)) {
    return { kind: 'dead', token: owner.token };
  }
  return { kind: 'alive', pid: owner.pid };
}

function busy(lock: string, pid?: number): VoiceModelBusyError {
  return new VoiceModelBusyError(
    `otra operación sobre el modelo de voz está en marcha` +
      `${pid !== undefined ? ` (pid ${pid})` : ''}; si no es así, borra ${lock}`,
  );
}

/**
 * Aparta un `.recover` abandonado sin tocar uno que lo haya sustituido entre
 * medias. Todo se decide con **una sola lectura** de su `owner.json` (que es
 * inmutable en cada `.recover`): abandonado si no tiene dueño (no puede pasar
 * con uno vivo, que se publica ya con él), si su pid no vive o si su
 * `createdAt` tiene más de `LOCK_RECOVER_STALE_MS` (un pid reciclado; recuperar
 * son milisegundos). Después se renombra aparte y se comprueba que el apartado
 * es ese mismo dueño; si no, se devuelve a su sitio.
 *
 * Riesgo residual, aceptado: si al devolverlo ya hay **otro** `.recover` (tres
 * procesos recuperando en el mismo instante), el apartado se queda como resto
 * `.dead` y no se borra.
 */
function clearAbandonedGuard(guard: string): void {
  const owner = readLockOwner(guard);
  const abandoned =
    !owner || !pidAlive(owner.pid) || Date.now() - owner.createdAt >= LOCK_RECOVER_STALE_MS;
  if (!abandoned) return;
  const aside = `${guard}.${randomBytes(6).toString('hex')}.dead`;
  try {
    renameSync(guard, aside);
  } catch {
    return; // ya no está, o no se deja: el siguiente intento lo verá
  }
  if (readLockOwner(aside)?.token !== owner?.token) {
    try {
      renameSync(aside, guard);
    } catch {
      // Ya hay otro `.recover`: el apartado se queda como resto, sin borrar.
    }
    return;
  }
  rmQuietly(aside);
}

/**
 * Quita un cerrojo muerto. Solo un proceso recupera a la vez (`.recover`, con
 * dueño), y dentro se vuelve a mirar: si el cerrojo ya no es el mismo muerto que
 * se vio, es de otro y no se toca.
 */
function recoverDeadLock(lock: string, seen: { token?: string }): void {
  const guard = `${lock}.recover`;
  const guardOwner = newOwner();
  if (!publishOwnedDir(guard, guardOwner)) {
    clearAbandonedGuard(guard);
    throw new VoiceModelBusyError(
      `otro proceso está recuperando el cerrojo ${lock}; vuelve a intentarlo`,
    );
  }
  try {
    const now = inspectLock(lock);
    if (now.kind === 'absent') return;
    if (now.kind !== 'dead' || now.token !== seen.token) {
      throw busy(lock, now.kind === 'alive' ? now.pid : undefined);
    }
    rmSync(lock, { recursive: true, force: true });
  } finally {
    removeIfOwned(guard, guardOwner.token);
  }
}

interface HeldLock {
  /** Lanza si el cerrojo ya no es de esta operación (se lo quitaron por viejo). */
  assertHeld(): void;
  /** Lo suelta si sigue siendo suyo. Idempotente. */
  release(): void;
}

/**
 * Toma el cerrojo de `dir` para `download`, `remove` y `reseal`. Si hay uno
 * muerto, se recupera y se reintenta una sola vez.
 */
function acquireLock(dir: string): HeldLock {
  const lock = lockPath(dir);
  mkdirSync(dirname(lock), { recursive: true });
  removeStaleStaging(lock);
  const owner = newOwner();
  const { token } = owner;

  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    acquired = publishOwnedDir(lock, owner);
    if (acquired) break;
    const view = inspectLock(lock);
    if (view.kind === 'alive') throw busy(lock, view.pid);
    if (view.kind === 'dead') recoverDeadLock(lock, view);
  }
  if (!acquired) throw new VoiceModelBusyError(`no se pudo tomar el cerrojo ${lock}`);

  const ours = (): boolean => readLockOwner(lock)?.token === token;
  // Latido: mientras dure la descarga, el cerrojo se ve fresco aunque tarde
  // horas en bajar 4 GB.
  const heartbeat = setInterval(() => {
    if (!ours()) return;
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // El cerrojo ya no está: el latido no tiene nada que refrescar.
    }
  }, VOICE_MODEL_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  let released = false;
  return {
    assertHeld() {
      if (!ours()) {
        throw new VoiceModelBusyError(
          `el cerrojo ${lock} ya no es de esta operación (¿estuvo suspendida más de ` +
            `${Math.round(VOICE_MODEL_LOCK_STALE_MS / 60_000)} min?); no se publica nada`,
        );
      }
    },
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      removeIfOwned(lock, token);
    },
  };
}

type LeftoverKind = 'tmp' | 'old' | 'trash';

interface Leftover {
  name: string;
  kind: LeftoverKind;
  mtimeMs: number;
}

/** Los restos de pasadas anteriores, sin seguir ningún enlace. */
function leftoverDirs(parent: string): Leftover[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const found: Leftover[] = [];
  for (const name of names) {
    const match = LEFTOVER_RE.exec(name);
    if (!match) continue;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(join(parent, name));
    } catch {
      continue;
    }
    // Un enlace nunca se sigue ni se borra en recursivo.
    if (!stat.isDirectory()) continue;
    found.push({ name, kind: match[1] as LeftoverKind, mtimeMs: stat.mtimeMs });
  }
  return found;
}

function rmQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    // Un resto que no se puede borrar no impide seguir: se intenta la próxima vez.
  }
}

/**
 * Limpia los restos de pasadas anteriores (solo directorios con el nombre
 * exacto; nunca se sigue un enlace):
 * - los temporales y los borrados pendientes de `remove` (`trash`) se tiran;
 * - un `.old` es una copia del modelo que una descarga apartó. Si en `dir` no
 *   hay nada, se restaura la copia **buena** (`ready`) más reciente: puede ser
 *   la única que queda. Las copias solo se tiran cuando en `dir` hay un modelo
 *   `ready`; si no, se dejan, que no estorban.
 */
async function removeLeftovers(
  dir: string,
  parent: string,
  manifest: readonly VoiceModelFile[],
): Promise<void> {
  const found = leftoverDirs(parent);
  for (const entry of found) {
    if (entry.kind !== 'old') rmQuietly(join(parent, entry.name));
  }
  const olds = found.filter((entry) => entry.kind === 'old');
  if (olds.length === 0) return;

  let current = await voiceModelStatus({ dir, manifest });
  if (current.state === 'missing') {
    const good: Leftover[] = [];
    for (const entry of olds) {
      const status = await voiceModelStatus({ dir: join(parent, entry.name), manifest });
      if (status.state === 'ready') good.push(entry);
    }
    const newest = good.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0];
    if (newest) {
      try {
        renameSync(join(parent, newest.name), dir);
      } catch {
        // Si no se puede restaurar, se queda donde está: no se tira.
      }
      current = await voiceModelStatus({ dir, manifest });
    }
  }
  if (current.state !== 'ready') return;
  for (const entry of olds) {
    if (existsSync(join(parent, entry.name))) rmQuietly(join(parent, entry.name));
  }
}

function isBusyCode(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Un nombre nuevo para un temporal, un `.old` o un `.trash`, con su parte aleatoria. */
function privateName(parent: string, kind: LeftoverKind): string {
  return join(parent, `${MODEL_PREFIX}.${kind}-${randomBytes(6).toString('hex')}`);
}

/** Crea el directorio temporal de la descarga, de forma exclusiva. */
function makePrivateDir(parent: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = privateName(parent, 'tmp');
    try {
      // Sin `recursive`: si el nombre ya existe, otro nombre en vez de compartirlo.
      mkdirSync(path);
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`no se pudo crear un directorio temporal en ${parent}`);
}

// ---------------------------------------------------------------------------
// Descarga
// ---------------------------------------------------------------------------

export interface VoiceDownloadProgress {
  /** Fichero que se está bajando. */
  file: string;
  /** Bytes de ese fichero y su total. */
  fileBytes: number;
  fileTotal: number;
  /** Bytes acumulados de la descarga y su total. */
  bytes: number;
  total: number;
}

export interface DownloadVoiceModelOptions {
  dir: string;
  fetch?: typeof fetch;
  onProgress?: (progress: VoiceDownloadProgress) => void;
  signal?: AbortSignal;
  /** Manifiesto esperado (los tests pasan uno pequeño). */
  manifest?: readonly VoiceModelFile[];
  /** Espacio libre del directorio padre. Inyectable para los tests. */
  statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  /** Reloj, para los tests. */
  now?: () => number;
  /** Ritmo mínimo entre dos `onProgress` (ms). */
  progressIntervalMs?: number;
}

/**
 * Descarga el modelo entero en `dir`, verificando cada fichero.
 *
 * Deja el directorio bueno como estaba si algo falla, salvo que el fallo sea
 * justo el `rename` final (el worker tiene los ficheros abiertos): entonces es
 * `VoiceModelInUseError`; y si encima no se puede devolver el anterior a su
 * sitio, `VoiceModelRollbackError` con la ruta donde quedó.
 */
export async function downloadVoiceModel(opts: DownloadVoiceModelOptions): Promise<void> {
  const { dir } = opts;
  const manifest = opts.manifest ?? VOICE_MODEL_FILES;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const statfs = opts.statfs ?? fsStatfs;
  const now = opts.now ?? (() => Date.now());
  validateManifest(manifest);
  assertModelDirName(dir);
  const parent = dirname(resolve(dir));
  const total = manifest.reduce((sum, f) => sum + f.size, 0);

  mkdirSync(parent, { recursive: true });
  assertParentHasNoLinks(parent);
  const lock = acquireLock(dir);
  let tmpDir: string | undefined;
  let published = false;
  let failure: unknown;
  try {
    signalOrThrow(opts.signal);
    await removeLeftovers(dir, parent, manifest);

    // Espacio: el modelo entero más un margen, antes de bajar nada.
    const fsInfo = await statfs(parent);
    const freeBytes = Number(fsInfo.bavail) * Number(fsInfo.bsize);
    if (freeBytes < total + VOICE_MODEL_SPACE_RESERVE_BYTES) {
      throw new VoiceModelSpaceError(
        `no hay espacio para el modelo de voz en ${parent}: hacen falta ` +
          `${formatBytes(total + VOICE_MODEL_SPACE_RESERVE_BYTES)} y quedan ${formatBytes(freeBytes)}`,
      );
    }

    tmpDir = makePrivateDir(parent);

    let done = 0;
    let lastReport = 0;
    const interval = opts.progressIntervalMs ?? 150;
    for (const file of manifest) {
      signalOrThrow(opts.signal);
      let fileBytes = 0;
      const dest = join(tmpDir, file.path);
      const { sha256, bytes } = await downloadOne({
        fetchImpl,
        url: file.url,
        dest,
        expectedSize: file.size,
        signal: opts.signal,
        onBytes: (n) => {
          fileBytes += n;
          const at = now();
          if (opts.onProgress && (at - lastReport >= interval || fileBytes === file.size)) {
            lastReport = at;
            opts.onProgress({
              file: file.path,
              fileBytes,
              fileTotal: file.size,
              bytes: done + fileBytes,
              total,
            });
          }
        },
      });
      if (bytes !== file.size || sha256 !== file.sha256) {
        throw new VoiceModelIntegrityError(
          `el fichero "${file.path}" no cuadra con el manifiesto ` +
            `(esperado ${file.size} bytes y sha256 ${file.sha256}; ` +
            `llegaron ${bytes} y ${sha256})`,
          file.path,
        );
      }
      done += file.size;
      opts.onProgress?.({
        file: file.path,
        fileBytes: file.size,
        fileTotal: file.size,
        bytes: done,
        total,
      });
    }

    // La marca, con el `mtime` y el `ino` reales de cada fichero ya escrito.
    const marker: VoiceModelMarker = {
      schemaVersion: VOICE_MODEL_MARKER_VERSION,
      model: VOICE_MODEL_ID,
      files: manifest.map((file) => {
        const full = join(tmpDir!, file.path);
        return {
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          mtimeMs: lstatSync(full).mtimeMs,
          ino: inoOf(full),
        };
      }),
    };
    writeFileAtomic(join(tmpDir, VOICE_MODEL_MARKER), `${JSON.stringify(marker, null, 2)}\n`);

    // Publicación atómica: el directorio bueno, fuera; el nuevo, en su sitio.
    signalOrThrow(opts.signal);
    // Si el cerrojo se perdió (proceso suspendido demasiado tiempo), no se publica.
    lock.assertHeld();
    const oldDir = privateName(parent, 'old');
    const hadOld = existsSync(dir);
    if (hadOld) {
      try {
        renameSync(dir, oldDir);
      } catch (err) {
        if (isBusyCode(err)) {
          throw new VoiceModelInUseError(
            `no se pudo apartar el modelo anterior de ${dir}: está en uso ` +
              '(cierra el worker de voz y vuelve a intentarlo)',
          );
        }
        throw err;
      }
    }
    try {
      renameSync(tmpDir, dir);
      published = true;
    } catch (err) {
      // El directorio antiguo vuelve a su sitio, o se dice dónde ha quedado.
      let rollbackError: unknown;
      if (hadOld) {
        try {
          renameSync(oldDir, dir);
        } catch (rollbackErr) {
          rollbackError = rollbackErr;
        }
      }
      if (rollbackError !== undefined) {
        throw new VoiceModelRollbackError(
          `no se pudo publicar el modelo en ${dir} y el anterior no ha vuelto a su sitio: ` +
            `está en ${oldDir} (${errorMessage(err)}; al devolverlo, ${errorMessage(rollbackError)})`,
          oldDir,
          err,
        );
      }
      if (isBusyCode(err)) {
        throw new VoiceModelInUseError(
          `no se pudo publicar el modelo en ${dir}: sus ficheros están en uso ` +
            '(cierra el worker de voz y vuelve a intentarlo)',
        );
      }
      throw err;
    }
    if (hadOld) {
      try {
        rmSync(oldDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        // Un `.old` que no se deja borrar no es un fallo: se limpia la próxima vez.
      }
    }
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    // El borrado del temporal y el cerrojo son dos `finally` distintos: un
    // temporal que no se deja borrar no puede dejar el cerrojo tomado ni tapar
    // el error que provocó el fallo.
    let leftover: string | undefined;
    if (tmpDir !== undefined && !published) {
      try {
        rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      } catch {
        leftover = tmpDir;
      }
    }
    try {
      lock.release();
    } finally {
      if (leftover !== undefined) {
        if (failure === undefined || typeof failure !== 'object' || failure === null) {
          throw new VoiceModelCleanupError(leftover);
        }
        // No se tapa el error original: se le añade la ruta que quedó.
        (failure as { leftover?: string }).leftover = leftover;
      }
    }
  }
}

function signalOrThrow(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('descarga cancelada', 'AbortError');
}

/** ¿El host es de Hugging Face? Los ficheros del modelo solo salen de ahí. */
function assertDownloadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new VoiceModelDownloadError(`la URL de descarga no vale: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new VoiceModelDownloadError(`la descarga tiene que ir por https: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === 'huggingface.co' ||
    host === 'hf.co' ||
    host.endsWith('.huggingface.co') ||
    host.endsWith('.hf.co');
  if (!allowed) {
    throw new VoiceModelDownloadError(
      `la descarga apunta a un host que no es de Hugging Face: ${host}`,
    );
  }
}

/**
 * Sigue las redirecciones **a mano**: con `redirect: 'manual'` se ve a dónde
 * manda cada salto y se comprueba que no saque la descarga de Hugging Face ni
 * la baje a `http:`.
 */
async function fetchFollowingRedirects(opts: {
  fetchImpl: typeof fetch;
  url: string;
  signal?: AbortSignal;
}): Promise<Response> {
  let url = opts.url;
  for (let hop = 0; ; hop++) {
    assertDownloadUrl(url);
    const response = await opts.fetchImpl(url, {
      redirect: 'manual',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (response.status < 300 || response.status >= 400) return response;
    // El cuerpo de un salto no se usa: se cancela para soltar la conexión.
    await discardBody(response);
    const location = response.headers.get('location');
    if (!location) {
      throw new VoiceModelDownloadError(
        `la redirección de ${url} no trae "location"`,
        response.status,
      );
    }
    if (hop >= VOICE_MODEL_MAX_REDIRECTS) {
      throw new VoiceModelDownloadError(
        `la descarga de ${opts.url} encadena más de ${VOICE_MODEL_MAX_REDIRECTS} redirecciones`,
        response.status,
      );
    }
    url = new URL(location, url).toString();
  }
}

/** Cancela un cuerpo que no se va a leer; que falle no importa. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ya estaba cerrado o consumido.
  }
}

async function downloadOne(opts: {
  fetchImpl: typeof fetch;
  url: string;
  dest: string;
  expectedSize: number;
  signal?: AbortSignal;
  onBytes: (n: number) => void;
}): Promise<{ sha256: string; bytes: number }> {
  const res = await fetchFollowingRedirects({
    fetchImpl: opts.fetchImpl,
    url: opts.url,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    await discardBody(res);
    throw new VoiceModelDownloadError(
      `la descarga de ${opts.url} respondió HTTP ${res.status}`,
      res.status,
    );
  }
  if (!res.body) {
    throw new VoiceModelDownloadError(`la descarga de ${opts.url} no trajo cuerpo`, res.status);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(opts.dest);
  // Un `error` de disco sin oyente tumba el proceso: se guarda y se decide luego.
  let failure: Error | undefined;
  out.on('error', (err: Error) => {
    failure ??= err;
  });
  const closed = once(out, 'close').then(
    () => undefined,
    () => undefined,
  );
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      bytes += data.length;
      if (bytes > opts.expectedSize) {
        throw new VoiceModelIntegrityError(
          `la descarga pasa de los ${opts.expectedSize} bytes esperados`,
          opts.dest,
        );
      }
      hash.update(data);
      opts.onBytes(data.length);
      if (!out.write(data)) await Promise.race([once(out, 'drain'), closed]);
      if (failure) throw failure;
    }
    out.end();
    await closed;
    if (failure) throw failure;
  } catch (err) {
    out.destroy();
    // Se espera al cierre: en Windows un fichero abierto no se deja borrar.
    await closed;
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** `1.5 GB`: tamaño legible para los mensajes. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Borrado
// ---------------------------------------------------------------------------

export interface RemoveVoiceModelOptions {
  dir: string;
  /** Reloj, para los tests. */
  now?: () => number;
}

/**
 * Borra el modelo **y todas sus copias recuperables** (`.old-*`), bajo el
 * cerrojo: lo que se pidió borrar no puede volver con la siguiente descarga.
 *
 * Cada directorio se pasa primero a `.trash-<aleatorio>` con un `rename`, que es
 * la intención de borrar ya guardada en disco: un `.trash` nunca se restaura y
 * la próxima descarga lo tira si ahora no se deja borrar.
 *
 * @returns si había algo que borrar.
 */
export async function removeVoiceModel(opts: RemoveVoiceModelOptions): Promise<boolean> {
  const { dir } = opts;
  assertModelDirName(dir);
  const parent = dirname(resolve(dir));
  if (!existsSync(parent)) return false;
  assertParentHasNoLinks(parent);
  const lock = acquireLock(dir);
  try {
    // Primero las copias y después el modelo: si el modelo no se deja apartar
    // (en uso), ya no queda ninguna copia que una descarga pudiera restaurar.
    const targets = [
      ...leftoverDirs(parent)
        .filter((entry) => entry.kind === 'old')
        .map((entry) => join(parent, entry.name)),
      ...(existsSync(dir) ? [dir] : []),
    ];
    if (targets.length === 0) return false;
    const trashed: string[] = [];
    for (const target of targets) {
      // `trash`, no `old`: lo que se pidió borrar nunca se restaura.
      const trash = privateName(parent, 'trash');
      try {
        renameSync(target, trash);
        trashed.push(trash);
      } catch (err) {
        if (isBusyCode(err)) {
          throw new VoiceModelInUseError(
            `no se pudo borrar ${target}: sus ficheros están en uso ` +
              '(cierra el worker de voz y vuelve a intentarlo)',
          );
        }
        throw err;
      }
    }
    for (const trash of trashed) rmQuietly(trash);
    return true;
  } finally {
    lock.release();
  }
}
