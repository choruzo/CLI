import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import {
  coordinatesHint,
  fromZoomPoint,
  pngImage,
  toScreenPoint,
  zoomRegion,
  ZOOM_MIN_SIDE,
} from './geometry.js';

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

describe('zoomRegion', () => {
  const pixels = { coordinates: 'pixels' as const };
  const norm = { coordinates: 'norm1000' as const };

  it('recorta el rectángulo y lo amplía hasta 4× sin pasar del lienzo', () => {
    const r = zoomRegion({ x1: 100, y1: 100, x2: 259, y2: 199 }, pixels, SCREEN);
    expect(r).toEqual({
      ok: true,
      region: { x: 100, y: 100, width: 160, height: 100, outWidth: 640, outHeight: 400 },
    });
  });

  it('las esquinas en cualquier orden y en norm1000', () => {
    const r = zoomRegion({ x1: 250, y1: 250, x2: 0, y2: 0 }, norm, SCREEN);
    expect(r.ok && r.region).toMatchObject({ x: 0, y: 0, width: 321, height: 201 });
  });

  it('un área diminuta se agranda alrededor de su centro, dentro de la pantalla', () => {
    const r = zoomRegion({ x1: 10, y1: 10, x2: 12, y2: 12 }, pixels, SCREEN);
    expect(r.ok && r.region).toMatchObject({
      x: 0,
      y: 0,
      width: ZOOM_MIN_SIDE,
      height: ZOOM_MIN_SIDE,
    });
    const edge = zoomRegion({ x1: 1270, y1: 790, x2: 1279, y2: 799 }, pixels, SCREEN);
    expect(edge.ok && edge.region).toMatchObject({
      x: 1280 - ZOOM_MIN_SIDE,
      y: 800 - ZOOM_MIN_SIDE,
    });
  });

  it('la pantalla entera no se amplía (escala 1)', () => {
    const r = zoomRegion({ x1: 0, y1: 0, x2: 1279, y2: 799 }, pixels, SCREEN);
    expect(r.ok && r.region).toMatchObject({ outWidth: 1280, outHeight: 800 });
  });

  it('una esquina fuera de la pantalla es un error', () => {
    expect(zoomRegion({ x1: 0, y1: 0, x2: 2000, y2: 10 }, pixels, SCREEN).ok).toBe(false);
    expect(zoomRegion({ x1: 0, y1: 0, x2: 1001, y2: 10 }, norm, SCREEN).ok).toBe(false);
  });
});

describe('fromZoomPoint', () => {
  const region = { x: 100, y: 100, width: 160, height: 100, outWidth: 640, outHeight: 400 };
  const zoom = { region, image: { width: 640, height: 400 } };

  it('un punto de la imagen ampliada vuelve a su píxel de la pantalla', () => {
    expect(fromZoomPoint(320, 200, { coordinates: 'pixels' }, zoom)).toEqual({
      ok: true,
      x: 180,
      y: 150,
    });
    expect(fromZoomPoint(0, 0, { coordinates: 'pixels' }, zoom)).toEqual({
      ok: true,
      x: 100,
      y: 100,
    });
    expect(fromZoomPoint(639, 399, { coordinates: 'pixels' }, zoom)).toEqual({
      ok: true,
      x: 259,
      y: 199,
    });
  });

  it('norm1000 sobre la imagen ampliada llega al mismo píxel', () => {
    expect(fromZoomPoint(500, 500, { coordinates: 'norm1000' }, zoom)).toEqual({
      ok: true,
      x: 180,
      y: 150,
    });
  });

  it('la escala sale de la imagen devuelta, no de la pedida', () => {
    const other = { region, image: { width: 320, height: 200 } };
    expect(fromZoomPoint(160, 100, { coordinates: 'pixels' }, other)).toEqual({
      ok: true,
      x: 180,
      y: 150,
    });
  });

  it('fuera de la imagen ampliada es un error que lo dice', () => {
    const r = fromZoomPoint(700, 10, { coordinates: 'pixels' }, zoom);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('zoomed');
  });
});

describe('coordinatesHint', () => {
  it('dice la convención del modelo', () => {
    expect(coordinatesHint({ coordinates: 'pixels' }, SCREEN)).toContain('pixels');
    expect(coordinatesHint({ coordinates: 'norm1000' }, SCREEN)).toContain('0–1000');
  });
});
