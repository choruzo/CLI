/**
 * Imágenes que adjunta el usuario a un mensaje (pegadas o adjuntas en la CLI y
 * en Stratum Desktop). Mismo modelo que las capturas de M15
 * (`screenshots.ts`): la imagen vive aquí, en memoria y fuera del historial;
 * el historial solo lleva una marca de texto (`imageMarker`) en el mensaje que
 * la trajo, y el provider pone la imagen junto a esa marca al serializar.
 *
 * Consecuencias que son a propósito:
 *  - una imagen cuya marca ya no está en el historial (compactada, `/clear`)
 *    no se manda;
 *  - tras un reinicio (el daemon, `chat --resume`) el buffer está vacío y las
 *    imágenes no se vuelven a mandar: la marca sigue diciendo qué era;
 *  - solo van a un modelo con visión declarada (`models.<id>.vision`).
 */
import type { Message } from './types.js';

/** Imágenes del usuario en el contexto del modelo: las últimas. */
export const USER_IMAGES_IN_CONTEXT = 4;

export const USER_IMAGE_LIMITS = {
  /** Por imagen. Es el tope más bajo de los backends habituales. */
  maxBytes: 5 * 1024 * 1024,
  /** Por mensaje. */
  perMessage: 5,
} as const;

export type UserImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface UserImage {
  /** `img-` + 12 hex del sha256: estable para la misma imagen. */
  id: string;
  /** Nombre del fichero, solo para la marca. */
  name: string;
  mime: UserImageMime;
  /** Contenido en base64. */
  data: string;
  bytes: number;
  sha256: string;
}

/** Una imagen del usuario que acompaña a una petición, junto a su marca. */
export interface RequestUserImage {
  image: UserImage;
}

/** El tipo por los primeros bytes; `null` si no es una imagen admitida. */
export function sniffImageMime(bytes: Uint8Array): UserImageMime | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return 'image/png';
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38)
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return 'image/webp';
  return null;
}

/** Nombre apto para la marca: sin saltos de línea ni corchetes, acotado. */
function markerName(name: string): string {
  const clean = name.replace(/[\r\n[\]]/g, ' ').trim();
  return (clean || 'image').slice(0, 80);
}

/** La marca de texto que deja la imagen en el mensaje del usuario. */
export function imageMarker(image: UserImage): string {
  const kb = Math.max(1, Math.round(image.bytes / 1024));
  return `[image ${image.id} attached: ${markerName(image.name)}, ${kb} KB]`;
}

/** El texto del mensaje con la marca de cada imagen al final. */
export function withImageMarkers(text: string, images: readonly UserImage[]): string {
  if (images.length === 0) return text;
  const marks = images.map(imageMarker).join('\n');
  return text.trim() ? `${text}\n\n${marks}` : marks;
}

/** Índice del mensaje que lleva la marca de `image` (el último), o `-1`. */
export function anchorIndex(messages: readonly Message[], image: UserImage): number {
  const mark = `[image ${image.id} attached:`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if ((m.role === 'user' || m.role === 'tool') && m.content?.includes(mark)) return i;
  }
  return -1;
}

export class UserImageBuffer {
  private entries: UserImage[] = [];

  constructor(private readonly limit: number = USER_IMAGES_IN_CONTEXT) {}

  add(image: UserImage): void {
    // La misma imagen dos veces: cuenta la más reciente.
    this.entries = this.entries.filter((e) => e.id !== image.id);
    this.entries.push(image);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  /** Las que siguen con su marca en el historial, en su orden. */
  forRequest(messages: readonly Message[]): RequestUserImage[] {
    if (this.entries.length === 0) return [];
    return this.entries
      .filter((image) => anchorIndex(messages, image) >= 0)
      .map((image) => ({ image }));
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}
