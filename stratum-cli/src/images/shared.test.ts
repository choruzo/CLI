import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_IMAGE_LIMITS } from '../agent/user-images.js';
import { readSharedImage, saveSharedImage, SHARED_IMAGE_ID_RE } from './shared.js';
import { UserImageError } from './store.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'stratum-shared-')), 'shared');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

describe('almacén de imágenes enviadas (6E)', () => {
  it('guarda una copia y la lee por su id', () => {
    const saved = saveSharedImage(PNG, { dir, now: Date.UTC(2026, 10, 5, 9, 30, 12) });
    expect(saved).toMatchObject({ mime: 'image/png', bytes: PNG.length });
    expect(saved.id).toMatch(SHARED_IMAGE_ID_RE);
    expect(saved.id.startsWith('20261105T093012Z-')).toBe(true);
    const read = readSharedImage(saved.id, dir);
    expect(read?.data.equals(PNG)).toBe(true);
    expect(readdirSync(dir)).toEqual([`${saved.id}.png`]);
  });

  it('un id con otra forma (o de otra carpeta) es null sin tocar el disco', () => {
    for (const id of ['../x', '20261105T093012Z-0123456789abcdef/../a', 'x', '']) {
      expect(readSharedImage(id, dir)).toBeNull();
    }
    expect(readSharedImage('20261105T093012Z-0123456789abcdef', dir)).toBeNull();
  });

  it('lo que no es una imagen, o pasa de 5 MB, no se guarda', () => {
    expect(() => saveSharedImage(Buffer.from('%PDF-1.7'), { dir })).toThrow(UserImageError);
    const big = Buffer.alloc(USER_IMAGE_LIMITS.maxBytes + 1);
    PNG.copy(big);
    expect(() => saveSharedImage(big, { dir })).toThrow(UserImageError);
  });

  it('un fichero cambiado en disco que ya no es imagen no se sirve', () => {
    const { id } = saveSharedImage(PNG, { dir });
    writeFileSync(join(dir, `${id}.png`), 'no soy un png');
    expect(() => readSharedImage(id, dir)).toThrow(UserImageError);
  });

  it('caduca a los 15 días: se purga al guardar otra', () => {
    const { id } = saveSharedImage(PNG, { dir });
    const old = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, `${id}.png`), old, old);
    saveSharedImage(Buffer.concat([PNG, Buffer.from([9])]), { dir });
    expect(readSharedImage(id, dir)).toBeNull();
  });
});
