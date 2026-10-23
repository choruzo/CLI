import { describe, it, expect } from 'vitest';
import { formatDiagnostics, type DiagnosticsReport } from './format.js';

const report = (
  diagnostics: DiagnosticsReport['diagnostics'],
  server = 'typescript',
): DiagnosticsReport => ({
  server,
  uri: 'file:///proj/src/a.ts',
  diagnostics,
});

const error = (
  line: number,
  character: number,
  message: string,
  code?: string | number | { value: string | number },
) => ({
  range: { start: { line, character }, end: { line, character: character + 1 } },
  severity: 1,
  ...(code === undefined ? {} : { code }),
  message,
});

const warning = (
  line: number,
  character: number,
  message: string,
  code?: string | number | { value: string | number },
) => ({
  ...error(line, character, message, code),
  severity: 2,
});

const options = { maxDiagnostics: 20, severity: 'error' as const, displayPath: 'src/a.ts' };

describe('formatDiagnostics', () => {
  it('pinta el formato del encargo, con línea y columna 1-based', () => {
    const text = formatDiagnostics(
      report([
        error(11, 4, "Type 'string' is not assignable to type 'number'.", 'TS2322'),
        error(39, 0, "';' expected.", 'TS1005'),
      ]),
      options,
    );
    expect(text).toBe(
      [
        'Diagnostics (typescript) for src/a.ts — 2 errors:',
        "  12:5  error  TS2322  Type 'string' is not assignable to type 'number'.",
        "  40:1  error  TS1005  ';' expected.",
      ].join('\n'),
    );
  });

  it('sin errores lo dice en una línea', () => {
    expect(formatDiagnostics(report([]), options)).toBe(
      'Diagnostics (typescript) for src/a.ts: no errors.',
    );
  });

  it('con umbral error, los avisos del servidor no cuentan', () => {
    expect(formatDiagnostics(report([warning(0, 0, 'variable sin usar', 'TS6133')]), options)).toBe(
      'Diagnostics (typescript) for src/a.ts: no errors.',
    );
  });

  it('con umbral warning, cuenta y pinta errores y avisos', () => {
    const text = formatDiagnostics(
      report([
        error(0, 0, 'roto', 'TS1'),
        error(3, 2, 'otro', 'TS2'),
        warning(5, 1, 'aviso', 'TS6133'),
      ]),
      { ...options, severity: 'warning' },
    );
    expect(text).toBe(
      [
        'Diagnostics (typescript) for src/a.ts — 2 errors, 1 warning:',
        '  1:1  error  TS1  roto',
        '  4:3  error  TS2  otro',
        '  6:2  warning  TS6133  aviso',
      ].join('\n'),
    );
  });

  it('con umbral warning y solo avisos, no nombra errores', () => {
    expect(
      formatDiagnostics(report([warning(0, 0, 'aviso')]), { ...options, severity: 'warning' }),
    ).toBe(
      ['Diagnostics (typescript) for src/a.ts — 1 warning:', '  1:1  warning  aviso'].join('\n'),
    );
  });

  it('sin nada por encima del umbral, el mensaje cambia con el umbral', () => {
    expect(formatDiagnostics(report([]), { ...options, severity: 'warning' })).toBe(
      'Diagnostics (typescript) for src/a.ts: no errors or warnings.',
    );
  });

  it('recorta a maxDiagnostics y dice cuántos quedan', () => {
    const text = formatDiagnostics(
      report([error(0, 0, 'uno'), error(1, 0, 'dos'), error(2, 0, 'tres')]),
      { ...options, maxDiagnostics: 2 },
    );
    expect(text.split('\n')).toEqual([
      'Diagnostics (typescript) for src/a.ts — 3 errors:',
      '  1:1  error  uno',
      '  2:1  error  dos',
      '  … +1 more',
    ]);
  });

  it('singular y plural', () => {
    expect(formatDiagnostics(report([error(0, 0, 'x')]), options)).toContain('— 1 error:');
    expect(formatDiagnostics(report([error(0, 0, 'x'), error(1, 0, 'y')]), options)).toContain(
      '— 2 errors:',
    );
  });

  it('el código puede ser número o faltar', () => {
    expect(formatDiagnostics(report([error(0, 0, 'msg', 2322)]), options)).toBe(
      ['Diagnostics (typescript) for src/a.ts — 1 error:', '  1:1  error  2322  msg'].join('\n'),
    );
    expect(formatDiagnostics(report([error(0, 0, 'msg')]), options)).toBe(
      ['Diagnostics (typescript) for src/a.ts — 1 error:', '  1:1  error  msg'].join('\n'),
    );
    expect(formatDiagnostics(report([error(0, 0, 'msg', { value: 'TS1' })]), options)).toContain(
      'error  TS1  msg',
    );
  });

  it('un mensaje de varias líneas cabe en una fila', () => {
    expect(
      formatDiagnostics(
        report([error(2, 2, "Cannot find name 'x'.\n  Did you mean 'y'?")]),
        options,
      ),
    ).toBe(
      [
        'Diagnostics (typescript) for src/a.ts — 1 error:',
        "  3:3  error  Cannot find name 'x'. Did you mean 'y'?",
      ].join('\n'),
    );
  });

  it('info y hint quedan fuera de cualquier umbral', () => {
    const info = { ...error(0, 0, 'nota'), severity: 3 };
    const hint = { ...error(1, 0, 'pista'), severity: 4 };
    expect(formatDiagnostics(report([info, hint]), options)).toContain('no errors.');
    expect(formatDiagnostics(report([info, hint]), { ...options, severity: 'warning' })).toContain(
      'no errors or warnings.',
    );
  });

  it('un diagnóstico sin severity se trata como error', () => {
    const { severity: _drop, ...noSeverity } = error(0, 0, 'sin severidad');
    expect(formatDiagnostics(report([noSeverity]), options)).toBe(
      ['Diagnostics (typescript) for src/a.ts — 1 error:', '  1:1  error  sin severidad'].join(
        '\n',
      ),
    );
  });

  it('usa el nombre del servidor y la ruta que le pasan', () => {
    expect(
      formatDiagnostics(report([], 'pyright'), { ...options, displayPath: 'app/main.py' }),
    ).toBe('Diagnostics (pyright) for app/main.py: no errors.');
  });
});
