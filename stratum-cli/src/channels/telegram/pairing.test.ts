import { describe, expect, it } from 'vitest';
import {
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_MAX_FAILURES,
  PAIRING_TTL_MS,
  TelegramPairing,
  newPairingCode,
} from './pairing.js';

const ana = { userId: 42, chatId: 42, name: 'Ana', username: 'ana' };

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('TelegramPairing (M18)', () => {
  it('genera códigos de 10 caracteres sin ambigüedades', () => {
    for (let i = 0; i < 50; i++) {
      const code = newPairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const ch of code) expect(PAIRING_ALPHABET).toContain(ch);
    }
    expect(PAIRING_ALPHABET).not.toMatch(/[01OIL]/);
  });

  it('un código bueno deja un candidato, sin emparejar, y no vale dos veces', () => {
    const c = clock();
    const p = new TelegramPairing(c.now, () => 'ABCDEFGHJK');
    expect(p.status()).toBeNull();
    const { expiresAt } = p.begin();
    expect(expiresAt).toBe(c.now() + PAIRING_TTL_MS);
    expect(p.status()).toEqual({ expiresAt, candidate: null });
    // Mayúsculas o no da igual: se puede teclear.
    expect(p.offer('abcdefghjk', ana)).toBe('candidate');
    expect(p.status()?.candidate).toEqual(ana);
    // De un solo uso: otro con el mismo código no desplaza al primero.
    expect(p.offer('ABCDEFGHJK', { ...ana, userId: 7, chatId: 7 })).toBe('rejected');
    expect(p.status()?.candidate?.userId).toBe(42);
  });

  it('confirmar exige el mismo candidato y lo gasta', () => {
    const c = clock();
    const p = new TelegramPairing(c.now, () => 'ABCDEFGHJK');
    p.begin();
    p.offer('ABCDEFGHJK', ana);
    expect(p.confirm(7)).toBeNull();
    expect(p.confirm(42)).toEqual(ana);
    expect(p.confirm(42)).toBeNull();
    expect(p.status()).toBeNull();
  });

  it('cinco fallos anulan el código', () => {
    const c = clock();
    const p = new TelegramPairing(c.now, () => 'ABCDEFGHJK');
    p.begin();
    for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++)
      expect(p.offer('NOPE', ana)).toBe('rejected');
    expect(p.pending).toBe(true);
    expect(p.offer('NOPE', ana)).toBe('rejected');
    expect(p.pending).toBe(false);
    // Ni el bueno vale ya.
    expect(p.offer('ABCDEFGHJK', ana)).toBe('rejected');
  });

  it('caduca a los 10 minutos, también el candidato', () => {
    const c = clock();
    const p = new TelegramPairing(c.now, () => 'ABCDEFGHJK');
    p.begin();
    c.advance(PAIRING_TTL_MS - 1);
    expect(p.offer('ABCDEFGHJK', ana)).toBe('candidate');
    c.advance(1);
    expect(p.status()).toBeNull();
    expect(p.confirm(42)).toBeNull();
  });

  it('sin código vivo todo se rechaza; uno nuevo anula el anterior y su candidato', () => {
    const c = clock();
    let n = 0;
    const p = new TelegramPairing(c.now, () => (n++ === 0 ? 'AAAAAAAAAA' : 'BBBBBBBBBB'));
    expect(p.offer('AAAAAAAAAA', ana)).toBe('rejected');
    p.begin();
    p.offer('AAAAAAAAAA', ana);
    p.begin();
    expect(p.status()?.candidate).toBeNull();
    expect(p.offer('AAAAAAAAAA', ana)).toBe('rejected');
    expect(p.offer('BBBBBBBBBB', ana)).toBe('candidate');
  });
});
