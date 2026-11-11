import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { INDEX_FILE } from './index-build.js';
import { RenfeIndex } from './queries.js';
import { IndexManager, PREPARING_MESSAGE, renfeCacheDir } from './static-feed.js';
import { buildFixtureIndex, fixtureZip } from './test-helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-feed-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = new Date('2026-11-11T17:36:00Z');

function zipFetch(opts: { lastModified?: string; calls?: { n: number } } = {}): typeof fetch {
  return (async () => {
    if (opts.calls) opts.calls.n++;
    const headers: Record<string, string> = {};
    if (opts.lastModified) headers['last-modified'] = opts.lastModified;
    return new Response(new Uint8Array(fixtureZip()), { status: 200, headers });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  throw new Error('certificate has expired');
}) as typeof fetch;

describe('renfeCacheDir', () => {
  it('usa STRATUM_CONNECTOR_CACHE y, si no, ~/.cache/stratum/connectors', () => {
    const prev = process.env.STRATUM_CONNECTOR_CACHE;
    try {
      process.env.STRATUM_CONNECTOR_CACHE = join(tmp, 'c');
      expect(renfeCacheDir()).toBe(join(tmp, 'c', 'renfe'));
      delete process.env.STRATUM_CONNECTOR_CACHE;
      expect(renfeCacheDir().replace(/\\/g, '/')).toMatch(/\.cache\/stratum\/connectors\/renfe$/);
    } finally {
      if (prev === undefined) delete process.env.STRATUM_CONNECTOR_CACHE;
      else process.env.STRATUM_CONNECTOR_CACHE = prev;
    }
  });
});

describe('IndexManager', () => {
  it('sin índice: las tools dicen que se están preparando los horarios', async () => {
    const m = new IndexManager({ dir: tmp, fetch: failingFetch, offline: true, now: () => NOW });
    m.start();
    await expect(m.withIndex(() => 1)).rejects.toThrow(PREPARING_MESSAGE);
    await expect(m.withIndex(() => 1)).rejects.toBeInstanceOf(ToolUserError);
    expect(PREPARING_MESSAGE).toBe(
      'Estoy preparando los horarios de Renfe por primera vez (tarda alrededor de un minuto). Vuelve a intentarlo en un momento.',
    );
  });

  it('descarga, construye el índice en segundo plano y luego responde; la fecha de los datos sale de Last-Modified', async () => {
    const calls = { n: 0 };
    const m = new IndexManager({
      dir: tmp,
      fetch: zipFetch({ lastModified: 'Wed, 11 Nov 2026 03:08:00 GMT', calls }),
      now: () => NOW,
      log: () => undefined,
    });
    m.start();
    // Mientras se construye, la tool responde «preparando».
    await expect(m.withIndex(() => 1)).rejects.toThrow(/preparando/);
    await m.rebuild(); // espera a la construcción en curso (una sola a la vez)
    expect(calls.n).toBe(1);
    const date = await m.withIndex((ix) => ix.meta.feedDate);
    expect(date).toBe('20261111');
    expect(readdirSync(tmp).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('con un índice de hoy no vuelve a descargar', async () => {
    await buildFixtureIndex(tmp);
    // buildFixtureIndex marca built_at = 2026-11-11T17:00Z (hoy a las 18:00 en Madrid).
    const calls = { n: 0 };
    const m = new IndexManager({
      dir: tmp,
      fetch: zipFetch({ calls }),
      now: () => NOW,
      log: () => undefined,
    });
    m.start();
    await m.withIndex((ix) => ix.meta.feedDate);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.n).toBe(0);
  });

  it('con un índice de otro día lo renueva en segundo plano y mientras usa el viejo', async () => {
    await buildFixtureIndex(tmp);
    const calls = { n: 0 };
    const tomorrow = new Date('2026-11-12T10:00:00Z');
    const m = new IndexManager({
      dir: tmp,
      fetch: zipFetch({ calls }),
      now: () => tomorrow,
      log: () => undefined,
    });
    m.start();
    // El viejo sigue sirviendo mientras se reconstruye.
    expect(await m.withIndex((ix) => ix.meta.feedDate)).toBe('20261111');
    await m.rebuild();
    expect(calls.n).toBeGreaterThanOrEqual(1);
    const builtAt = await m.withIndex((ix) => ix.meta.builtAt);
    expect(builtAt.startsWith('2026-11-12')).toBe(true);
  });

  it('una sola reconstrucción a la vez', async () => {
    const calls = { n: 0 };
    const m = new IndexManager({
      dir: tmp,
      fetch: zipFetch({ calls }),
      now: () => NOW,
      log: () => undefined,
    });
    await Promise.all([m.rebuild(), m.rebuild(), m.rebuild()]);
    expect(calls.n).toBe(1);
  });

  it('si la descarga falla (TLS u otra cosa) se sigue con el último índice bueno', async () => {
    await buildFixtureIndex(tmp);
    const logs: string[] = [];
    const tomorrow = new Date('2026-11-12T10:00:00Z');
    const m = new IndexManager({
      dir: tmp,
      fetch: failingFetch,
      now: () => tomorrow,
      log: (x) => logs.push(x),
    });
    await m.rebuild();
    expect(logs.join('\n')).toContain('certificate has expired');
    // El índice viejo sigue ahí, intacto, y las salidas dicen su fecha.
    expect(await m.withIndex((ix) => ix.meta.feedDate)).toBe('20261111');
    expect(readdirSync(tmp).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });

  it('si falla la primera descarga, las tools lo dicen con el motivo', async () => {
    const m = new IndexManager({
      dir: tmp,
      fetch: failingFetch,
      now: () => NOW,
      log: () => undefined,
    });
    await m.rebuild();
    await expect(m.withIndex(() => 1)).rejects.toThrow(/certificate has expired/);
    expect(existsSync(join(tmp, INDEX_FILE))).toBe(false);
  });

  it('un HTTP de error cuenta como fallo y no deja restos', async () => {
    const m = new IndexManager({
      dir: tmp,
      fetch: (async () => new Response('no', { status: 503 })) as typeof fetch,
      now: () => NOW,
      log: () => undefined,
    });
    await m.rebuild();
    await expect(m.withIndex(() => 1)).rejects.toThrow(/HTTP 503/);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('el índice de otra versión de esquema se ignora', async () => {
    const p = await buildFixtureIndex(tmp);
    const { loadSqlite } = await import('./sqlite.js');
    const { DatabaseSync } = await loadSqlite();
    const db = new DatabaseSync(p);
    db.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    db.close();
    expect(await RenfeIndex.open(p)).toBeNull();
  });
});
