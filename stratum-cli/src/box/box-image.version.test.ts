/**
 * Lo que va dentro de la imagen de la caja (su `Containerfile`, su entrypoint y
 * el código de los conectores, M20) está atado a `BOX_IMAGE_VERSION`: las cajas
 * solo se recrean si la versión sube. Si este test falla, sube la versión en
 * `spec.ts` y pon aquí la huella nueva que imprime.
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { BOX_IMAGE_VERSION } from './spec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Huella de la imagen por versión. Al subir la versión, se añade su fila. */
const IMAGE_FINGERPRINTS: Record<number, string> = {
  2: 'de22735284cb65db',
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (!/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

function imageFingerprint(): string {
  const inputs = [
    join(ROOT, 'box-image', 'Containerfile'),
    join(ROOT, 'box-image', 'entrypoint.sh'),
    ...files(join(ROOT, 'src', 'connector-servers')),
  ];
  const hash = createHash('sha256');
  for (const file of inputs) {
    hash.update(relative(ROOT, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file, 'utf-8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

describe('versión de la imagen de la caja', () => {
  it('cambiar lo que va en la imagen exige subir BOX_IMAGE_VERSION', () => {
    const actual = imageFingerprint();
    expect(
      IMAGE_FINGERPRINTS[BOX_IMAGE_VERSION],
      `La imagen cambió (huella ${actual}). Sube BOX_IMAGE_VERSION en src/box/spec.ts y ` +
        `añade { ${BOX_IMAGE_VERSION + 1}: '${actual}' } a IMAGE_FINGERPRINTS; ` +
        'si es la versión en curso sin publicar, actualiza solo su huella.',
    ).toBe(actual);
  });
});
