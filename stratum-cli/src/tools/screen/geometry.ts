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

/** Cómo tiene que dar el modelo un punto, para el texto de cada captura. */
export function coordinatesHint(vision: ModelVision, screen: ScreenGeometry): string {
  return vision.coordinates === 'norm1000'
    ? 'Give x and y normalized to 0–1000 on each axis (0,0 top-left; 1000,1000 bottom-right).'
    : `Give x and y in pixels of this screenshot (x 0–${screen.width - 1}, y 0–${screen.height - 1}; 0,0 top-left).`;
}
