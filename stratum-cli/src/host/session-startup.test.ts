import { describe, expect, it, vi } from 'vitest';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { resolveSessionStartup } from './session-startup.js';

/** Dos providers: `nan` (el default) y `otro`, con su modelo fijado. */
function config(): StratumConfig {
  const entry = (model: string) => ({
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-secreto',
    model,
    contextWindow: 32768,
  });
  return StratumConfigSchema.parse({
    provider: { default: 'nan', providers: { nan: entry('glm'), otro: entry('otro-modelo') } },
  });
}

const models = (...ids: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) })));

const base = { cwd: process.cwd(), contextWindowTimeoutMs: 0 };

describe('resolveSessionStartup — restoring', () => {
  it('un provider que ya no existe: monta con el default y lo dice', async () => {
    const r = await resolveSessionStartup({
      ...base,
      config: config(),
      provider: 'ollama',
      model: 'llama',
      restoring: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fallback).toEqual({
      reason: 'provider-missing',
      saved: { provider: 'ollama', model: 'llama' },
      using: { provider: 'nan', model: 'glm' },
    });
    expect(r.router.providerName).toBe('nan');
  });

  it('el mismo caso sin restoring falla en el provider, como siempre', async () => {
    const r = await resolveSessionStartup({
      ...base,
      config: config(),
      provider: 'ollama',
      model: 'llama',
    });
    expect(r).toMatchObject({ ok: false, stage: 'provider' });
  });

  it('un modelo que /models no lista: se descarta y se usa el del provider', async () => {
    const fetchFn = models('glm', 'otro');
    const r = await resolveSessionStartup({
      ...base,
      config: config(),
      provider: 'nan',
      model: 'viejo',
      restoring: true,
      fetchFn,
    });
    expect(r.ok && r.fallback).toEqual({
      reason: 'model-missing',
      saved: { provider: 'nan', model: 'viejo' },
      using: { provider: 'nan', model: 'glm' },
    });
  });

  it('un modelo que /models sí lista: se conserva y no hay aviso', async () => {
    const r = await resolveSessionStartup({
      ...base,
      config: config(),
      provider: 'nan',
      model: 'viejo',
      restoring: true,
      fetchFn: models('glm', 'viejo'),
    });
    expect(r.ok && r.fallback).toBeUndefined();
    expect(r.ok && r.router.model).toBe('viejo');
  });

  it('si /models falla o viene vacío se conserva el guardado (no se sabe)', async () => {
    for (const fetchFn of [
      vi.fn(async () => {
        throw new Error('caído');
      }),
      models(),
    ]) {
      const r = await resolveSessionStartup({
        ...base,
        config: config(),
        provider: 'nan',
        model: 'viejo',
        restoring: true,
        fetchFn,
      });
      expect(r.ok && r.fallback).toBeUndefined();
      expect(r.ok && r.router.model).toBe('viejo');
    }
  });

  it('un modelo igual al de la config no consulta /models', async () => {
    const fetchFn = models();
    const r = await resolveSessionStartup({
      ...base,
      config: config(),
      provider: 'otro',
      model: 'otro-modelo',
      restoring: true,
      fetchFn,
    });
    expect(r.ok && r.fallback).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('si el arranque por defecto también falla, devuelve ese fallo sin fallback', async () => {
    const r = await resolveSessionStartup({
      ...base,
      config: config(),
      provider: 'ollama',
      model: 'llama',
      restoring: true,
      makeRouter: () => {
        throw new Error('sin default');
      },
    });
    expect(r).toMatchObject({ ok: false, stage: 'provider' });
    expect('fallback' in r).toBe(false);
  });
});
