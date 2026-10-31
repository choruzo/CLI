import { describe, expect, it } from 'vitest';
import { SCREEN_LEASE_MS, ScreenLocks } from './lock.js';

function make() {
  let t = 1_000;
  const locks = new ScreenLocks(() => t);
  return { locks, advance: (ms: number) => (t += ms) };
}

describe('ScreenLocks', () => {
  it('libre: lo toma el primero', () => {
    const { locks } = make();
    expect(locks.holderOf('box')).toBeNull();
    expect(locks.claim('box', 'a')).toEqual({ ok: true });
    expect(locks.holderOf('box')).toBe('a');
  });

  it('el mismo holder renueva y retrasa la caducidad', () => {
    const { locks, advance } = make();
    locks.claim('box', 'a');
    advance(SCREEN_LEASE_MS - 1);
    expect(locks.claim('box', 'a')).toEqual({ ok: true });
    advance(SCREEN_LEASE_MS - 1);
    expect(locks.claim('box', 'b')).toEqual({ ok: false, holder: 'a' });
  });

  it('ocupado por otro: no lo toma y dice quién', () => {
    const { locks } = make();
    locks.claim('box', 'a');
    expect(locks.claim('box', 'b')).toEqual({ ok: false, holder: 'a' });
    expect(locks.holderOf('box')).toBe('a');
  });

  it('el lease caducado se puede tomar', () => {
    const { locks, advance } = make();
    locks.claim('box', 'a');
    advance(SCREEN_LEASE_MS + 1);
    expect(locks.holderOf('box')).toBeNull();
    expect(locks.claim('box', 'b')).toEqual({ ok: true });
    expect(locks.holderOf('box')).toBe('b');
  });

  it('release solo suelta lo de ese holder y es idempotente', () => {
    const { locks } = make();
    locks.claim('box', 'a');
    locks.release('b');
    expect(locks.holderOf('box')).toBe('a');
    locks.release('a');
    locks.release('a');
    expect(locks.holderOf('box')).toBeNull();
    expect(locks.claim('box', 'b')).toEqual({ ok: true });
  });

  it('dos cajas son independientes', () => {
    const { locks } = make();
    locks.claim('one', 'a');
    expect(locks.claim('two', 'b')).toEqual({ ok: true });
    locks.release('a');
    expect(locks.holderOf('two')).toBe('b');
  });
});
