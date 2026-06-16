import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
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
