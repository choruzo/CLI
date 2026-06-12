import { describe, it, expect, vi } from 'vitest';
import {
  PROVIDER_TYPE_PRESETS,
  validateAlias,
  validateBaseUrl,
  discoverModels,
  buildProviderEntry,
} from './wizard-logic.js';

function mockFetchResponse(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('PROVIDER_TYPE_PRESETS', () => {
  it('cubre los cinco tipos del wizard (Hito 3.5)', () => {
    expect(PROVIDER_TYPE_PRESETS.map((p) => p.id)).toEqual([
      'ollama',
      'litellm',
      'openai',
      'vllm',
      'other',
    ]);
  });

  it('Ollama no requiere API key y trae default razonable', () => {
    const ollama = PROVIDER_TYPE_PRESETS.find((p) => p.id === 'ollama')!;
    expect(ollama.requiresApiKey).toBe(false);
    expect(ollama.defaultBaseUrl).toBe('http://localhost:11434/v1');
    expect(ollama.defaultApiKey).toBe('ollama');
  });
});

describe('validateAlias', () => {
  it('acepta alias válidos', () => {
    expect(validateAlias('mi-ollama', [])).toBeNull();
    expect(validateAlias('litellm_prod2', ['otro'])).toBeNull();
  });

  it('rechaza vacío, caracteres inválidos y colisiones', () => {
    expect(validateAlias('', [])).toMatch(/vacío/);
    expect(validateAlias('con espacios', [])).toMatch(/Solo letras/);
    expect(validateAlias('existente', ['existente'])).toMatch(/Ya existe/);
  });

  it('permite colisión en modo edición (allowExisting)', () => {
    expect(validateAlias('existente', ['existente'], true)).toBeNull();
  });
});

describe('validateBaseUrl', () => {
  it('acepta URLs válidas y rechaza inválidas', () => {
    expect(validateBaseUrl('http://localhost:11434/v1')).toBeNull();
    expect(validateBaseUrl('')).toMatch(/vacía/);
    expect(validateBaseUrl('localhost sin esquema')).toMatch(/inválida/i);
  });
});

describe('discoverModels (paso 5 del wizard)', () => {
  it('wizard con Ollama mock (200 OK): devuelve modelos sin fallback', async () => {
    const fetchFn = mockFetchResponse(200, {
      data: [{ id: 'qwen2.5-coder:32b' }, { id: 'llama3.1:8b' }],
    });
    const result = await discoverModels('http://localhost:11434/v1', 'ollama', fetchFn);
    expect(result.manualFallback).toBe(false);
    expect(result.models).toEqual(['llama3.1:8b', 'qwen2.5-coder:32b']);
  });

  it('wizard con provider sin /models: activa el fallback manual sin lanzar', async () => {
    const fetchFn = mockFetchResponse(404, {});
    const result = await discoverModels('http://localhost:8080/v1', '', fetchFn);
    expect(result.manualFallback).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.error).toContain('404');
  });

  it('lista vacía de modelos también cae a entrada manual', async () => {
    const fetchFn = mockFetchResponse(200, { data: [] });
    const result = await discoverModels('http://localhost:8080/v1', '', fetchFn);
    expect(result.manualFallback).toBe(true);
  });
});

describe('buildProviderEntry', () => {
  it('normaliza URL y aplica contextWindow por defecto', () => {
    const entry = buildProviderEntry({
      baseUrl: ' http://localhost:11434/v1/ ',
      apiKey: 'ollama',
      model: ' qwen2.5-coder:32b ',
    });
    expect(entry).toEqual({
      type: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:32b',
      apiKey: 'ollama',
      contextWindow: 32768,
    });
  });

  it('respeta el contextWindow existente en modo edición', () => {
    const entry = buildProviderEntry({
      baseUrl: 'http://x/v1',
      apiKey: '',
      model: 'm',
      contextWindow: 200000,
    });
    expect(entry.contextWindow).toBe(200000);
  });
});
