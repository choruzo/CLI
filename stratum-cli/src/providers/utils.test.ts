import { describe, it, expect, vi } from 'vitest';
import { fetchModels } from './utils.js';

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
