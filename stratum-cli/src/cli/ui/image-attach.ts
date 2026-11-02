/**
 * Adjuntar imágenes en el input de `chat`: utilidades puras (sin React).
 *
 *  - `imagePathFromInput` reconoce un pegado que es exactamente la ruta de una
 *    imagen existente (como la deja arrastrar un fichero al terminal).
 *  - Los «chips» son las rutas ya guardadas en `~/.stratum/images` que
 *    acompañarán al próximo mensaje.
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StratumAgent } from '../../agent/core.js';
import type { SteeringEnqueueResult } from '../../agent/inbox.js';
import type { UserImage } from '../../agent/user-images.js';
import { loadUserImages, UserImageError } from '../../images/store.js';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;

export const NO_CLIPBOARD_IMAGE = 'No hay imagen en el portapapeles.';

export const IMAGE_CHIPS_FULL = 'Máximo 5 imágenes por mensaje.';

/** `[imagen 1] [imagen 2]` */
export function formatImageChips(count: number): string {
  return Array.from({ length: count }, (_, i) => `[imagen ${i + 1}]`).join(' ');
}

/** Texto de la burbuja del usuario cuando lleva imágenes. */
export function messageWithImagesLabel(text: string, count: number): string {
  if (count === 0) return text;
  const label = formatImageChips(count);
  return text.trim() ? `${text} ${label}` : label;
}

function stripQuotes(input: string): string {
  let s = input;
  // PowerShell al arrastrar: & 'C:\ruta con espacios\a.png'
  const amp = /^&\s+(.+)$/.exec(s);
  if (amp) s = amp[1]!.trim();
  if (s.length >= 2) {
    const q = s[0]!;
    if ((q === '"' || q === "'") && s.at(-1) === q) return s.slice(1, -1);
  }
  return s;
}

/**
 * Si `text` entero es la ruta (con o sin comillas) de un fichero de imagen que
 * existe, devuelve su ruta absoluta; si no, `null` (es texto normal).
 */
export function imagePathFromInput(
  text: string,
  opts: {
    cwd: string;
    platform?: NodeJS.Platform;
    isFile?: (path: string) => boolean;
  },
): string | null {
  const raw = text.trim();
  if (!raw || /[\r\n]/.test(raw)) return null;
  let p = stripQuotes(raw);
  // Unix: arrastrar escapa los espacios con barra.
  if ((opts.platform ?? process.platform) !== 'win32') p = p.replace(/\\ /g, ' ');
  const ext = /\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase();
  if (!ext || !(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return null;
  const abs = resolve(opts.cwd, p);
  const isFile =
    opts.isFile ??
    ((f: string) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    });
  return isFile(abs) ? abs : null;
}

export type LoadChipsResult = { ok: true; images: UserImage[] } | { ok: false; message: string };

/**
 * Carga las imágenes de los chips para enviarlas con el mensaje. Todas o
 * ninguna: si falla, el mensaje no sale y los chips se quedan.
 */
export function loadChipImages(
  paths: readonly string[],
  cwd: string,
  load: typeof loadUserImages = loadUserImages,
): LoadChipsResult {
  try {
    return { ok: true, images: load(paths, { cwd }) };
  } catch (err) {
    const message =
      err instanceof UserImageError
        ? err.message
        : `No se pudieron cargar las imágenes: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, message };
  }
}

/** Steering con imágenes: lo que devuelve es el resultado del inbox, o el fallo de carga. */
export function steerWithImages(
  agent: Pick<StratumAgent, 'enqueueUserMessage'>,
  text: string,
  paths: readonly string[],
  cwd: string,
  load?: typeof loadUserImages,
): SteeringEnqueueResult | { status: 'load-failed'; message: string } {
  const loaded = loadChipImages(paths, cwd, load);
  if (!loaded.ok) return { status: 'load-failed', message: loaded.message };
  return agent.enqueueUserMessage(text, loaded.images);
}
