import { describe, expect, it } from 'vitest';
import { formatConnectorsBoxLine } from './box.js';

describe('formatConnectorsBoxLine', () => {
  it('sin caja de conectores y sin conectores activos no dice nada', () => {
    expect(formatConnectorsBoxLine({ state: 'absent', outdated: false }, false)).toBeNull();
  });

  it('con un conector activo y la caja sin crear lo dice', () => {
    expect(formatConnectorsBoxLine({ state: 'absent', outdated: false }, true)).toBe(
      '  connectors box: not created',
    );
  });

  it('con la caja corriendo, aunque no haya conectores activos', () => {
    expect(formatConnectorsBoxLine({ state: 'running', outdated: false }, false)).toBe(
      '  connectors box: running',
    );
  });

  it('desactualizada y con razón', () => {
    expect(
      formatConnectorsBoxLine(
        { state: 'stopped', outdated: true, reason: 'failed to start' },
        true,
      ),
    ).toBe('  connectors box: stopped, outdated (recreated on next start)\n    failed to start');
  });
});
