import { describe, it, expect, vi, afterEach } from 'vitest';
import { StratumConfigSchema } from '../config/schema.js';
import { EmbeddingService } from './embeddings.js';

function configWithEndpoint() {
  return StratumConfigSchema.parse({
    memory: {
      embeddingEndpoint: { url: 'http://localhost:11434/v1/embeddings', model: 'all-minilm' },
    },
  });
}

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

describe('EmbeddingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('embedFn inyectado: normaliza L2 y reporta dimensión', async () => {
    const svc = new EmbeddingService(StratumConfigSchema.parse({}), {
      embedFn: async (texts) => texts.map(() => Float32Array.from([3, 4])),
    });
    const out = await svc.embedOne('hola');
    expect(out).not.toBeNull();
    expect(norm(Array.from(out!))).toBeCloseTo(1, 6);
    expect(svc.dimension).toBe(2);
  });

  it('usa el endpoint HTTP OpenAI-compatible y ordena por index', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const svc = new EmbeddingService(configWithEndpoint());
    const out = await svc.embed(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(out).not.toBeNull();
    // index 0 → primero
    expect(Array.from(out![0]!)).toEqual([1, 0]);
    expect(Array.from(out![1]!)).toEqual([0, 1]);
  });

  it('si el endpoint HTTP falla, no relanza y degrada (sin ONNX → null)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new EmbeddingService(configWithEndpoint());
    // Sin @xenova instalado en el entorno de test, el fallback local lanza y
    // embed() degrada a null en vez de propagar.
    const out = await svc.embedOne('x');
    expect(out).toBeNull();
  });
});
