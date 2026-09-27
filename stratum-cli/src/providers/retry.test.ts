import { describe, it, expect } from 'vitest';
import { streamWithRetry } from './retry.js';
import { ProviderError } from './errors.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from './base.js';

const text = (content: string): OpenAIStreamChunk => ({
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

/** Provider cuyo intento n ejecuta `script[n]`: una lista de chunks y, opcionalmente, un error al final. */
function scripted(script: Array<{ chunks?: OpenAIStreamChunk[]; error?: unknown }>): IProvider & {
  calls: number;
} {
  const p = {
    calls: 0,
    async *complete(): AsyncGenerator<OpenAIStreamChunk> {
      const step = script[Math.min(p.calls, script.length - 1)]!;
      p.calls++;
      for (const c of step.chunks ?? []) yield c;
      if (step.error) throw step.error;
    },
    async healthCheck() {
      return true;
    },
  };
  return p;
}

const req = (signal?: AbortSignal): CompletionRequest => ({
  messages: [],
  stream: true,
  model: 'm',
  signal,
});

async function collect(
  provider: IProvider,
  request = req(),
): Promise<{ contents: string[]; error?: unknown }> {
  const contents: string[] = [];
  try {
    for await (const c of streamWithRetry(provider, request, { baseDelayMs: 1 })) {
      contents.push(c.choices[0]?.delta.content ?? '');
    }
    return { contents };
  } catch (error) {
    return { contents, error };
  }
}

const transient = new ProviderError('503', 'http', true, { status: 503 });
const permanent = new ProviderError('400', 'http', false, { status: 400 });

describe('streamWithRetry', () => {
  it('reintenta un fallo transitorio antes del primer chunk', async () => {
    const p = scripted([{ error: transient }, { error: transient }, { chunks: [text('ok')] }]);
    const { contents, error } = await collect(p);
    expect(error).toBeUndefined();
    expect(contents).toEqual(['ok']);
    expect(p.calls).toBe(3);
  });

  it('no reintenta un corte a mitad: el consumidor nunca recibe la respuesta dos veces', async () => {
    const p = scripted([
      { chunks: [text('{"path":')], error: transient },
      { chunks: [text('{"path":"/tmp"}')] },
    ]);
    const { contents, error } = await collect(p);
    expect(error).toBe(transient);
    expect(contents).toEqual(['{"path":']);
    expect(p.calls).toBe(1);
  });

  it('no reintenta un error permanente (400, 401, contexto desbordado)', async () => {
    const p = scripted([{ error: permanent }, { chunks: [text('no llega')] }]);
    const { error } = await collect(p);
    expect(error).toBe(permanent);
    expect(p.calls).toBe(1);
  });

  it('agota los 4 intentos y propaga el último error', async () => {
    const p = scripted([{ error: transient }]);
    const { error } = await collect(p);
    expect(error).toBe(transient);
    expect(p.calls).toBe(4);
  });

  it('un Retry-After mayor que el tope no se espera', async () => {
    const slow = new ProviderError('429', 'http', true, { status: 429, retryAfterMs: 120_000 });
    const p = scripted([{ error: slow }, { chunks: [text('x')] }]);
    const { error } = await collect(p);
    expect(error).toBe(slow);
    expect(p.calls).toBe(1);
  });

  it('un Retry-After dentro del tope sustituye al backoff', async () => {
    const soon = new ProviderError('429', 'http', true, { status: 429, retryAfterMs: 50 });
    const p = scripted([{ error: soon }, { chunks: [text('x')] }]);
    const t0 = Date.now();
    const { error } = await collect(p);
    expect(error).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it('cancelar durante la espera del backoff corta en el acto', async () => {
    const p = scripted([{ error: transient }]);
    const ctrl = new AbortController();
    const t0 = Date.now();
    const pending = (async () => {
      try {
        for await (const _ of streamWithRetry(p, req(ctrl.signal), { baseDelayMs: 10_000 })) {
          /* nada */
        }
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    setTimeout(() => ctrl.abort(), 30);
    const error = await pending;
    expect(error).toBeDefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(p.calls).toBe(1);
  });

  it('un error que no es ProviderError se sigue reintentando (compatibilidad)', async () => {
    const p = scripted([{ error: new Error('boom') }, { chunks: [text('ok')] }]);
    const { contents } = await collect(p);
    expect(contents).toEqual(['ok']);
    expect(p.calls).toBe(2);
  });
});
