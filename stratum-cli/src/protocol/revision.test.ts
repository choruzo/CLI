/**
 * M23 — la revisión del protocolo sigue a lo que se añade. Cada revisión guarda
 * la huella de sus métodos y eventos: añadir uno (o quitarlo) sin subir
 * `STRATUM_PROTOCOL_REVISION` y apuntar aquí la huella nueva hace fallar el
 * test. Un campo nuevo no cambia la huella: subirla también por eso es cosa de
 * quien lo añade (`docs/protocol.md` §17).
 */
import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { PARAMS, STATE_EVENT_DATA, VOLATILE_EVENT_DATA } from './schemas.js';
import { STRATUM_PROTOCOL_REVISION, compareRevision } from './version.js';

const FINGERPRINTS: Record<number, string> = {
  1: 'bcaa26ff727e01bd',
  // M25 — área `voice` en `doctor.run`: misma huella, otro valor de un enum.
  2: 'bcaa26ff727e01bd',
};

function fingerprint(): string {
  const parts = [
    ...Object.keys(PARAMS).map((m) => `m:${m}`),
    ...Object.keys(STATE_EVENT_DATA).map((e) => `s:${e}`),
    ...Object.keys(VOLATILE_EVENT_DATA).map((e) => `v:${e}`),
  ].sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

describe('STRATUM_PROTOCOL_REVISION', () => {
  it('la huella de métodos y eventos es la de su revisión', () => {
    expect(
      FINGERPRINTS[STRATUM_PROTOCOL_REVISION],
      'Métodos o eventos cambiaron: sube STRATUM_PROTOCOL_REVISION y apunta la huella nueva',
    ).toBe(fingerprint());
  });
});

describe('compareRevision', () => {
  it('dice quién se quedó atrás', () => {
    expect(compareRevision(3, 3)).toBe('same');
    expect(compareRevision(2, 3)).toBe('server-older');
    expect(compareRevision(4, 3)).toBe('server-newer');
  });

  it('un servidor sin revisión es anterior', () => {
    expect(compareRevision(undefined, 1)).toBe('server-older');
    expect(compareRevision(undefined)).toBe(
      STRATUM_PROTOCOL_REVISION > 0 ? 'server-older' : 'same',
    );
  });
});
