import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  formatImageChips,
  imagePathFromInput,
  loadChipImages,
  messageWithImagesLabel,
  steerWithImages,
} from './image-attach.js';
import { UserImageError } from '../../images/store.js';
import type { UserImage } from '../../agent/user-images.js';

const cwd = resolve('/proj');
const exists = (...paths: string[]) => {
  const set = new Set(paths.map((p) => resolve(p)));
  return (f: string) => set.has(resolve(f));
};

describe('imagePathFromInput', () => {
  it('ruta absoluta existente', () => {
    const p = resolve('/fotos/a.png');
    expect(imagePathFromInput(p, { cwd, isFile: exists(p) })).toBe(p);
  });

  it('con comillas dobles o simples', () => {
    const p = resolve('/fotos/a.png');
    expect(imagePathFromInput(`"${p}"`, { cwd, isFile: exists(p) })).toBe(p);
    expect(imagePathFromInput(`'${p}'`, { cwd, isFile: exists(p) })).toBe(p);
  });

  it("formato de PowerShell al arrastrar: & '…'", () => {
    const p = resolve('/fotos/mi foto.png');
    expect(imagePathFromInput(`& '${p}'`, { cwd, isFile: exists(p) })).toBe(p);
  });

  it('espacios, con comillas', () => {
    const p = resolve('/mis fotos/una foto.jpg');
    expect(imagePathFromInput(`"${p}"`, { cwd, isFile: exists(p) })).toBe(p);
  });

  it('espacios escapados con barra (terminales Unix)', () => {
    const p = resolve('/mis fotos/una foto.jpg');
    const escaped = p.replace(/ /g, '\\ ');
    expect(imagePathFromInput(escaped, { cwd, platform: 'linux', isFile: exists(p) })).toBe(p);
  });

  it('extensión en mayúsculas', () => {
    const p = resolve('/fotos/A.PNG');
    expect(imagePathFromInput(p, { cwd, isFile: exists(p) })).toBe(p);
  });

  it('ruta relativa: se resuelve contra el cwd', () => {
    const abs = resolve(cwd, 'img/x.webp');
    expect(imagePathFromInput('img/x.webp', { cwd, isFile: exists(abs) })).toBe(abs);
  });

  it('ruta inexistente → texto normal', () => {
    expect(imagePathFromInput('/nada/a.png', { cwd, isFile: () => false })).toBeNull();
  });

  it('extensión que no es de imagen → texto normal', () => {
    const p = resolve('/fotos/a.txt');
    expect(imagePathFromInput(p, { cwd, isFile: exists(p) })).toBeNull();
  });

  it('texto con una ruta dentro o varias líneas → texto normal', () => {
    const p = resolve('/fotos/a.png');
    expect(imagePathFromInput(`mira ${p}`, { cwd, isFile: exists(p) })).toBeNull();
    expect(imagePathFromInput(`${p}\nmás`, { cwd, isFile: exists(p) })).toBeNull();
    expect(imagePathFromInput('', { cwd, isFile: () => true })).toBeNull();
  });
});

describe('chips', () => {
  it('se numeran', () => {
    expect(formatImageChips(0)).toBe('');
    expect(formatImageChips(2)).toBe('[imagen 1] [imagen 2]');
  });

  it('la burbuja del usuario lleva texto e imágenes, o solo imágenes', () => {
    expect(messageWithImagesLabel('hola', 0)).toBe('hola');
    expect(messageWithImagesLabel('hola', 1)).toBe('hola [imagen 1]');
    expect(messageWithImagesLabel('', 2)).toBe('[imagen 1] [imagen 2]');
  });
});

const image = { id: 'img-1', name: 'a.png' } as UserImage;

describe('loadChipImages / steerWithImages', () => {
  it('carga las imágenes de los chips con el cwd', () => {
    const load = vi.fn(() => [image]);
    expect(loadChipImages(['/a.png'], '/p', load)).toEqual({ ok: true, images: [image] });
    expect(load).toHaveBeenCalledWith(['/a.png'], { cwd: '/p' });
  });

  it('un UserImageError devuelve su texto; otro error, un aviso genérico', () => {
    const bad = () => {
      throw new UserImageError('a.png: file not found.');
    };
    expect(loadChipImages(['/a.png'], '/p', bad)).toEqual({
      ok: false,
      message: 'a.png: file not found.',
    });
    const boom = () => {
      throw new Error('EIO');
    };
    const r = loadChipImages(['/a.png'], '/p', boom);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('EIO');
  });

  it('el steering pasa las imágenes a enqueueUserMessage', () => {
    const enqueue = vi.fn(() => ({ status: 'accepted' as const, event: {} as never }));
    const out = steerWithImages({ enqueueUserMessage: enqueue }, 'mira', ['/a.png'], '/p', () => [
      image,
    ]);
    expect(out.status).toBe('accepted');
    expect(enqueue).toHaveBeenCalledWith('mira', [image]);
  });

  it('si la carga falla no se encola nada', () => {
    const enqueue = vi.fn();
    const out = steerWithImages({ enqueueUserMessage: enqueue }, 'mira', ['/a.png'], '/p', () => {
      throw new UserImageError('too big');
    });
    expect(out).toEqual({ status: 'load-failed', message: 'too big' });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
