import { describe, it, expect, vi } from 'vitest';
import { fetchModels, classifyBackendByUrl, detectCapabilities } from './utils.js';

function mockFetchResponse(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('fetchModels', () => {
  it('devuelve los ids de modelos ordenados (Ollama mock 200 OK)', async () => {
    const fetchFn = mockFetchResponse(200, {
      data: [{ id: 'qwen2.5-coder:32b' }, { id: 'llama3.1:8b' }, { id: 'mistral:7b' }],
    });
    const models = await fetchModels('http://localhost:11434/v1', 'ollama', { fetchFn });
    expect(models).toEqual(['llama3.1:8b', 'mistral:7b', 'qwen2.5-coder:32b']);
  });

  it('deduplica ids repetidos y descarta entradas sin id', async () => {
    const fetchFn = mockFetchResponse(200, {
      data: [{ id: 'a' }, { id: 'a' }, { id: 42 }, {}, { id: 'b' }],
    });
    const models = await fetchModels('http://localhost:11434/v1', '', { fetchFn });
    expect(models).toEqual(['a', 'b']);
  });

  it('llama a {baseUrl}/models normalizando el trailing slash', async () => {
    const fetchFn = mockFetchResponse(200, { data: [] });
    await fetchModels('http://localhost:4000/v1/', 'sk-test', { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:4000/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-test' },
      }),
    );
  });

  it('no envía header Authorization si la apiKey está vacía', async () => {
    const fetchFn = mockFetchResponse(200, { data: [] });
    await fetchModels('http://localhost:8000/v1', '', { fetchFn });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:8000/v1/models',
      expect.objectContaining({ headers: {} }),
    );
  });

  it('lanza en HTTP no-OK (provider sin /models)', async () => {
    const fetchFn = mockFetchResponse(404, {});
    await expect(fetchModels('http://localhost:9999/v1', '', { fetchFn })).rejects.toThrow(
      'HTTP 404',
    );
  });

  it('lanza si la respuesta no tiene campo data', async () => {
    const fetchFn = mockFetchResponse(200, { models: ['x'] });
    await expect(fetchModels('http://localhost:9999/v1', '', { fetchFn })).rejects.toThrow(
      'no es OpenAI-compatible',
    );
  });
});

describe('classifyBackendByUrl', () => {
  it('clasifica Ollama por puerto 11434', () => {
    expect(classifyBackendByUrl('http://localhost:11434/v1')).toBe('ollama');
  });
  it('clasifica LiteLLM por puerto 4000', () => {
    expect(classifyBackendByUrl('http://localhost:4000/v1')).toBe('litellm');
  });
  it('clasifica vLLM por puerto 8000', () => {
    expect(classifyBackendByUrl('http://gpu-host:8000/v1')).toBe('vllm');
  });
  it('clasifica llama.cpp por puerto 8080', () => {
    expect(classifyBackendByUrl('http://localhost:8080/v1')).toBe('llamacpp');
  });
  it('clasifica OpenAI nativo por host', () => {
    expect(classifyBackendByUrl('https://api.openai.com/v1')).toBe('openai');
  });
  it('devuelve unknown cuando no hay pistas', () => {
    expect(classifyBackendByUrl('https://example.com/proxy/v1')).toBe('unknown');
  });
});

describe('detectCapabilities', () => {
  it('reporta listsModels=true con los modelos descubiertos', async () => {
    const fetchFn = mockFetchResponse(200, { data: [{ id: 'a' }, { id: 'b' }] });
    const caps = await detectCapabilities('http://localhost:11434/v1', 'ollama', { fetchFn });
    expect(caps).toMatchObject({ backend: 'ollama', listsModels: true, models: ['a', 'b'] });
  });

  it('no lanza ante HTTP error: listsModels=false con nota', async () => {
    const fetchFn = mockFetchResponse(404, {});
    const caps = await detectCapabilities('http://localhost:8080/v1', '', { fetchFn });
    expect(caps.listsModels).toBe(false);
    expect(caps.backend).toBe('llamacpp');
    expect(caps.note).toContain('llama.cpp');
  });

  it('listsModels=false cuando /models responde vacío', async () => {
    const fetchFn = mockFetchResponse(200, { data: [] });
    const caps = await detectCapabilities('http://gpu:8000/v1', '', { fetchFn });
    expect(caps.listsModels).toBe(false);
    expect(caps.models).toEqual([]);
  });
});
