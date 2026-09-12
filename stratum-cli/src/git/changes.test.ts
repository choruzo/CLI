import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseNumstat,
  parsePorcelain,
  mergeChanges,
  summarize,
  formatCompact,
  formatChangesReport,
  EMPTY_SUMMARY,
  collectWorkingTreeChanges,
} from './changes.js';

describe('parseNumstat (Hito 13)', () => {
  it('cuenta añadidas y borradas por fichero', () => {
    const out = parseNumstat('12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n');
    expect(out).toEqual([
      { path: 'src/a.ts', added: 12, deleted: 3, binary: false, from: undefined },
      { path: 'src/b.ts', added: 0, deleted: 7, binary: false, from: undefined },
    ]);
  });

  it('marca los binarios en vez de contarlos como 0 líneas', () => {
    const [entry] = parseNumstat('-\t-\tassets/logo.png');
    expect(entry).toMatchObject({ path: 'assets/logo.png', binary: true, added: 0, deleted: 0 });
  });

  it('resuelve renombrados con llaves quedándose el destino', () => {
    const [entry] = parseNumstat('4\t2\tsrc/{old => new}/file.ts');
    expect(entry!.path).toBe('src/new/file.ts');
    expect(entry!.from).toBe('src/old/file.ts');
  });

  it('resuelve renombrados en forma plana', () => {
    const [entry] = parseNumstat('1\t1\told.ts => new.ts');
    expect(entry!.path).toBe('new.ts');
    expect(entry!.from).toBe('old.ts');
  });

  it('ignora líneas vacías y malformadas', () => {
    expect(parseNumstat('\n\nbasura\n')).toEqual([]);
  });
});

describe('parsePorcelain (Hito 13)', () => {
  it('clasifica los estados de XY', () => {
    const text = ' M src/a.ts\0A  src/b.ts\0?? src/c.ts\0 D src/d.ts\0';
    expect(parsePorcelain(text)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/c.ts', status: 'untracked' },
      { path: 'src/d.ts', status: 'deleted' },
    ]);
  });

  it('consume el campo extra de origen en un renombrado', () => {
    // En -z el origen va como campo propio DETRÁS del destino.
    const text = 'R  nuevo.ts\0viejo.ts\0 M otro.ts\0';
    expect(parsePorcelain(text)).toEqual([
      { path: 'nuevo.ts', status: 'renamed', from: 'viejo.ts' },
      { path: 'otro.ts', status: 'modified' },
    ]);
  });

  it('no rompe con rutas que llevan espacios o acentos', () => {
    const [entry] = parsePorcelain(' M src/mi módulo/á b.ts\0');
    expect(entry!.path).toBe('src/mi módulo/á b.ts');
  });
});

describe('mergeChanges (Hito 13)', () => {
  it('cruza líneas de numstat con estado de porcelain', () => {
    const merged = mergeChanges(
      [{ path: 'a.ts', added: 5, deleted: 1, binary: false }],
      [{ path: 'a.ts', status: 'added' }],
    );
    expect(merged).toEqual([{ path: 'a.ts', added: 5, deleted: 1, status: 'added' }]);
  });

  it('conserva los untracked, que numstat no ve', () => {
    const merged = mergeChanges([], [{ path: 'nuevo.ts', status: 'untracked' }]);
    expect(merged).toEqual([{ path: 'nuevo.ts', added: 0, deleted: 0, status: 'untracked' }]);
  });

  it('conserva lo que solo está en numstat', () => {
    const merged = mergeChanges([{ path: 'a.ts', added: 2, deleted: 0, binary: false }], []);
    expect(merged[0]).toMatchObject({ path: 'a.ts', added: 2, status: 'modified' });
  });

  it('ordena por ruta para que el panel no baile entre refrescos', () => {
    const merged = mergeChanges(
      [
        { path: 'z.ts', added: 1, deleted: 0, binary: false },
        { path: 'a.ts', added: 1, deleted: 0, binary: false },
      ],
      [],
    );
    expect(merged.map((c) => c.path)).toEqual(['a.ts', 'z.ts']);
  });
});

describe('formato (Hito 13)', () => {
  it('formatCompact suma el total del árbol', () => {
    const summary = summarize([
      { path: 'a.ts', added: 10, deleted: 2, status: 'modified' },
      { path: 'b.ts', added: 5, deleted: 0, status: 'untracked' },
    ]);
    expect(formatCompact(summary)).toBe('+15/-2');
  });

  it('formatCompact no pinta nada con el árbol limpio ni fuera de un repo', () => {
    expect(formatCompact(summarize([]))).toBe('');
    expect(formatCompact(EMPTY_SUMMARY)).toBe('');
  });

  it('el informe marca el estado de cada fichero y los binarios', () => {
    const report = formatChangesReport(
      summarize([
        { path: 'a.ts', added: 3, deleted: 1, status: 'modified' },
        { path: 'logo.png', added: 0, deleted: 0, status: 'added', binary: true },
      ]),
    );
    expect(report).toContain('M a.ts');
    expect(report).toContain('+3/-1');
    expect(report).toContain('A logo.png');
    expect(report).toContain('bin');
  });

  it('el informe distingue árbol limpio de no-repo', () => {
    expect(formatChangesReport(summarize([]))).toContain('limpio');
    expect(formatChangesReport(EMPTY_SUMMARY)).toContain('no es un repositorio git');
  });
});

// ---------------------------------------------------------------------------
// Integración contra un repo git real. Cubre los dos fallos que el parseo puro
// no puede ver: git reporta rutas relativas a la RAÍZ del repo (no al cwd) y,
// sin `-uall`, colapsa un directorio nuevo entero en una sola entrada.
// ---------------------------------------------------------------------------

describe('collectWorkingTreeChanges — repo real (Hito 13)', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'stratum-changes-'));
    await execa('git', ['init', '-q'], { cwd: repo });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execa('git', ['config', 'user.name', 'test'], { cwd: repo });
    await mkdir(join(repo, 'pkg', 'src'), { recursive: true });
    await writeFile(join(repo, 'pkg', 'tracked.txt'), 'uno\ndos\n');
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-qm', 'init'], { cwd: repo });

    await writeFile(join(repo, 'pkg', 'tracked.txt'), 'uno\ndos\ntres\n');
    await writeFile(join(repo, 'pkg', 'src', 'nuevo.txt'), 'a\nb\nc\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('cuenta las líneas de un untracked dentro de un directorio nuevo, invocado desde un subdirectorio', async () => {
    // El cwd es el subpaquete, no la raíz: es el caso que fallaba en silencio.
    const summary = await collectWorkingTreeChanges(join(repo, 'pkg'));
    expect(summary.isRepo).toBe(true);

    const nuevo = summary.changes.find((c) => c.path.endsWith('nuevo.txt'));
    expect(nuevo).toMatchObject({ status: 'untracked', added: 3, deleted: 0 });

    const tracked = summary.changes.find((c) => c.path.endsWith('tracked.txt'));
    expect(tracked).toMatchObject({ status: 'modified', added: 1, deleted: 0 });

    expect(formatCompact(summary)).toBe('+4/-0');
  });

  it('fuera de un repo devuelve isRepo false en vez de lanzar', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'stratum-norepo-'));
    try {
      const summary = await collectWorkingTreeChanges(outside);
      expect(summary.isRepo).toBe(false);
      expect(summary.files).toBe(0);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
