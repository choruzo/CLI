/**
 * M15 — lo puro del computer use: leer una captura PNG y convertir el punto que
 * da el modelo a un píxel de la pantalla de la caja. Sin I/O.
 */
import { createHash } from 'crypto';
import type { ModelVision } from '../../config/schema.js';
import type { ToolImage } from '../../agent/types.js';

export interface ScreenGeometry {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * La captura que devuelve la caja (PNG en base64) como `ToolImage`. Las
 * dimensiones salen de la cabecera `IHDR`: no se suponen. Lanza si no es un PNG.
 */
export function pngImage(base64: string): ToolImage {
  const data = base64.replace(/\s+/g, '');
  const bytes = Buffer.from(data, 'base64');
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error('the box did not return a PNG screenshot');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error('the screenshot has no pixels');
  return {
    mime: 'image/png',
    data,
    width,
    height,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Resultado de convertir un punto del modelo: el píxel, o por qué no vale. */
export type PointResult = { ok: true; x: number; y: number } | { ok: false; error: string };

/**
 * Punto del modelo → píxel de la pantalla. `pixels`: tal cual (redondeado),
 * dentro de la pantalla. `norm1000`: 0–1000 en cada eje, reescalado a la
 * pantalla; 1000 es el borde derecho/inferior (el último píxel).
 */
export function toScreenPoint(
  x: number,
  y: number,
  vision: ModelVision,
  screen: ScreenGeometry,
): PointResult {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: 'x and y must be numbers' };
  }
  if (vision.coordinates === 'norm1000') {
    if (x < 0 || x > 1000 || y < 0 || y > 1000) {
      return {
        ok: false,
        error: `(${x}, ${y}) is outside the screen: coordinates are normalized to 0–1000 on each axis`,
      };
    }
    return {
      ok: true,
      x: Math.min(screen.width - 1, Math.round((x * screen.width) / 1000)),
      y: Math.min(screen.height - 1, Math.round((y * screen.height) / 1000)),
    };
  }
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px >= screen.width || py < 0 || py >= screen.height) {
    return {
      ok: false,
      error:
        `(${x}, ${y}) is outside the ${screen.width}×${screen.height} screen: ` +
        `x must be 0–${screen.width - 1} and y 0–${screen.height - 1} pixels`,
    };
  }
  return { ok: true, x: px, y: py };
}

/** Ampliación máxima de `screen_zoom` y el lienzo en que cabe lo ampliado. */
export const ZOOM_MAX_SCALE = 4;
export const ZOOM_CANVAS: ScreenGeometry = { width: 1280, height: 800 };
/** Lado mínimo del recorte, en píxeles de la pantalla: uno menor se agranda alrededor de su centro. */
export const ZOOM_MIN_SIDE = 32;

/** El recorte de la pantalla que amplía `screen_zoom` y el tamaño de la imagen que sale. */
export interface ZoomRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  outWidth: number;
  outHeight: number;
}

export type ZoomResult = { ok: true; region: ZoomRegion } | { ok: false; error: string };

/**
 * Rectángulo del modelo (dos esquinas, en su convención) → recorte en píxeles
 * de la pantalla y tamaño de salida: ampliado hasta `ZOOM_MAX_SCALE` sin pasar
 * de `ZOOM_CANVAS`, con la misma proporción.
 */
export function zoomRegion(
  corners: { x1: number; y1: number; x2: number; y2: number },
  vision: ModelVision,
  screen: ScreenGeometry,
): ZoomResult {
  const a = toScreenPoint(corners.x1, corners.y1, vision, screen);
  if (!a.ok) return a;
  const b = toScreenPoint(corners.x2, corners.y2, vision, screen);
  if (!b.ok) return b;
  const span = (lo: number, hi: number, size: number): [number, number] => {
    let start = Math.min(lo, hi);
    let len = Math.abs(hi - lo) + 1;
    if (len < ZOOM_MIN_SIDE) {
      const side = Math.min(ZOOM_MIN_SIDE, size);
      start = Math.round((lo + hi) / 2 - side / 2);
      len = side;
    }
    start = Math.max(0, Math.min(start, size - len));
    return [start, len];
  };
  const [x, width] = span(a.x, b.x, screen.width);
  const [y, height] = span(a.y, b.y, screen.height);
  const scale = Math.max(
    1,
    Math.min(ZOOM_MAX_SCALE, ZOOM_CANVAS.width / width, ZOOM_CANVAS.height / height),
  );
  return {
    ok: true,
    region: {
      x,
      y,
      width,
      height,
      outWidth: Math.round(width * scale),
      outHeight: Math.round(height * scale),
    },
  };
}

/**
 * Punto del modelo en la imagen ampliada (su convención, sobre esa imagen) →
 * píxel de la pantalla. La escala sale de la imagen que devolvió la caja, no
 * de la que se pidió.
 */
export function fromZoomPoint(
  x: number,
  y: number,
  vision: ModelVision,
  zoom: { region: ZoomRegion; image: ScreenGeometry },
): PointResult {
  const p = toScreenPoint(x, y, vision, zoom.image);
  if (!p.ok) return { ok: false, error: `${p.error} (in the zoomed image)` };
  const { region, image } = zoom;
  const axis = (v: number, from: number, to: number, start: number): number =>
    start + Math.min(to - 1, Math.floor(((v + 0.5) * to) / from));
  return {
    ok: true,
    x: axis(p.x, image.width, region.width, region.x),
    y: axis(p.y, image.height, region.height, region.y),
  };
}

/** Cómo tiene que dar el modelo un punto, para el texto de cada captura. */
export function coordinatesHint(vision: ModelVision, screen: ScreenGeometry): string {
  return vision.coordinates === 'norm1000'
    ? 'Give x and y normalized to 0–1000 on each axis (0,0 top-left; 1000,1000 bottom-right).'
    : `Give x and y in pixels of this screenshot (x 0–${screen.width - 1}, y 0–${screen.height - 1}; 0,0 top-left).`;
}
