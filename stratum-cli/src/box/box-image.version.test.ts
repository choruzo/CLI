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
  2: 'bbfe073138d7c0eb',
  3: 'a5504ba322b45ca3',
  // Recalculada sin `NOT_IN_IMAGE` (antes '8a8c3d4d83f51880'): misma imagen, otra fórmula.
  4: 'a636c81f91ce4d0a',
  5: 'c1fc3be07bc61789',
  // M21 fase 3: el conector `google`.
  6: '783c9add8bd78f4b',
  // M21: autobuses urbanos (M9) e interurbanos (M89) en `crtm`.
  7: 'fa7774e9fede8d3f',
  // home-assistant: listas metidas en un texto y mensaje de DNS más claro.
  8: '2559cb0aff8a16e8',
  // M22: `ha_comprobar` (checks: estado estructurado) en home-assistant.
  9: 'c3badbb09436f8a6',
  // M22 fase 4: comprobaciones de aemet, renfe (Cercanías) y google (Gmail y Tasks).
  10: 'b87f221303e174fd',
  // M22 parte 2: Google Calendar en el conector `google`.
  11: '99734ebc11c4bf07',
  // M22 parte 4: `ha_historial` en home-assistant.
  12: '60652836f162df55',
  // M28 fase 2: el conector `grocy` (solo lectura).
  13: '330dd4b3ac978c27',
};

/**
 * Lo de `src/connector-servers/` que nunca entra en la imagen: los tests, sus
 * fixtures y el server de fixtures de los evals (M20), con sus helpers. Cambiarlo
 * no recrea las cajas; el último test comprueba que la imagen no lo importa.
 */
const NOT_IN_IMAGE =
  /(\.test\.ts|[\\/]test-helpers\.ts|[\\/]fixture-server\.ts)$|[\\/]fixtures[\\/]/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (!NOT_IN_IMAGE.test(full)) out.push(full);
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

  it('lo que queda fuera de la huella no lo importa el código de la imagen', () => {
    for (const file of files(join(ROOT, 'src', 'connector-servers'))) {
      const code = readFileSync(file, 'utf-8');
      expect(code, relative(ROOT, file)).not.toMatch(
        /['"][^'"]*(test-helpers|fixture-server)(\.js)?['"]/,
      );
    }
  });
});
