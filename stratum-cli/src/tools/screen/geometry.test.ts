import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { coordinatesHint, pngImage, toScreenPoint } from './geometry.js';

/** Cabecera mínima de un PNG (firma + IHDR): basta para leer sus dimensiones. */
function fakePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

const SCREEN = { width: 1280, height: 800 };

describe('pngImage', () => {
  it('lee dimensiones, tamaño y hash de la cabecera', () => {
    const png = fakePng(1280, 800);
    const image = pngImage(`${png.toString('base64')}\n`);
    expect(image).toMatchObject({ mime: 'image/png', width: 1280, height: 800, bytes: png.length });
    expect(image.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect(image.data).not.toContain('\n');
  });

  it('rechaza lo que no es un PNG', () => {
    expect(() => pngImage(Buffer.from('no soy una imagen').toString('base64'))).toThrow(/PNG/);
    expect(() => pngImage('')).toThrow(/PNG/);
  });

  it('rechaza un PNG sin píxeles', () => {
    expect(() => pngImage(fakePng(0, 800).toString('base64'))).toThrow(/pixels/);
  });
});

describe('toScreenPoint', () => {
  const pixels = { coordinates: 'pixels' as const };
  const norm = { coordinates: 'norm1000' as const };

  it('pixels: el punto tal cual, redondeado', () => {
    expect(toScreenPoint(640.4, 399.6, pixels, SCREEN)).toEqual({ ok: true, x: 640, y: 400 });
    expect(toScreenPoint(1279, 799, pixels, SCREEN)).toEqual({ ok: true, x: 1279, y: 799 });
  });

  it('pixels: fuera de la pantalla es un error que dice el rango', () => {
    const r = toScreenPoint(1280, 10, pixels, SCREEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('0–1279');
    expect(toScreenPoint(-1, 10, pixels, SCREEN).ok).toBe(false);
  });

  it('norm1000: reescala a la pantalla y 1000 es el último píxel', () => {
    expect(toScreenPoint(500, 500, norm, SCREEN)).toEqual({ ok: true, x: 640, y: 400 });
    expect(toScreenPoint(0, 0, norm, SCREEN)).toEqual({ ok: true, x: 0, y: 0 });
    expect(toScreenPoint(1000, 1000, norm, SCREEN)).toEqual({ ok: true, x: 1279, y: 799 });
  });

  it('norm1000: un punto en píxeles de más de 1000 no se acepta en silencio', () => {
    expect(toScreenPoint(1100, 200, norm, SCREEN).ok).toBe(false);
  });

  it('el mismo elemento se alcanza en los dos formatos', () => {
    // Un botón en el píxel (960, 200): un modelo norm1000 lo da como (750, 250).
    expect(toScreenPoint(750, 250, norm, SCREEN)).toEqual({ ok: true, x: 960, y: 200 });
    expect(toScreenPoint(960, 200, pixels, SCREEN)).toEqual({ ok: true, x: 960, y: 200 });
  });

  it('rechaza lo que no es un número finito', () => {
    expect(toScreenPoint(Number.NaN, 1, pixels, SCREEN).ok).toBe(false);
  });
});

describe('coordinatesHint', () => {
  it('dice la convención del modelo', () => {
    expect(coordinatesHint({ coordinates: 'pixels' }, SCREEN)).toContain('pixels');
    expect(coordinatesHint({ coordinates: 'norm1000' }, SCREEN)).toContain('0–1000');
  });
});
