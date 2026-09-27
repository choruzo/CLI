import { describe, it, expect, vi, afterEach } from 'vitest';
import { StratumConfigSchema } from '../config/schema.js';
import { EmbeddingService, parseEmbeddingResponse } from './embeddings.js';

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
    // Forzamos que el fallback local no esté disponible para que el resultado
    // sea determinista en cualquier entorno (con/sin @xenova instalado).
    vi.spyOn(
      svc as unknown as { embedLocal: (texts: string[]) => Promise<Float32Array[]> },
      'embedLocal',
    ).mockRejectedValue(new Error('ONNX unavailable'));
    const out = await svc.embedOne('x');
    expect(out).toBeNull();
  });
});

describe('parseEmbeddingResponse', () => {
  it('ordena por index y normaliza', () => {
    const out = parseEmbeddingResponse(
      {
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [3, 0] },
        ],
      },
      2,
    );
    expect(Array.from(out[0]!)).toEqual([1, 0]);
    expect(Array.from(out[1]!)).toEqual([0, 1]);
  });

  it('sin index respeta el orden recibido', () => {
    const out = parseEmbeddingResponse({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }, 2);
    expect(Array.from(out[1]!)).toEqual([0, 1]);
  });

  it.each([
    ['menos filas que textos', { data: [{ index: 0, embedding: [1, 0] }] }],
    [
      'índice repetido',
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      },
    ],
    [
      'índice fuera de rango',
      {
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 2, embedding: [0, 1] },
        ],
      },
    ],
    [
      'index solo en algunas filas',
      { data: [{ index: 0, embedding: [1, 0] }, { embedding: [0, 1] }] },
    ],
    ['dimensiones mezcladas', { data: [{ embedding: [1, 0] }, { embedding: [0, 1, 0] }] }],
    ['valor no numérico', { data: [{ embedding: [1, 0] }, { embedding: [0, 'x'] }] }],
    ['vector vacío', { data: [{ embedding: [1, 0] }, { embedding: [] }] }],
    ['sin data', { error: 'boom' }],
  ])('rechaza: %s', (_label, body) => {
    expect(() => parseEmbeddingResponse(body, 2)).toThrow();
  });
});

describe('EmbeddingService — respuesta HTTP inválida', () => {
  afterEach(() => vi.restoreAllMocks());

  it('una respuesta con filas de menos no se usa a medias: cae al backend local', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const svc = new EmbeddingService(configWithEndpoint());
    // El backend local no está en los tests: sin él, `null` (degradación), nunca vectores desalineados.
    vi.spyOn(
      svc as unknown as { embedLocal: () => Promise<Float32Array[]> },
      'embedLocal',
    ).mockRejectedValue(new Error('sin onnx'));
    await expect(svc.embed(['a', 'b'])).resolves.toBeNull();
    expect(String(stderr.mock.calls[0]?.[0])).toContain('1 rows for 2 inputs');
  });

  it('el cuerpo de un error se recorta y se redacta', async () => {
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwx1234567890';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`bad key ${secret} ${'x'.repeat(5000)}`, { status: 401 }),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const svc = new EmbeddingService(configWithEndpoint());
    vi.spyOn(
      svc as unknown as { embedLocal: () => Promise<Float32Array[]> },
      'embedLocal',
    ).mockRejectedValue(new Error('sin onnx'));
    await svc.embed(['a']);
    const msg = String(stderr.mock.calls[0]?.[0]);
    expect(msg).not.toContain(secret);
    expect(msg.length).toBeLessThan(700);
  });
});
