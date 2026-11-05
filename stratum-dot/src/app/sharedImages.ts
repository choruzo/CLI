import type { NativeBridge } from '../bridge/native';
import { SHARED_IMAGE_LIMITS, type ProtocolSharedImage } from '../protocol';
import { parseImageChunk } from '../protocol/results';

/**
 * Las imágenes que el asistente enseña en la conversación (`kind: 'image'`)
 * llegan como referencia: los bytes se piden a `images.get` **por trozos**,
 * porque una imagen de hasta 5 MB no cabe en un mensaje. Aquí se piden todos,
 * se comprueba que casan con lo que anuncia la conversación y se juntan en un
 * `Blob`. Si algo no casa no se enseña nada: nunca una imagen a medias.
 */

/** Como mucho, los trozos de una imagen del tope más uno de margen. */
const MAX_CALLS = Math.ceil(SHARED_IMAGE_LIMITS.maxBytes / SHARED_IMAGE_LIMITS.chunkBytes) + 1;

/** Cuántas imágenes se recuerdan a la vez: no se repite la descarga al repintar. */
const CACHE_SIZE = 8;
const cache = new Map<string, Promise<Blob>>();

/** Para los tests: olvida lo descargado. */
export function clearSharedImageCache(): void {
  cache.clear();
}

function decodeBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function download(native: NativeBridge, image: ProtocolSharedImage): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let call = 0; call < MAX_CALLS; call++) {
    const chunk = parseImageChunk(await native.imagesGet(image.id, offset));
    if (!chunk) throw new Error('The daemon answered in a way this version of Dot cannot read.');
    if (chunk.image.id !== image.id || chunk.image.mime !== image.mime || chunk.image.bytes !== image.bytes) {
      throw new Error('The image does not match the conversation.');
    }
    if (chunk.offset !== offset) throw new Error('The image arrived out of order.');
    const bytes = decodeBase64(chunk.data);
    offset += bytes.length;
    if (offset > image.bytes) throw new Error('The image is larger than announced.');
    parts.push(bytes);
    if (chunk.next === null) {
      if (offset !== image.bytes) throw new Error('The image is incomplete.');
      return new Blob(parts as BlobPart[], { type: image.mime });
    }
    // El siguiente trozo empieza donde acabó este, y avanza.
    if (chunk.next !== offset || bytes.length === 0) throw new Error('The image arrived out of order.');
  }
  throw new Error('The image has too many parts.');
}

/** Los bytes de una imagen compartida. Cacheados por id; un fallo no se recuerda. */
export function loadSharedImage(native: NativeBridge, image: ProtocolSharedImage): Promise<Blob> {
  const known = cache.get(image.id);
  if (known) return known;
  const pending = download(native, image);
  cache.set(image.id, pending);
  pending.catch(() => {
    if (cache.get(image.id) === pending) cache.delete(image.id);
  });
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}
