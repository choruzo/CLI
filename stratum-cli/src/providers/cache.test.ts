import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_CAPABILITIES,
  normalizeUsage,
  resolveCacheCapabilities,
  withCacheDerived,
} from './cache.js';

describe('normalizeUsage', () => {
  it('OpenAI: prompt_tokens_details.cached_tokens', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 2000,
        completion_tokens: 50,
        total_tokens: 2050,
        prompt_tokens_details: { cached_tokens: 1536 },
      }),
    ).toEqual({
      promptTokens: 2000,
      completionTokens: 50,
      totalTokens: 2050,
      cachedReadTokens: 1536,
    });
  });

  it('un backend que no reporta caché deja los campos sin definir, no en 0', () => {
    const usage = normalizeUsage({ prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 });
    expect(usage).toEqual({ promptTokens: 900, completionTokens: 10, totalTokens: 910 });
    expect(usage).not.toHaveProperty('cachedReadTokens');
    expect(usage).not.toHaveProperty('cacheWriteTokens');
    expect(withCacheDerived(usage!)).not.toHaveProperty('cacheHitRate');
  });

  it('un 0 reportado es un dato: llamada fría, acierto 0', () => {
    const usage = normalizeUsage({
      prompt_tokens: 900,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
    });
    expect(usage?.cachedReadTokens).toBe(0);
    expect(withCacheDerived(usage!)).toMatchObject({ uncachedPromptTokens: 900, cacheHitRate: 0 });
  });

  it('Anthropic a través de una pasarela: lectura y escritura, prompt_tokens ya es el total', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 5000,
        completion_tokens: 100,
        total_tokens: 5100,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 600,
      }),
    ).toMatchObject({ promptTokens: 5000, cachedReadTokens: 4000, cacheWriteTokens: 600 });
  });

  it('Anthropic nativo: input_tokens no incluye lo cacheado y se suma', () => {
    expect(
      normalizeUsage({
        input_tokens: 400,
        output_tokens: 100,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 600,
      }),
    ).toEqual({
      promptTokens: 5000,
      completionTokens: 100,
      totalTokens: 5100,
      cachedReadTokens: 4000,
      cacheWriteTokens: 600,
    });
  });

  it('una pasarela que deja prompt_tokens sin lo cacheado: el total es la suma', () => {
    expect(
      normalizeUsage({ prompt_tokens: 300, completion_tokens: 5, cache_read_input_tokens: 4000 }),
    ).toMatchObject({ promptTokens: 4300, cachedReadTokens: 4000 });
  });

  it('DeepSeek: prompt_cache_hit_tokens', () => {
    expect(
      normalizeUsage({
        prompt_tokens: 1000,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 640,
        prompt_cache_miss_tokens: 360,
      }),
    ).toMatchObject({ promptTokens: 1000, cachedReadTokens: 640 });
  });

  it('llama.cpp: lo reutilizado del KV cache sale de timings.cache_n', () => {
    expect(
      normalizeUsage(
        { prompt_tokens: 1200, completion_tokens: 30 },
        { cache_n: 1100, prompt_n: 100 },
      ),
    ).toMatchObject({ promptTokens: 1200, cachedReadTokens: 1100 });
    // Solo `timings`, sin `usage`: el prompt es lo evaluado más lo reutilizado.
    expect(normalizeUsage(undefined, { cache_n: 1100, prompt_n: 100 })).toEqual({
      promptTokens: 1200,
      cachedReadTokens: 1100,
    });
  });

  it('el usage manda sobre timings cuando trae los dos', () => {
    expect(
      normalizeUsage(
        { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 1000 } },
        { cache_n: 7 },
      )?.cachedReadTokens,
    ).toBe(1000);
  });

  it('sin nada que leer no hay usage, y los valores que no son un recuento se ignoran', () => {
    expect(normalizeUsage(undefined)).toBeUndefined();
    expect(normalizeUsage({})).toBeUndefined();
    expect(
      normalizeUsage({
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: -3 },
      }),
    ).toEqual({ promptTokens: 10 });
    expect(normalizeUsage({ prompt_tokens: 10, prompt_tokens_details: null })).toEqual({
      promptTokens: 10,
    });
  });
});

describe('withCacheDerived', () => {
  it('deriva lo no cacheado y la tasa de acierto', () => {
    expect(withCacheDerived({ promptTokens: 2000, cachedReadTokens: 1500 })).toEqual({
      promptTokens: 2000,
      cachedReadTokens: 1500,
      uncachedPromptTokens: 500,
      cacheHitRate: 0.75,
    });
  });

  it('nunca da una tasa por encima de 1 ni divide entre 0', () => {
    expect(withCacheDerived({ promptTokens: 100, cachedReadTokens: 150 }).cacheHitRate).toBe(1);
    expect(withCacheDerived({ promptTokens: 0, cachedReadTokens: 0 })).not.toHaveProperty(
      'cacheHitRate',
    );
  });
});

describe('resolveCacheCapabilities', () => {
  it('nada que cambie la petición está activo en un backend desconocido', () => {
    const caps = resolveCacheCapabilities('unknown');
    expect(caps).toMatchObject({
      explicitBreakpoints: false,
      cacheKey: false,
      sessionAffinity: false,
    });
  });

  it('solo OpenAI lleva prompt_cache_key de serie', () => {
    const withKey = Object.entries(DEFAULT_CACHE_CAPABILITIES)
      .filter(([, caps]) => caps.cacheKey)
      .map(([backend]) => backend);
    expect(withKey).toEqual(['openai']);
  });

  it('ningún backend lleva de serie breakpoints explícitos ni afinidad de sesión', () => {
    for (const caps of Object.values(DEFAULT_CACHE_CAPABILITIES)) {
      expect(caps.explicitBreakpoints).toBe(false);
      expect(caps.sessionAffinity).toBe(false);
    }
  });

  it('la config sustituye clave a clave y no toca el default', () => {
    const caps = resolveCacheCapabilities('sglang', { sessionAffinity: true });
    expect(caps.sessionAffinity).toBe(true);
    expect(caps.automaticPrefix).toBe(true);
    expect(DEFAULT_CACHE_CAPABILITIES.sglang.sessionAffinity).toBe(false);
    expect(resolveCacheCapabilities('openai', { cacheKey: false }).cacheKey).toBe(false);
  });
});
