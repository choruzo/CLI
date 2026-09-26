import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { VectorStore, BruteForceBackend } from './vectors.js';

function v(...nums: number[]): Float32Array {
  return Float32Array.from(nums);
}

describe('BruteForceBackend', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-vec-'));
    file = join(dir, 'vectors.fallback.json');
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('add / count / has', () => {
    const b = new BruteForceBackend(file);
    b.add('a', v(1, 0, 0));
    b.add('b', v(0, 1, 0));
    expect(b.count()).toBe(2);
    expect(b.has('a')).toBe(true);
    expect(b.has('z')).toBe(false);
  });

  it('search devuelve por similitud coseno descendente', () => {
    const b = new BruteForceBackend(file);
    b.add('x', v(1, 0, 0));
    b.add('y', v(0.9, 0.1, 0));
    b.add('z', v(0, 0, 1));
    const res = b.search(v(1, 0, 0), 2);
    expect(res.map((r) => r.ref)).toEqual(['x', 'y']);
    expect(res[0]!.score).toBeCloseTo(1, 5);
  });

  it('remove y persistencia en disco', () => {
    const b = new BruteForceBackend(file);
    b.add('a', v(1, 0, 0));
    b.add('b', v(0, 1, 0));
    b.remove('a');
    expect(b.has('a')).toBe(false);
    // Releer desde disco con una instancia nueva
    const b2 = new BruteForceBackend(file);
    expect(b2.count()).toBe(1);
    expect(b2.has('b')).toBe(true);
  });

  it('rebuild reemplaza todo el índice', () => {
    const b = new BruteForceBackend(file);
    b.add('a', v(1, 0, 0));
    b.rebuild([
      { ref: 'p', vec: v(1, 0, 0) },
      { ref: 'q', vec: v(0, 1, 0) },
    ]);
    expect(b.count()).toBe(2);
    expect(b.has('a')).toBe(false);
  });

  it('un sidecar dañado empieza vacío y la siguiente escritura lo deja válido', () => {
    writeFileSync(file, '{"entries": [{"ref": "a", "vec": [1,', 'utf-8');
    const b = new BruteForceBackend(file);
    expect(b.count()).toBe(0);
    b.add('b', v(0, 1, 0));
    expect(new BruteForceBackend(file).has('b')).toBe(true);
  });

  it('descarta entradas con forma inválida o de otra dimensión', () => {
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          { ref: 'ok', vec: [1, 0, 0] },
          { ref: 'dim', vec: [1, 0] },
          { ref: 'nan', vec: [1, 'x', 0] },
          { vec: [1, 0, 0] },
          'basura',
        ],
      }),
    );
    const b = new BruteForceBackend(file, 3);
    expect(b.count()).toBe(1);
    expect(b.has('ok')).toBe(true);
  });

  it('dos instancias sobre el mismo fichero no se pisan', () => {
    const a = new BruteForceBackend(file);
    const b = new BruteForceBackend(file);
    a.add('x', v(1, 0, 0));
    b.add('y', v(0, 1, 0));
    expect(new BruteForceBackend(file).count()).toBe(2);
    // `a` ve lo que escribió `b` sin recrearse, también un borrado.
    expect(a.search(v(0, 1, 0), 1)[0]?.ref).toBe('y');
    b.remove('x');
    expect(a.has('x')).toBe(false);
  });
});

describe('VectorStore (forceFallback)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-vs-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  function store() {
    return new VectorStore({
      dbPath: join(dir, 'vectors.db'),
      fallbackPath: join(dir, 'vectors.fallback.json'),
      dimension: 3,
      forceFallback: true,
    });
  }

  it('usa el backend brute-force', async () => {
    expect(await store().backendName()).toBe('brute-force');
  });

  it('add + search + findSimilar', async () => {
    const s = store();
    await s.add('a', v(1, 0, 0));
    await s.add('b', v(0, 1, 0));
    const res = await s.search(v(0.95, 0.05, 0), 1);
    expect(res[0]!.ref).toBe('a');

    expect(await s.findSimilar(v(1, 0, 0), 0.99)).toBe('a');
    expect(await s.findSimilar(v(0, 0, 1), 0.99)).toBeNull();
  });
});

describe('VectorStore (sqlite-vec)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-vecdb-'));
  });
  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('recrea la tabla si cambia la dimensión de los embeddings', async () => {
    const opts = { dbPath: join(dir, 'v.db'), fallbackPath: join(dir, 'v.fallback.json') };
    const first = new VectorStore({ ...opts, dimension: 3 });
    if ((await first.backendName()) !== 'sqlite-vec') return; // deps nativas ausentes
    await first.add('a', v(1, 0, 0));
    expect(await first.count()).toBe(1);
    await first.close();

    const second = new VectorStore({ ...opts, dimension: 4 });
    expect(await second.backendName()).toBe('sqlite-vec');
    expect(await second.count()).toBe(0);
    await second.add('b', v(0, 1, 0, 0));
    expect(await second.has('b')).toBe(true);
    expect((await second.search(v(0, 1, 0, 0), 1))[0]?.ref).toBe('b');
    await second.close();
  });
});
