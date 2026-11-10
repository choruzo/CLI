import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../agent/types.js';
import { BrowserManager } from '../../browser/manager.js';
import { StratumConfigSchema } from '../../config/schema.js';
import { readOnlyVeto, READ_ONLY_SESSION_TOOLS } from '../call-policy.js';
import { callEffects } from '../environments.js';
import {
  describeCall,
  isToolVisibleForProfile,
  ToolDispatcher,
  ToolRegistry,
} from '../registry.js';
import { createBrowserTools } from './browser.js';
import { BROWSER_READ_TOOLS, BROWSER_TOOLS } from './names.js';
import { browserExecutable } from './register.js';

const FIXTURE = fileURLToPath(new URL('../../browser/fixtures/fake-browser.mjs', import.meta.url));
const config = StratumConfigSchema.parse({});

const managers: BrowserManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeBrowser(): BrowserManager {
  const cwd = mkdtempSync(join(tmpdir(), 'stratum-browser-cwd-tools-'));
  dirs.push(cwd);
  const manager = new BrowserManager({
    executable: process.execPath,
    argsPrefix: [FIXTURE],
    cwd,
    timeouts: { settleMs: 5, closeMs: 1000 },
  });
  managers.push(manager);
  return manager;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config, ...overrides };
}

function setup() {
  const registry = new ToolRegistry();
  for (const tool of createBrowserTools()) registry.register(tool);
  return { registry, dispatcher: new ToolDispatcher(registry) };
}

const tool = (name: string) => createBrowserTools().find((t) => t.name === name)!;

describe('tools browser_*', () => {
  it('se crean todas, con los nombres de BROWSER_TOOLS y en su orden', () => {
    expect(createBrowserTools().map((t) => t.name)).toEqual(BROWSER_TOOLS);
    // Una sola pestaña: ninguna va en paralelo con otra.
    expect(createBrowserTools().every((t) => t.serialized === true)).toBe(true);
  });

  it('sin navegador en la sesión, todas se vetan en preflight', () => {
    for (const t of createBrowserTools()) {
      const veto = t.preflight?.({ url: 'http://localhost/' }, makeCtx());
      expect(veto, t.name).toMatchObject({ ok: false });
    }
  });

  it('una URL vetada se para en preflight, y ninguna aprobación la levanta', async () => {
    const browser = fakeBrowser();
    const { dispatcher } = setup();
    const confirm = vi.fn(async () => 'approve' as const);
    for (const url of [
      'http://169.254.169.254/',
      'chrome://settings',
      'file:///etc/passwd',
      'http://u:p@localhost/',
    ]) {
      const [res] = await dispatcher.dispatch(
        [{ id: 'c1', name: 'browser_navigate', input: { url } }],
        makeCtx({ browser, confirmDestructive: confirm, destructivePolicy: 'allow' }),
      );
      expect(res!.result.ok, url).toBe(false);
      if (!res!.result.ok) expect(res!.result.blocked).toBeDefined();
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(browser.state).toBe('closed');
  });

  it('isDestructive solo para lo externo', () => {
    const browser = fakeBrowser();
    const nav = tool('browser_navigate');
    const ctx = makeCtx({ browser });
    expect(nav.isDestructive?.({ url: 'http://localhost:5173/' }, ctx)).toBe(false);
    expect(nav.isDestructive?.({ url: 'about:blank' }, ctx)).toBe(false);
    expect(nav.isDestructive?.({ url: 'https://example.com/' }, ctx)).toBe(true);
    expect(nav.isDestructive?.({ url: 'http://192.168.1.4/' }, ctx)).toBe(true);
    expect(nav.isDestructive?.({ url: 'http://169.254.169.254/' }, ctx)).toBe(false);
    browser.approveOrigin('https://example.com');
    expect(nav.isDestructive?.({ url: 'https://example.com/otra' }, ctx)).toBe(false);
  });

  it('lo local se abre sin preguntar; lo externo pregunta con la URL entera y, aprobado, su origen queda aprobado', async () => {
    const browser = fakeBrowser();
    const { dispatcher } = setup();
    const confirm = vi.fn(async () => 'approve' as const);
    const ctx = makeCtx({ browser, confirmDestructive: confirm, destructivePolicy: 'ask' });

    const [local] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'browser_navigate', input: { url: 'http://localhost:3000/' } }],
      ctx,
    );
    expect(local!.result).toMatchObject({ ok: true });
    if (local!.result.ok) {
      expect(local!.result.output).toContain('Navigated to http://localhost:3000/');
      expect(local!.result.output).toContain('[e1] button "OK"');
    }
    expect(confirm).not.toHaveBeenCalled();

    const long = `https://example.com/docs?q=${'x'.repeat(300)}`;
    const [external] = await dispatcher.dispatch(
      [{ id: 'c2', name: 'browser_navigate', input: { url: long } }],
      ctx,
    );
    expect(external!.result).toMatchObject({ ok: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    const request = (confirm.mock.calls[0] as unknown as [{ description: string }])[0];
    expect(request.description).toContain(long);
    expect(browser.approvedOrigins.has('https://example.com')).toBe(true);

    // Ya aprobado: no vuelve a preguntar.
    await dispatcher.dispatch(
      [{ id: 'c3', name: 'browser_navigate', input: { url: 'https://example.com/b' } }],
      ctx,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('denegada la confirmación, ni se navega ni se aprueba el origen', async () => {
    const browser = fakeBrowser();
    const { dispatcher } = setup();
    const [res] = await dispatcher.dispatch(
      [{ id: 'c1', name: 'browser_navigate', input: { url: 'https://example.com/' } }],
      makeCtx({ browser, confirmDestructive: async () => 'deny', destructivePolicy: 'ask' }),
    );
    expect(res!.result.ok).toBe(false);
    expect(browser.approvedOrigins.size).toBe(0);
    expect(browser.state).toBe('closed');
  });

  it('browser_screenshot se veta sin visión y, con ella, devuelve la imagen aparte', async () => {
    const browser = fakeBrowser();
    const shot = tool('browser_screenshot');
    expect(shot.preflight?.({}, makeCtx({ browser }))).toMatchObject({ ok: false });
    const ctx = makeCtx({ browser, vision: { coordinates: 'pixels' } });
    expect(shot.preflight?.({}, ctx)).toBeNull();
    const res = await shot.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.image?.mime).toBe('image/png');
      expect(res.output).not.toContain(res.image!.data);
    }
  });

  it('un fallo del navegador es un error de la tool, recuperable', async () => {
    const browser = fakeBrowser();
    await browser.dispose();
    const res = await tool('browser_snapshot').execute({}, makeCtx({ browser }));
    expect(res).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
  });

  it('una referencia que ya no está se explica', async () => {
    const browser = fakeBrowser();
    const res = await tool('browser_click').execute({ ref: 'e77' }, makeCtx({ browser }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/browser_snapshot/);
  });

  it('la consola se lee y se vacía', async () => {
    const browser = fakeBrowser();
    const res = await tool('browser_console').execute({}, makeCtx({ browser }));
    expect(res).toEqual({ ok: true, output: 'No new console messages.' });
  });
});

describe('efectos y modo read-only', () => {
  it('mirar no muta; pulsar, escribir, teclear y evaluar sí', () => {
    for (const name of BROWSER_TOOLS) {
      const effects = callEffects(name, {});
      expect(effects.known, name).toBe(true);
      expect(effects.targets, name).toEqual([]);
      expect(effects.mutating, name).toBe(!BROWSER_READ_TOOLS.includes(name));
    }
  });

  it('read-only veta click/type/press/eval y deja navigate/snapshot/console', () => {
    const ctx = { readOnly: true, config };
    for (const name of ['browser_click', 'browser_type', 'browser_press', 'browser_eval']) {
      expect(readOnlyVeto(name, {}, ctx), name).toMatchObject({ ok: false });
      expect(READ_ONLY_SESSION_TOOLS).not.toContain(name);
    }
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_console']) {
      expect(readOnlyVeto(name, { url: 'http://localhost/' }, ctx), name).toBeNull();
      expect(READ_ONLY_SESSION_TOOLS).toContain(name);
    }
  });

  it('un subagente no ve las tools del navegador', () => {
    for (const name of BROWSER_TOOLS) {
      expect(isToolVisibleForProfile(name, { isSubagent: true }), name).toBe(false);
      expect(isToolVisibleForProfile(name, { allowedTools: null }), name).toBe(true);
    }
  });

  it('la solicitud de confirmación lleva la URL entera', () => {
    const url = `https://example.com/${'a'.repeat(500)}`;
    expect(describeCall({ id: 'c', name: 'browser_navigate', input: { url } })).toBe(
      `browser_navigate: ${url}`,
    );
  });

  it('sin navegador habilitado o con STRATUM_NO_BROWSER no hay ejecutable', () => {
    const off = StratumConfigSchema.parse({ tools: { browser: { enabled: false } } });
    expect(browserExecutable(off, {})).toBeNull();
    const custom = StratumConfigSchema.parse({
      tools: { browser: { executable: process.execPath } },
    });
    expect(browserExecutable(custom, {})).toBe(process.execPath);
    expect(browserExecutable(custom, { STRATUM_NO_BROWSER: '1' })).toBeNull();
  });
});
