import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProviderRouter } from './router.js';
import { clearDiscoveredModels, discoveredContextWindow, fetchModelInfos } from './utils.js';
import { DEFAULT_CONTEXT_WINDOW, StratumConfigSchema } from '../config/schema.js';
import { removeProviderEverywhere, setProviderModel } from '../config/writer.js';
import { resolveStartupModel } from '../cli/startup-model.js';
import { buildProviderEntry, discoverModels, resolveApiKey } from '../cli/ui/wizard-logic.js';

const BASE = 'https://api.example.test/v1';

function mockModels(data: unknown[], status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ data }),
  })) as unknown as typeof fetch;
}

function makeConfig(providers: Record<string, Record<string, unknown>>, def = 'hosted') {
  const full = Object.fromEntries(
    Object.entries(providers).map(([name, p]) => [
      name,
      { type: 'openai-compatible', baseUrl: BASE, apiKey: 'k', ...p },
    ]),
  );
  return StratumConfigSchema.parse({ provider: { default: def, providers: full } });
}

beforeEach(() => clearDiscoveredModels());

describe('provider solo con baseUrl + apiKey', () => {
  it('el schema lo acepta: model vacío y contextWindow sin fijar', () => {
    const config = makeConfig({ hosted: {} });
    const entry = config.provider!.providers['hosted']!;
    expect(entry.model).toBe('');
    expect(entry.contextWindow).toBeUndefined();
  });

  it('switchModel resuelve también el catálogo, del que parten los subagentes', () => {
    const config = makeConfig({ hosted: {} });
    const router = new ProviderRouter(config);
    expect(router.model).toBe('');
    router.switchModel('qwen3.6');
    expect(new ProviderRouter(config).model).toBe('qwen3.6');
  });

  it('switchModel no pisa en el catálogo un modelo ya configurado', () => {
    const config = makeConfig({ hosted: { model: 'a' } });
    new ProviderRouter(config).switchModel('b');
    expect(new ProviderRouter(config).model).toBe('a');
  });

  it('el fallback salta los providers sin modelo resuelto', () => {
    const config = makeConfig(
      { main: { model: 'm' }, unresolved: {}, spare: { model: 's' } },
      'main',
    );
    const router = new ProviderRouter(config);
    expect(router.advanceProvider()).toEqual({ name: 'spare', model: 's' });
    expect(router.advanceProvider()).toBeNull();
  });

  it('forgetProvider lo saca del listado y del fallback, salvo que sea el activo', () => {
    const config = makeConfig({ main: { model: 'm' }, spare: { model: 's' } }, 'main');
    const router = new ProviderRouter(config);
    expect(() => router.forgetProvider('main')).toThrow(/activo/);
    router.forgetProvider('spare');
    expect(router.providerNames).toEqual(['main']);
    expect(router.advanceProvider()).toBeNull();
  });
});

describe('fetchModelInfos', () => {
  it('lee la ventana de los campos conocidos y la recuerda por baseUrl', async () => {
    const fetchFn = mockModels([
      { id: 'or', context_length: 200000 },
      { id: 'vllm', max_model_len: 65536 },
      { id: 'plain' },
      { id: 'llamacpp', meta: { n_ctx_train: 131072 } },
      { id: 'bad', context_length: '8k' },
    ]);
    const infos = await fetchModelInfos(`${BASE}/`, 'k', { fetchFn });
    expect(infos).toEqual([
      { id: 'bad' },
      { id: 'llamacpp' },
      { id: 'or', contextWindow: 200000 },
      { id: 'plain' },
      { id: 'vllm', contextWindow: 65536 },
    ]);
    expect(discoveredContextWindow(BASE, 'or')).toBe(200000);
    expect(discoveredContextWindow(BASE, 'plain')).toBeUndefined();
  });
});

describe('ProviderRouter.contextWindow', () => {
  it('models.<id> > contextWindow del provider > /models > default', async () => {
    await fetchModelInfos(BASE, 'k', {
      fetchFn: mockModels([
        { id: 'a', context_length: 100000 },
        { id: 'b', context_length: 100000 },
        { id: 'c', context_length: 100000 },
      ]),
    });

    const override = makeConfig({
      hosted: { model: 'a', contextWindow: 50000, models: { a: { contextWindow: 200000 } } },
    });
    expect(new ProviderRouter(override).contextWindow).toBe(200000);

    const explicit = new ProviderRouter(
      makeConfig({ hosted: { model: 'b', contextWindow: 50000 } }),
    );
    expect(explicit.contextWindow).toBe(50000);
    expect(explicit.contextWindowIsDiscoverable).toBe(false);

    const discovered = new ProviderRouter(makeConfig({ hosted: { model: 'c' } }));
    expect(discovered.contextWindowIsDiscoverable).toBe(true);
    expect(discovered.contextWindow).toBe(100000);

    discovered.switchModel('desconocido');
    expect(discovered.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('sigue al modelo al cambiarlo con /model', () => {
    const router = new ProviderRouter(
      makeConfig({ hosted: { model: 'small', models: { big: { contextWindow: 200000 } } } }),
    );
    expect(router.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    router.switchModel('big');
    expect(router.contextWindow).toBe(200000);
  });
});

describe('resolveStartupModel (run / init)', () => {
  it('con modelo en la config no consulta el provider', async () => {
    const fetchFn = mockModels([]);
    const config = makeConfig({ hosted: { model: 'a' } });
    expect(await resolveStartupModel(config, { fetchFn })).toEqual({ ok: true, fetched: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('--model manda y no se consulta nada', async () => {
    const fetchFn = mockModels([]);
    const config = makeConfig({ hosted: { model: 'a' } });
    await resolveStartupModel(config, { fetchFn, model: ' b ' });
    expect(new ProviderRouter(config).model).toBe('b');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('adopta el único modelo que expone el provider', async () => {
    const config = makeConfig({ hosted: {} });
    const result = await resolveStartupModel(config, { fetchFn: mockModels([{ id: 'only' }]) });
    expect(result).toEqual({ ok: true, fetched: true });
    expect(new ProviderRouter(config).model).toBe('only');
  });

  it('con varios modelos no elige por el usuario: error que los lista', async () => {
    const config = makeConfig({ hosted: {} });
    const result = await resolveStartupModel(config, {
      fetchFn: mockModels([{ id: 'a' }, { id: 'b' }]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('--model');
      expect(result.error).toContain('a, b');
    }
    expect(config.provider!.providers['hosted']!.model).toBe('');
  });

  it('si /models falla, el error lo dice', async () => {
    const config = makeConfig({ hosted: {} });
    const result = await resolveStartupModel(config, { fetchFn: mockModels([], 401) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('HTTP 401');
  });

  it('respeta --provider', async () => {
    const config = makeConfig({ main: { model: 'm' }, hosted: {} }, 'main');
    const result = await resolveStartupModel(config, {
      provider: 'hosted',
      fetchFn: mockModels([{ id: 'only' }]),
    });
    expect(result.ok).toBe(true);
    expect(config.provider!.providers['hosted']!.model).toBe('only');
  });
});

describe('API key por variable de entorno en el wizard', () => {
  afterEach(() => {
    delete process.env['STRATUM_TEST_KEY'];
  });

  it('resolveApiKey expande ${VAR} e informa de las no definidas', () => {
    process.env['STRATUM_TEST_KEY'] = 'secret';
    expect(resolveApiKey('${STRATUM_TEST_KEY}')).toEqual({ key: 'secret', missing: [] });
    expect(resolveApiKey('${STRATUM_TEST_UNSET}')).toEqual({
      key: '',
      missing: ['STRATUM_TEST_UNSET'],
    });
    expect(resolveApiKey('literal')).toEqual({ key: 'literal', missing: [] });
  });

  it('discoverModels envía la key expandida, no el placeholder', async () => {
    process.env['STRATUM_TEST_KEY'] = 'secret';
    const fetchFn = mockModels([{ id: 'a' }, { id: 'b' }]);
    const discovery = await discoverModels(BASE, '${STRATUM_TEST_KEY}', fetchFn);
    expect(discovery).toEqual({ models: ['a', 'b'], manualFallback: false });
    expect(fetchFn).toHaveBeenCalledWith(
      `${BASE}/models`,
      expect.objectContaining({ headers: { Authorization: 'Bearer secret' } }),
    );
  });

  it('discoverModels no consulta con una variable sin definir', async () => {
    const fetchFn = mockModels([{ id: 'a' }]);
    const discovery = await discoverModels(BASE, '${STRATUM_TEST_UNSET}', fetchFn);
    expect(discovery.manualFallback).toBe(true);
    expect(discovery.error).toContain('STRATUM_TEST_UNSET');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('buildProviderEntry conserva el placeholder y omite lo no fijado', () => {
    expect(buildProviderEntry({ baseUrl: `${BASE}/`, apiKey: '${STRATUM_TEST_KEY}' })).toEqual({
      type: 'openai-compatible',
      baseUrl: BASE,
      apiKey: '${STRATUM_TEST_KEY}',
    });
  });
});

describe('setProviderModel', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-model-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removeProviderEverywhere quita el provider con su modelo y sus ajustes por modelo', () => {
    const path = join(dir, '.stratumrc.json');
    const entry = { type: 'openai-compatible', baseUrl: BASE, apiKey: 'k' };
    writeFileSync(
      path,
      JSON.stringify({
        provider: {
          default: 'hosted',
          providers: {
            hosted: { ...entry, model: 'a', models: { a: { contextWindow: 200000 } } },
            other: { ...entry, model: 'm' },
          },
        },
      }),
    );
    const results = removeProviderEverywhere('hosted', dir);
    expect(results.map((r) => r.configPath)).toContain(path);
    expect(results.find((r) => r.configPath === path)?.newDefault).toBe('other');
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(saved.provider).toEqual({
      default: 'other',
      providers: { other: { ...entry, model: 'm' } },
    });
    expect(() => removeProviderEverywhere('no-existe-stratum-xyz', dir)).toThrow(/no existe/);
  });

  it('fija el modelo en el fichero que define el provider, sin tocar lo demás', () => {
    const path = join(dir, '.stratumrc.json');
    writeFileSync(
      path,
      JSON.stringify({
        provider: {
          default: 'hosted',
          providers: {
            hosted: { type: 'openai-compatible', baseUrl: BASE, apiKey: '${STRATUM_TEST_KEY}' },
          },
        },
      }),
    );
    expect(setProviderModel('hosted', 'qwen3.6', dir)).toBe(path);
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(saved.provider.providers.hosted).toEqual({
      type: 'openai-compatible',
      baseUrl: BASE,
      apiKey: '${STRATUM_TEST_KEY}',
      model: 'qwen3.6',
    });
  });
});
