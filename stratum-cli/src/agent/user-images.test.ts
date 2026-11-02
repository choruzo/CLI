import { describe, it, expect } from 'vitest';
import {
  anchorIndex,
  imageMarker,
  sniffImageMime,
  UserImageBuffer,
  USER_IMAGES_IN_CONTEXT,
  withImageMarkers,
  type UserImage,
} from './user-images.js';
import type { Message } from './types.js';

function img(tag: string, over: Partial<UserImage> = {}): UserImage {
  return {
    id: `img-${tag.padEnd(12, '0').slice(0, 12)}`,
    name: `${tag}.png`,
    mime: 'image/png',
    data: `B64${tag}`,
    bytes: 2048,
    sha256: tag.repeat(64).slice(0, 64),
    ...over,
  };
}

const user = (content: string): Message => ({ role: 'user', content });

describe('sniffImageMime', () => {
  it('reconoce PNG, JPEG, GIF y WebP por sus primeros bytes', () => {
    expect(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('lo que no es una imagen admitida (o es demasiado corto) es null', () => {
    expect(sniffImageMime(Buffer.from('hola, esto es texto'))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
    expect(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // RIFF que no es WebP (un WAV).
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull();
  });
});

describe('withImageMarkers', () => {
  it('sin imágenes devuelve el texto tal cual', () => {
    expect(withImageMarkers('hola', [])).toBe('hola');
  });

  it('añade la marca de cada imagen al final del texto', () => {
    const a = img('a');
    const b = img('b');
    expect(withImageMarkers('mira', [a, b])).toBe(`mira\n\n${imageMarker(a)}\n${imageMarker(b)}`);
    expect(imageMarker(a)).toBe(`[image ${a.id} attached: a.png, 2 KB]`);
  });

  it('con texto vacío o en blanco, el mensaje son solo las marcas', () => {
    const a = img('a');
    expect(withImageMarkers('', [a])).toBe(imageMarker(a));
    expect(withImageMarkers('  \n', [a])).toBe(imageMarker(a));
  });

  it('sanea el nombre: sin corchetes ni saltos de línea', () => {
    const marker = imageMarker(img('a', { name: 'mal]\nnombre[\r.png' }));
    expect(marker.split('\n')).toHaveLength(1);
    expect(marker.match(/\]/g)).toHaveLength(1);
    expect(marker.match(/\[/g)).toHaveLength(1);
  });

  it('un nombre vacío o larguísimo queda acotado', () => {
    expect(imageMarker(img('a', { name: '' }))).toContain('attached: image,');
    expect(imageMarker(img('a', { name: 'x'.repeat(500) })).length).toBeLessThan(160);
  });

  it('una imagen minúscula cuenta como 1 KB', () => {
    expect(imageMarker(img('a', { bytes: 10 }))).toContain(', 1 KB]');
  });
});

describe('anchorIndex', () => {
  it('es el último mensaje user o tool con la marca; -1 si ninguno', () => {
    const a = img('a');
    const msgs: Message[] = [
      user(withImageMarkers('uno', [a])),
      { role: 'assistant', content: 'ok' },
      { role: 'tool', tool_call_id: 'c', content: withImageMarkers('steer', [a]) },
      { role: 'assistant', content: `cita ${imageMarker(a)}` },
    ];
    expect(anchorIndex(msgs, a)).toBe(2);
    expect(anchorIndex(msgs, img('z'))).toBe(-1);
  });
});

describe('UserImageBuffer', () => {
  it('guarda las últimas USER_IMAGES_IN_CONTEXT', () => {
    expect(USER_IMAGES_IN_CONTEXT).toBe(4);
    const buf = new UserImageBuffer();
    const all = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => img(t));
    for (const i of all) buf.add(i);
    expect(buf.size).toBe(4);
    const msgs = all.map((i) => user(withImageMarkers('x', [i])));
    expect(buf.forRequest(msgs).map((r) => r.image.id)).toEqual(all.slice(2).map((i) => i.id));
  });

  it('la misma imagen dos veces cuenta una, la más reciente (reordena)', () => {
    const buf = new UserImageBuffer();
    const [a, b, c] = [img('a'), img('b'), img('c')] as [UserImage, UserImage, UserImage];
    buf.add(a);
    buf.add(b);
    buf.add(c);
    buf.add(a);
    expect(buf.size).toBe(3);
    const msgs = [a, b, c].map((i) => user(withImageMarkers('x', [i])));
    expect(buf.forRequest(msgs).map((r) => r.image.id)).toEqual([b.id, c.id, a.id]);
  });

  it('forRequest descarta la que ya no tiene su marca en el historial', () => {
    const buf = new UserImageBuffer();
    const a = img('a');
    const b = img('b');
    buf.add(a);
    buf.add(b);
    // `a` se compactó: su mensaje ya no está.
    const msgs = [user(withImageMarkers('queda', [b]))];
    expect(buf.forRequest(msgs).map((r) => r.image.id)).toEqual([b.id]);
    expect(buf.forRequest([])).toEqual([]);
  });

  it('una marca citada por el assistant no cuenta como ancla', () => {
    const buf = new UserImageBuffer();
    const a = img('a');
    buf.add(a);
    expect(buf.forRequest([{ role: 'assistant', content: imageMarker(a) }])).toEqual([]);
  });

  it('clear la vacía', () => {
    const buf = new UserImageBuffer();
    buf.add(img('a'));
    buf.clear();
    expect(buf.size).toBe(0);
  });
});
