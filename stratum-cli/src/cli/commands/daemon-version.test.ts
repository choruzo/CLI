import { describe, expect, it } from 'vitest';
import { versionSkewNote } from './daemon.js';

describe('versionSkewNote (M23)', () => {
  it('misma versión: nada que decir', () => {
    expect(versionSkewNote('0.15.0', '0.15.0')).toBeNull();
  });

  it('otra versión: lo dice y cómo reiniciarlo, sin hacerlo', () => {
    const note = versionSkewNote('0.14.0', '0.15.0');
    expect(note).toContain('Stratum 0.14.0');
    expect(note).toContain('this CLI is 0.15.0');
    expect(note).toContain('stratum daemon stop, then stratum daemon start');
    expect(note?.endsWith('\n')).toBe(true);
  });
});
