import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addedFileDiff,
  collectFileDiff,
  diffPathProblem,
  truncateAtLine,
  type FileDiffResult,
} from './diff.js';
import { boundedChanges, summarize, type WorkingTreeChange } from './changes.js';

const LIMIT = 256 * 1024;

function ok(result: FileDiffResult) {
  if (!result.ok) throw new Error(`esperaba un diff: ${result.reason} ${result.message}`);
  return result;
}

describe('diffPathProblem (modo código)', () => {
  it('rechaza lo vacío, absoluto, con `..` o con NUL', () => {
    for (const bad of [
      '',
      '/etc/passwd',
      'C:\\x',
      'C:x',
      '\\\\srv\\c',
      '../fuera',
      'a/../../b',
      'a\\..\\b',
      'a\0b',
    ]) {
      expect(diffPathProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const good of ['a.ts', 'src/a.ts', 'dir with spaces/x.md', '..hidden/x', 'a..b']) {
      expect(diffPathProblem(good), good).toBeNull();
    }
  });
});

describe('truncateAtLine', () => {
  it('no recorta lo que cabe', () => {
    expect(truncateAtLine('a\nb\n', 100)).toEqual({ text: 'a\nb\n', truncated: false });
  });

  it('recorta tras un salto de línea, midiendo como viaja (JSON)', () => {
    const text = 'aaaa\nbbbb\ncccc\n';
    // «aaaa\n» son 6 bytes escapados: caben dos líneas en 12, no en 11.
    expect(truncateAtLine(text, 12)).toEqual({ text: 'aaaa\nbbbb\n', truncated: true });
    expect(truncateAtLine(text, 11)).toEqual({ text: 'aaaa\n', truncated: true });
    // Una línea de caracteres de control cuesta seis veces más escapada.
    const control = `${'\u0001'.repeat(10)}\n`;
    expect(truncateAtLine(control + control, 70).text).toBe(control);
  });

  it('una línea que no cabe sola no se parte', () => {
    expect(truncateAtLine('x'.repeat(50), 10)).toEqual({ text: '', truncated: true });
  });
});

describe('addedFileDiff', () => {
  it('un fichero nuevo como diff unificado', () => {
    expect(addedFileDiff('n.txt', 'a\nb\n')).toBe(
      'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n',
    );
    expect(addedFileDiff('n.txt', 'a')).toContain('+a\n\\ No newline at end of file\n');
  });
});

describe('boundedChanges', () => {
  const change = (path: string): WorkingTreeChange => ({
    path,
    added: 1,
    deleted: 0,
    status: 'modified',
  });

  it('recorta la lista y conserva los totales reales', () => {
    const summary = summarize([change('a'), change('b'), change('c')]);
    const bounded = boundedChanges(summary, { files: 2, bytes: 1024 });
    expect(bounded.changes.map((c) => c.path)).toEqual(['a', 'b']);
    expect(bounded).toMatchObject({ files: 3, added: 3, truncated: true, isRepo: true });
    expect(boundedChanges(summary, { files: 5, bytes: 1024 }).truncated).toBe(false);
  });

  it('también por bytes de rutas', () => {
    const summary = summarize([change('x'.repeat(10)), change('y'.repeat(10))]);
    expect(boundedChanges(summary, { files: 10, bytes: 15 }).changes).toHaveLength(1);
  });
});

describe('collectFileDiff — repo real', () => {
  let repo: string;
  let outside: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'stratum-diff-'));
    outside = await mkdtemp(join(tmpdir(), 'stratum-diff-fuera-'));
    await execa('git', ['init', '-q'], { cwd: repo });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execa('git', ['config', 'user.name', 'test'], { cwd: repo });
    await execa('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
    await mkdir(join(repo, 'pkg'), { recursive: true });
    await writeFile(join(repo, 'pkg', 'tracked.txt'), 'uno\ndos\n');
    await writeFile(join(repo, 'grande.txt'), 'base\n');
    await writeFile(join(repo, 'img.bin'), Buffer.from([1, 2, 3]));
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-qm', 'init'], { cwd: repo });

    await writeFile(join(repo, 'pkg', 'tracked.txt'), 'uno\ndos\ntres\n');
    await writeFile(join(repo, 'pkg', 'nuevo.txt'), 'a\nb\n');
    await writeFile(join(repo, 'img.bin'), Buffer.from([0, 1, 2, 3, 0]));
    await writeFile(join(repo, 'binario-nuevo.dat'), Buffer.from([65, 0, 66]));
    await writeFile(join(repo, 'secreto.txt'), 'token = sk-proj-abcdefghijklmnop1234567890\n');
    await writeFile(join(repo, 'extra.txt'), 'mi-clave-privada-interna\n');
    await writeFile(
      join(repo, 'grande.txt'),
      Array.from({ length: 40_000 }, (_, i) => `linea ${i}`).join('\n') + '\n',
    );
    await writeFile(join(outside, 'fuera.txt'), 'fuera\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('un fichero modificado: diff unificado frente a HEAD, desde un subdirectorio', async () => {
    const result = ok(
      await collectFileDiff(join(repo, 'pkg'), 'pkg/tracked.txt', { maxBytes: LIMIT }),
    );
    expect(result.binary).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.diff).toContain('--- a/pkg/tracked.txt');
    expect(result.diff).toContain('+tres');
  });

  it('un untracked sale entero como añadido', async () => {
    const result = ok(await collectFileDiff(repo, 'pkg/nuevo.txt', { maxBytes: LIMIT }));
    expect(result.diff).toBe(addedFileDiff('pkg/nuevo.txt', 'a\nb\n'));
  });

  it('un binario, seguido o nuevo, no trae texto', async () => {
    for (const path of ['img.bin', 'binario-nuevo.dat']) {
      expect(ok(await collectFileDiff(repo, path, { maxBytes: LIMIT }))).toEqual({
        ok: true,
        diff: '',
        truncated: false,
        binary: true,
      });
    }
  });

  it('los secretos salen redactados, también los literales de la config', async () => {
    const result = ok(await collectFileDiff(repo, 'secreto.txt', { maxBytes: LIMIT }));
    expect(result.diff).not.toContain('sk-proj-abcdefghijklmnop1234567890');
    expect(result.diff).toContain('[redacted:');
    const extra = ok(
      await collectFileDiff(repo, 'extra.txt', {
        maxBytes: LIMIT,
        extraRedactions: [{ value: 'mi-clave-privada-interna', reason: 'clave interna' }],
      }),
    );
    expect(extra.diff).not.toContain('mi-clave-privada-interna');
    expect(extra.diff).toContain('[redacted: clave interna]');
  });

  it('por encima del tope se recorta en un límite de línea', async () => {
    const result = ok(await collectFileDiff(repo, 'grande.txt', { maxBytes: 4096 }));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.diff)) - 2).toBeLessThanOrEqual(4096);
    expect(result.diff.endsWith('\n')).toBe(true);
  });

  it('una ruta con `..`, absoluta o fuera del repo es un rechazo', async () => {
    for (const path of ['../fuera.txt', 'pkg/../../x', join(outside, 'fuera.txt'), '/etc/passwd']) {
      const result = await collectFileDiff(repo, path, { maxBytes: LIMIT });
      expect(result, path).toMatchObject({ ok: false, reason: 'invalid-path' });
    }
  });

  it('un enlace que sale del repo es un rechazo (realpath)', async () => {
    const link = join(repo, 'enlace');
    try {
      await symlink(outside, link, 'junction');
    } catch {
      return; // sin permiso para crear enlaces en este sistema: nada que probar
    }
    const result = await collectFileDiff(repo, 'enlace/fuera.txt', { maxBytes: LIMIT });
    expect(result).toMatchObject({ ok: false, reason: 'invalid-path' });
    // El enlace, no lo que apunta.
    await rm(link, { force: true }).catch(() => {});
  });

  it('fuera de un repo: `not-a-repo`, sin lanzar', async () => {
    const result = await collectFileDiff(outside, 'fuera.txt', { maxBytes: LIMIT });
    expect(result).toMatchObject({ ok: false, reason: 'not-a-repo' });
  });
});
