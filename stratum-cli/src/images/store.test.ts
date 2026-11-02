import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IMAGE_RETENTION_MS,
  loadUserImage,
  loadUserImages,
  purgeExpiredImages,
  saveUserImage,
  UserImageError,
  userImagesDir,
} from './store.js';

const DAY = 24 * 60 * 60 * 1000;

/** PNG mínimo: el código solo mira la firma de 8 bytes. */
const png = (extra = 'x'): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(extra),
  ]);

/** ¿Puede este sistema crear enlaces simbólicos? (Windows sin permisos, no.) */
function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'stratum-symprobe-'));
  try {
    writeFileSync(join(probe, 't'), 'x');
    symlinkSync(join(probe, 't'), join(probe, 'l'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const SYMLINKS = canSymlink();

let root: string;
let cwd: string;
let outside: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-images-')));
  cwd = join(root, 'proyecto');
  outside = join(root, 'fuera');
  home = join(root, 'home');
  for (const d of [cwd, outside, home]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('userImagesDir', () => {
  it('cuelga de <home>/.stratum/images', () => {
    expect(userImagesDir('/h')).toBe(join('/h', '.stratum', 'images'));
  });
});

describe('saveUserImage', () => {
  it('crea el fichero con la extensión de su tipo', () => {
    const dir = join(root, 'imgs');
    const path = saveUserImage(png(), { dir });
    expect(path.endsWith('.png')).toBe(true);
    expect(existsSync(path)).toBe(true);
    const jpg = saveUserImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]), { dir });
    expect(jpg.endsWith('.jpg')).toBe(true);
    expect(readdirSync(dir)).toHaveLength(2);
    expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('purga lo de más de 15 días y respeta lo de 14', () => {
    expect(IMAGE_RETENTION_MS).toBe(15 * DAY);
    const dir = join(root, 'imgs');
    mkdirSync(dir);
    const old = join(dir, 'viejo.png');
    const recent = join(dir, 'reciente.png');
    writeFileSync(old, png());
    writeFileSync(recent, png());
    const now = Date.now();
    utimesSync(old, new Date(now - 16 * DAY), new Date(now - 16 * DAY));
    utimesSync(recent, new Date(now - 14 * DAY), new Date(now - 14 * DAY));
    saveUserImage(png('nueva'), { dir, now });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('rechaza lo que pesa más de 5 MB y lo que no es una imagen', () => {
    const dir = join(root, 'imgs');
    const big = Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]);
    expect(() => saveUserImage(big, { dir })).toThrow(UserImageError);
    expect(() => saveUserImage(Buffer.from('texto'), { dir })).toThrow(UserImageError);
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
  });
});

describe('purgeExpiredImages', () => {
  it('un directorio inexistente no lanza', () => {
    expect(purgeExpiredImages(join(root, 'no-existe'))).toBe(0);
  });
});

describe('loadUserImage', () => {
  it('lee una ruta relativa al cwd; id = img- + 12 hex del sha256', () => {
    const bytes = png('contenido');
    writeFileSync(join(cwd, 'a.png'), bytes);
    const image = loadUserImage('a.png', { cwd, roots: [cwd] });
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(image.id).toBe(`img-${sha.slice(0, 12)}`);
    expect(image.id).toMatch(/^img-[0-9a-f]{12}$/);
    expect(image.sha256).toBe(sha);
    expect(image.name).toBe('a.png');
    expect(image.mime).toBe('image/png');
    expect(image.bytes).toBe(bytes.length);
    expect(image.data).toBe(bytes.toString('base64'));
  });

  it('una ruta fuera de las raíces es un error', () => {
    const file = join(outside, 'b.png');
    writeFileSync(file, png());
    expect(() => loadUserImage(file, { cwd, roots: [cwd] })).toThrow(UserImageError);
    expect(() => loadUserImage('../fuera/b.png', { cwd, roots: [cwd] })).toThrow(UserImageError);
  });

  it('un fichero que no existe, un directorio y un no-imagen son errores', () => {
    mkdirSync(join(cwd, 'dir'));
    writeFileSync(join(cwd, 'nota.png'), 'esto es texto');
    expect(() => loadUserImage('no.png', { cwd, roots: [cwd] })).toThrow(/not found/);
    expect(() => loadUserImage('dir', { cwd, roots: [cwd] })).toThrow(UserImageError);
    expect(() => loadUserImage('nota.png', { cwd, roots: [cwd] })).toThrow(/not a PNG/);
  });

  it('rechaza una imagen de más de 5 MB', () => {
    writeFileSync(join(cwd, 'grande.png'), Buffer.concat([png(), Buffer.alloc(5 * 1024 * 1024)]));
    expect(() => loadUserImage('grande.png', { cwd, roots: [cwd] })).toThrow(/too large/);
  });

  it.skipIf(!SYMLINKS)('un enlace dentro de la raíz que apunta fuera se rechaza', () => {
    const target = join(outside, 'secreto.png');
    writeFileSync(target, png());
    symlinkSync(target, join(cwd, 'enlace.png'));
    expect(() => loadUserImage('enlace.png', { cwd, roots: [cwd] })).toThrow(UserImageError);
  });
});

describe('loadUserImages', () => {
  it('vacío es vacío', () => {
    expect(loadUserImages([], { cwd, home })).toEqual([]);
  });

  it('por defecto lee del cwd y de ~/.stratum/images', () => {
    const dir = userImagesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pegada.png'), png('p'));
    writeFileSync(join(cwd, 'a.png'), png('a'));
    const out = loadUserImages(['a.png', join(dir, 'pegada.png')], { cwd, home });
    expect(out.map((i) => i.name)).toEqual(['a.png', 'pegada.png']);
  });

  it('más de 5 rutas es un error', () => {
    const names = ['1', '2', '3', '4', '5', '6'].map((n) => {
      writeFileSync(join(cwd, `${n}.png`), png(n));
      return `${n}.png`;
    });
    expect(() => loadUserImages(names, { cwd, home })).toThrow(/At most 5/);
    expect(loadUserImages(names.slice(0, 5), { cwd, home })).toHaveLength(5);
  });

  it('todo o nada: una mala entre buenas lanza', () => {
    writeFileSync(join(cwd, 'ok.png'), png());
    writeFileSync(join(outside, 'mal.png'), png());
    expect(() =>
      loadUserImages(['ok.png', join(outside, 'mal.png'), 'ok.png'], { cwd, home }),
    ).toThrow(UserImageError);
  });
});
