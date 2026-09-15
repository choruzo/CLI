import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { canonicalChangePath } from './subagent.js';

describe('canonicalChangePath (Hito 16)', () => {
  const base = process.cwd();

  it('las formas de la misma ruta local colisionan', () => {
    const forms = ['a.txt', './a.txt', 'sub/../a.txt', join(base, 'a.txt')];
    const keys = new Set(forms.map((p) => canonicalChangePath('local', base, p)));
    expect(keys).toEqual(new Set(['a.txt']));
  });

  it('el cwd de la llamada se tiene en cuenta', () => {
    expect(canonicalChangePath('local', base, 'x.md', 'docs')).toBe('docs/x.md');
    expect(canonicalChangePath('local', base, 'x.md', 'docs')).not.toBe(
      canonicalChangePath('local', base, 'x.md', 'src'),
    );
  });

  it('la misma ruta en local y en un host remoto no colisiona', () => {
    expect(canonicalChangePath('ssh:web', base, 'a.txt')).toBe('ssh:web:a.txt');
    expect(canonicalChangePath('ssh:web', base, 'log', '/var/tmp/../log')).toBe(
      'ssh:web:/var/log/log',
    );
    expect(canonicalChangePath('ssh:web', base, '/etc/hosts', '/srv')).toBe('ssh:web:/etc/hosts');
  });

  it('fuera del directorio del proceso queda absoluta', () => {
    const outside = canonicalChangePath('local', base, '../../fuera.txt');
    expect(outside.startsWith('..')).toBe(false);
    expect(outside).toContain('fuera.txt');
  });
});
