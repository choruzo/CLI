import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { dataUrl, feedMode, metaUrl } from './feeds.js';
import { ModeManager, RETRY_AFTER_MS, preparingMessage } from './static-feed.js';
import { fixtureZip } from './test-helpers.js';

const ML = feedMode('ml');

/** `fetch` falso: los metadatos de ArcGIS y el zip del modo; cuenta las llamadas. */
function fakeFetch(state: { modified: number; failData?: boolean; failMeta?: boolean }) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u === metaUrl(ML)) {
      if (state.failMeta) throw new Error('sin red');
      return new Response(JSON.stringify({ modified: state.modified, size: 1, name: 'x.zip' }));
    }
    if (u === dataUrl(ML)) {
      if (state.failData) return new Response('boom', { status: 500 });
      return new Response(new Uint8Array(fixtureZip('ml')));
    }
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

let dir: string;
let nowMs: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-crtm-feed-'));
  nowMs = Date.parse('2026-11-17T08:00:00Z');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function manager(f: typeof fetch, offline = false): ModeManager {
  return new ModeManager({
    mode: 'ml',
    dir,
    fetch: f,
    offline,
    now: () => new Date(nowMs),
    log: () => undefined,
  });
}

const modifiedOf = async (m: ModeManager) => {
  const ix = await m.open();
  const v = ix?.meta.feedModified ?? null;
  ix?.close();
  return v;
};

describe('renovación por modified', () => {
  it('la primera vez consulta los metadatos, descarga y construye', async () => {
    const f = fakeFetch({ modified: 1000 });
    const m = manager(f.impl);
    await m.check();
    expect(f.calls).toEqual([metaUrl(ML), dataUrl(ML)]);
    expect(await modifiedOf(m)).toBe('1000');
    // El zip temporal no queda.
    expect(readdirSync(dir).filter((x) => x.endsWith('.zip'))).toEqual([]);
  });

  it('si modified no cambió, solo consulta los metadatos (no descarga)', async () => {
    const f = fakeFetch({ modified: 1000 });
    const m = manager(f.impl);
    await m.check();
    f.calls.length = 0;
    await m.check();
    expect(f.calls).toEqual([metaUrl(ML)]);
  });

  it('si modified cambió, descarga y reconstruye', async () => {
    const f = fakeFetch({ modified: 1000 });
    const m = manager(f.impl);
    await m.check();
    f.calls.length = 0;
    const state = { modified: 2000 };
    const f2 = fakeFetch(state);
    const m2 = manager(f2.impl);
    await m2.check();
    expect(f2.calls).toEqual([metaUrl(ML), dataUrl(ML)]);
    expect(await modifiedOf(m2)).toBe('2000');
  });

  it('tras un fallo de descarga sigue con el índice anterior y reintenta a los 30 min', async () => {
    const state = { modified: 1000, failData: false };
    const f = fakeFetch(state);
    const m = manager(f.impl);
    await m.check();
    state.modified = 2000;
    state.failData = true;
    f.calls.length = 0;
    await m.check();
    // Falló: el índice viejo sigue sirviendo.
    expect(await modifiedOf(m)).toBe('1000');
    await expect(m.withIndex(() => 'ok')).resolves.toBe('ok');
    // Dentro de los 30 min no vuelve a intentarlo...
    f.calls.length = 0;
    nowMs += RETRY_AFTER_MS - 1000;
    await m.open().then((ix) => ix?.close());
    await m.idle();
    expect(f.calls).toEqual([]);
    // ...y pasados, sí.
    state.failData = false;
    nowMs += 2000;
    await m.open().then((ix) => ix?.close());
    await m.idle();
    expect(f.calls).toEqual([metaUrl(ML), dataUrl(ML)]);
    expect(await modifiedOf(m)).toBe('2000');
  });

  it('un fallo de los metadatos tampoco toca el índice que hay', async () => {
    const state = { modified: 1000, failMeta: false };
    const f = fakeFetch(state);
    const m = manager(f.impl);
    await m.check();
    state.failMeta = true;
    await m.check();
    expect(await modifiedOf(m)).toBe('1000');
  });

  it('una vez al día vuelve a comprobar los metadatos', async () => {
    const f = fakeFetch({ modified: 1000 });
    const m = manager(f.impl);
    await m.check();
    f.calls.length = 0;
    nowMs += 25 * 3600_000;
    await m.open().then((ix) => ix?.close());
    await m.idle();
    expect(f.calls).toEqual([metaUrl(ML)]);
  });
});

describe('sin índice', () => {
  it('mientras no hay, dice que está preparando los horarios', async () => {
    const f = fakeFetch({ modified: 1000 });
    const m = manager(f.impl, true);
    await expect(m.withIndex(() => 1)).rejects.toThrow(preparingMessage('ml'));
    expect(f.calls).toEqual([]);
  });

  it('si la primera descarga falla, el error lo dice', async () => {
    const f = fakeFetch({ modified: 1000, failData: true });
    const m = manager(f.impl);
    await m.check();
    const err = await m.withIndex(() => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolUserError);
    expect((err as Error).message).toContain('No he podido descargar los horarios de Metro Ligero');
  });

  it('STRATUM_CRTM_OFFLINE: nunca descarga', async () => {
    const f = fakeFetch({ modified: 1000 });
    const m = manager(f.impl, true);
    m.start();
    await m.check();
    m.stop();
    expect(f.calls).toEqual([]);
  });
});
