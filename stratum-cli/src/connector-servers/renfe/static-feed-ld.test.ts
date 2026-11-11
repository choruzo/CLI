/**
 * Gestores del índice de larga distancia y de Cercanías en el mismo directorio:
 * cada uno con su ciclo de vida, y un fallo de uno no toca al otro.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { INDEX_FILE } from './index-build.js';
import { LD_INDEX_FILE } from './index-ld-build.js';
import {
  IndexManager,
  LD_STATIC_URL,
  LdIndexManager,
  PREPARING_LD_MESSAGE,
  PREPARING_MESSAGE,
  STATIC_URL,
} from './static-feed.js';
import { fixtureZip, ldFixtureZip } from './test-helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'renfe-feed-ld-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = new Date('2026-11-11T17:36:00Z');

/** Un `fetch` que sirve cada zip en su URL y falla en la que se le diga. */
function feedFetch(opts: { failLd?: boolean; failCercanias?: boolean; urls?: string[] } = {}) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    opts.urls?.push(url);
    if (url === LD_STATIC_URL) {
      if (opts.failLd) throw new Error('certificate has expired');
      return new Response(new Uint8Array(ldFixtureZip()), {
        status: 200,
        headers: { 'last-modified': 'Wed, 11 Nov 2026 00:03:00 GMT' },
      });
    }
    if (url === STATIC_URL) {
      if (opts.failCercanias) return new Response('no', { status: 500 });
      return new Response(new Uint8Array(fixtureZip()), { status: 200 });
    }
    return new Response('no', { status: 404 });
  }) as typeof fetch;
}

const mk = (f: typeof fetch) => ({
  cercanias: new IndexManager({ dir: tmp, fetch: f, now: () => NOW, log: () => undefined }),
  ld: new LdIndexManager({ dir: tmp, fetch: f, now: () => NOW, log: () => undefined }),
});

describe('LdIndexManager', () => {
  it('sin índice (y sin red): las tools dicen que se están preparando los horarios de larga distancia', async () => {
    const m = new LdIndexManager({ dir: tmp, fetch: feedFetch(), offline: true, now: () => NOW });
    m.start();
    await expect(m.withIndex(() => 1)).rejects.toThrow(PREPARING_LD_MESSAGE);
    await expect(m.withIndex(() => 1)).rejects.toBeInstanceOf(ToolUserError);
    expect(PREPARING_LD_MESSAGE).not.toBe(PREPARING_MESSAGE);
  });

  it('descarga el zip de larga distancia, construye index-ld.db y la fecha sale de Last-Modified', async () => {
    const urls: string[] = [];
    const { ld } = mk(feedFetch({ urls }));
    await ld.rebuild();
    expect(urls).toEqual([LD_STATIC_URL]);
    expect(existsSync(join(tmp, LD_INDEX_FILE))).toBe(true);
    expect(existsSync(join(tmp, INDEX_FILE))).toBe(false);
    const meta = await ld.withIndex((ix) => ix.meta);
    expect(meta.feedDate).toBe('20261111');
    expect(meta.sourceUrl).toBe(LD_STATIC_URL);
    // Sin restos: ni zip ni temporales.
    expect(readdirSync(tmp)).toEqual([LD_INDEX_FILE]);
  });

  it('un fallo de descarga sin índice previo lo dice, con el motivo', async () => {
    const { ld } = mk(feedFetch({ failLd: true }));
    await ld.rebuild();
    await expect(ld.withIndex(() => 1)).rejects.toThrow(/certificate has expired/);
  });

  it('un fallo posterior deja el último índice bueno', async () => {
    const good = mk(feedFetch()).ld;
    await good.rebuild();
    const bad = mk(feedFetch({ failLd: true })).ld;
    await bad.rebuild();
    expect(await bad.withIndex((ix) => ix.meta.feedDate)).toBe('20261111');
  });
});

describe('Cercanías y larga distancia, independientes', () => {
  it('se reconstruyen a la vez en el mismo directorio sin pisarse', async () => {
    const { cercanias, ld } = mk(feedFetch());
    await Promise.all([cercanias.rebuild(), ld.rebuild()]);
    expect(readdirSync(tmp).sort()).toEqual([INDEX_FILE, LD_INDEX_FILE].sort());
    expect(await cercanias.withIndex((ix) => ix.nucleos().length)).toBeGreaterThan(0);
    expect(await ld.withIndex((ix) => ix.products().length)).toBeGreaterThan(0);
  });

  it('si falla larga distancia, Cercanías sigue funcionando', async () => {
    const { cercanias, ld } = mk(feedFetch({ failLd: true }));
    await Promise.all([cercanias.rebuild(), ld.rebuild()]);
    expect(await cercanias.withIndex((ix) => ix.nucleos().length)).toBeGreaterThan(0);
    await expect(ld.withIndex(() => 1)).rejects.toBeInstanceOf(ToolUserError);
    expect(existsSync(join(tmp, LD_INDEX_FILE))).toBe(false);
  });

  it('si falla Cercanías, larga distancia sigue funcionando', async () => {
    const { cercanias, ld } = mk(feedFetch({ failCercanias: true }));
    await Promise.all([cercanias.rebuild(), ld.rebuild()]);
    expect(await ld.withIndex((ix) => ix.products())).toEqual(['ALVIA', 'AVE', 'AVLO']);
    await expect(cercanias.withIndex(() => 1)).rejects.toBeInstanceOf(ToolUserError);
    expect(existsSync(join(tmp, INDEX_FILE))).toBe(false);
  });
});
