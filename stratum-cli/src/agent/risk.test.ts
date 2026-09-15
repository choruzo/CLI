import { describe, it, expect } from 'vitest';
import {
  ChangeTracker,
  LARGE_AUTHORED_CHANGE_LINES,
  changeFromToolCall,
  classifyRisk,
  correctionBudget,
  isExcludedFromCount,
  lensesForPath,
  parseNumstat,
} from './risk.js';

describe('parseNumstat (Hito 12)', () => {
  it('parsea añadidas/borradas y marca los binarios', () => {
    const stats = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tassets/logo.png\n');
    expect(stats[0]).toEqual({ path: 'src/a.ts', added: 12, deleted: 3, binary: false });
    expect(stats[1]).toEqual({ path: 'assets/logo.png', added: 0, deleted: 0, binary: true });
  });

  it('resuelve renombrados al destino', () => {
    expect(parseNumstat('1\t1\tsrc/{old => new}/a.ts')[0]!.path).toBe('src/new/a.ts');
    expect(parseNumstat('1\t1\told.ts => new.ts')[0]!.path).toBe('new.ts');
  });

  it('ignora líneas vacías o mal formadas', () => {
    expect(parseNumstat('\nbasura\n')).toEqual([]);
  });
});

describe('exclusiones del recuento', () => {
  it('excluye binarios, generados y lockfiles', () => {
    expect(isExcludedFromCount({ path: 'x.png', added: 0, deleted: 0, binary: true })).toBe(true);
    expect(isExcludedFromCount({ path: 'testdata/golden/a.txt', added: 9, deleted: 0 })).toBe(true);
    expect(isExcludedFromCount({ path: 'dist/index.js', added: 900, deleted: 0 })).toBe(true);
    expect(isExcludedFromCount({ path: 'package-lock.json', added: 900, deleted: 0 })).toBe(true);
  });

  it('NO excluye los tests: escribirlos es trabajo autoral', () => {
    expect(isExcludedFromCount({ path: 'src/agent/risk.test.ts', added: 50, deleted: 0 })).toBe(
      false,
    );
  });
});

describe('lentes (4R)', () => {
  it('readability aplica siempre', () => {
    expect(lensesForPath('src/util.ts')).toEqual(['readability']);
  });

  it('rutas sensibles → risk', () => {
    expect(lensesForPath('src/auth/login.ts')).toContain('risk');
    expect(lensesForPath('src/tools/exec/backends/local.ts')).toContain('risk');
  });

  it('despliegue/migraciones → resilience; tests/api → reliability', () => {
    expect(lensesForPath('infra/deploy/main.tf')).toContain('resilience');
    expect(lensesForPath('src/foo.test.ts')).toContain('reliability');
  });
});

describe('classifyRisk', () => {
  it('cambio pequeño y neutro → low', () => {
    const a = classifyRisk([{ path: 'src/util.ts', added: 10, deleted: 2 }]);
    expect(a.tier).toBe('low');
    expect(a.authoredLines).toBe(12);
    expect(a.dominantLens).toBe('readability');
    expect(a.oversized).toBe(false);
  });

  it('ruta sensible → high aunque sea pequeño', () => {
    const a = classifyRisk([{ path: 'src/tools/guards.ts', added: 3, deleted: 0 }]);
    expect(a.tier).toBe('high');
    expect(a.dominantLens).toBe('risk');
  });

  it('cruzar el umbral de líneas → high y oversized', () => {
    const a = classifyRisk([
      { path: 'src/util.ts', added: LARGE_AUTHORED_CHANGE_LINES, deleted: 0 },
    ]);
    expect(a.tier).toBe('high');
    expect(a.oversized).toBe(true);
  });

  it('volumen medio → medium', () => {
    const a = classifyRisk([{ path: 'src/util.ts', added: 120, deleted: 0 }]);
    expect(a.tier).toBe('medium');
  });

  it('los ficheros excluidos no inflan el recuento', () => {
    const a = classifyRisk([
      { path: 'src/util.ts', added: 5, deleted: 0 },
      { path: 'package-lock.json', added: 5000, deleted: 4000 },
    ]);
    expect(a.tier).toBe('low');
    expect(a.files).toBe(1);
    expect(a.authoredLines).toBe(5);
  });
});

describe('correctionBudget', () => {
  it('es la mitad del cambio, con tope de 200', () => {
    expect(correctionBudget(50)).toBe(25);
    expect(correctionBudget(51)).toBe(26);
    expect(correctionBudget(1000)).toBe(200);
    expect(correctionBudget(0)).toBe(0);
  });
});

describe('changeFromToolCall', () => {
  it('write_file cuenta las líneas del contenido', () => {
    const c = changeFromToolCall('write_file', { path: 'a.ts', content: 'a\nb\nc' }, 'ok');
    expect(c).toEqual({ path: 'a.ts', added: 3, deleted: 0 });
  });

  it('edit_file cuenta el unified diff que devuelve la tool', () => {
    const output = [
      'File edited: a.ts',
      '',
      '--- a.ts',
      '+++ a.ts',
      '@@ -1,3 +1,4 @@',
      ' sin cambio',
      '-vieja',
      '+nueva',
      '+extra',
    ].join('\n');
    expect(changeFromToolCall('edit_file', { path: 'a.ts' }, output)).toEqual({
      path: 'a.ts',
      added: 2,
      deleted: 1,
    });
  });

  it('edit_file sin diff cae a los parámetros', () => {
    const c = changeFromToolCall(
      'edit_file',
      { path: 'a.ts', old_string: 'x', new_string: 'y\nz' },
      'File edited: a.ts',
    );
    expect(c).toEqual({ path: 'a.ts', added: 2, deleted: 1 });
  });

  it('las tools no mutantes no producen cambio', () => {
    expect(changeFromToolCall('read_file', { path: 'a.ts' }, 'contenido')).toBeNull();
    expect(changeFromToolCall('write_file', {}, 'ok')).toBeNull();
  });
});

describe('ChangeTracker', () => {
  it('acumula por fichero y normaliza separadores', () => {
    const t = new ChangeTracker();
    t.record('src\\a.ts', 10, 1);
    t.record('src/a.ts', 5, 0);
    expect(t.stats).toEqual([{ path: 'src/a.ts', added: 15, deleted: 1 }]);
    expect(t.authoredLines).toBe(16);
  });

  it('avisa una sola vez al cruzar el umbral', () => {
    const t = new ChangeTracker();
    t.record('src/a.ts', LARGE_AUTHORED_CHANGE_LINES, 0);
    const first = t.takeLargeChangeWarning();
    expect(first).toContain('large_change');
    expect(first).toContain('Presupuesto de corrección');
    expect(t.takeLargeChangeWarning()).toBeNull();
  });

  it('se re-arma al duplicar el umbral', () => {
    const t = new ChangeTracker();
    t.record('src/a.ts', LARGE_AUTHORED_CHANGE_LINES, 0);
    expect(t.takeLargeChangeWarning()).not.toBeNull();
    t.record('src/b.ts', LARGE_AUTHORED_CHANGE_LINES, 0);
    expect(t.takeLargeChangeWarning()).not.toBeNull();
  });

  it('por debajo del umbral no avisa', () => {
    const t = new ChangeTracker();
    t.record('src/a.ts', 100, 0);
    expect(t.takeLargeChangeWarning()).toBeNull();
  });
});
