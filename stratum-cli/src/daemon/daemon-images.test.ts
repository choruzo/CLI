/**
 * M18 parte 6E — `images.get` contra el daemon real: las imágenes que el
 * asistente envió se sirven del almacén de compartidas, por trozos (una imagen
 * no cabe en un mensaje del protocolo), con `observe`.
 */
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import { saveSharedImage, sharedImagesDir } from '../images/shared.js';
import { SHARED_IMAGE_LIMITS, type MethodResult } from '../protocol/index.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.stop();
  t = null;
});

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof ProtocolError ? err.code : String(err);
  }
};

describe('images.get (6E)', () => {
  it('por trozos de chunkBytes hasta next null; los trozos juntos son la imagen', async () => {
    t = await startTestDaemon();
    const png = Buffer.alloc(SHARED_IMAGE_LIMITS.chunkBytes * 2 + 100, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    const { id } = saveSharedImage(png, { dir: sharedImagesDir(join(t.base, 'companion')) });

    const observer = await t.connect(['observer']);
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null) {
      const r: MethodResult<'images.get'> = await observer.request('images.get', {
        imageId: id,
        offset,
      });
      expect(r.image).toEqual({ id, mime: 'image/png', bytes: png.length });
      expect(r.offset).toBe(offset);
      parts.push(Buffer.from(r.data, 'base64'));
      offset = r.next;
      calls++;
    }
    expect(calls).toBe(3);
    expect(Buffer.concat(parts).equals(png)).toBe(true);
  });

  it('un id que no existe es NOT_FOUND; uno con otra forma, INVALID_PARAMS; pasado el final, también', async () => {
    t = await startTestDaemon();
    const observer = await t.connect(['observer']);
    expect(
      await code(observer.request('images.get', { imageId: '20261105T093012Z-0123456789abcdef' })),
    ).toBe('NOT_FOUND');
    expect(await code(observer.request('images.get', { imageId: '../../etc/passwd' }))).toBe(
      'INVALID_PARAMS',
    );
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const { id } = saveSharedImage(png, { dir: sharedImagesDir(join(t.base, 'companion')) });
    expect(await code(observer.request('images.get', { imageId: id, offset: 100 }))).toBe(
      'INVALID_PARAMS',
    );
  });
});
