/**
 * Compresión de contexto (`ContextManager`, §12.4). Los bloques 1–3 se
 * escribieron antes del arreglo y reproducían defectos reales:
 *
 *  1. El resumen se insertaba como `assistant` y podía quedar pegado a otro
 *     `assistant` de la zona protegida (roles sin alternar).
 *  2. La zona protegida contaba cada `assistant` como una ronda sin anclar la
 *     tarea: en un turno agéntico largo, el `user` con la tarea se perdía.
 *  3. Un resumen vacío sustituía igualmente al historial, y el compresor no
 *     veía las tool calls (solo `content`).
 *
 * El bloque `live` corre contra un backend real solo si se define
 * `STRATUM_LIVE_LLM_URL` (p. ej. `http://localhost:8080/v1`).
 */
import { describe, it, expect } from 'vitest';
import { ContextManager } from './harness.js';
import type { Message } from './types.js';
import type { CompletionRequest, IProvider } from '../providers/base.js';
import { OpenAICompatible } from '../providers/openai-compatible.js';

const TASK = 'TASK-ZORBLAX-42: migra el módulo de facturas a la API v2 sin romper los tests';

/** Provider falso que devuelve un texto fijo y guarda las peticiones que recibe. */
function fakeCompressor(text: string): IProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async *complete(req: CompletionRequest) {
      requests.push(req);
      if (text) {
        yield { choices: [{ delta: { content: text }, finish_reason: null, index: 0 }] };
      }
      yield { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] };
    },
  } as unknown as IProvider & { requests: CompletionRequest[] };
}

/**
 * Un único turno agéntico: una sola petición del usuario seguida de `iterations`
 * pares assistant(tool_calls) → tool con salidas grandes. Es la forma normal
 * del historial cuando el agente trabaja un rato sin intervención.
 */
function longAgenticTurn(iterations: number, toolOutputChars = 2000): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: TASK },
  ];
  for (let i = 0; i < iterations; i++) {
    const id = `call_${i}`;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.ts` }) },
        },
      ],
    });
    messages.push({ role: 'tool', tool_call_id: id, content: 'x'.repeat(toolOutputChars) });
  }
  return messages;
}

function consecutiveAssistants(messages: Message[]): number[] {
  const at: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === 'assistant' && messages[i - 1]?.role === 'assistant') at.push(i);
  }
  return at;
}

// ---------------------------------------------------------------------------
// 1. Alternancia de roles tras la compresión
// ---------------------------------------------------------------------------

describe('compresión — alternancia de roles (defecto 1)', () => {
  it('el resumen no queda pegado a otro assistant de la zona protegida', async () => {
    const cm = new ContextManager(4000, 2, fakeCompressor('resumen'), 'm', 0.8);
    const messages = longAgenticTurn(12);

    const result = await cm.maybeCompress(messages);

    expect(result.kind).toBe('compressed');
    expect(consecutiveAssistants(messages)).toEqual([]);
  });

  it('tras el system prompt el primer mensaje no es un assistant', async () => {
    const cm = new ContextManager(4000, 2, fakeCompressor('resumen'), 'm', 0.8);
    const messages = longAgenticTurn(12);

    await cm.maybeCompress(messages);

    // Varias plantillas de chat (Mistral, Gemma ≤3…) exigen que la conversación
    // empiece por `user` y rechazan la petición entera si no.
    expect(messages[1]?.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// 2. La tarea del usuario sobrevive a la compresión
// ---------------------------------------------------------------------------

describe('compresión — la tarea original sobrevive (defecto 2)', () => {
  it('con resumen LLM, el mensaje user de la tarea se conserva literal', async () => {
    const cm = new ContextManager(4000, 2, fakeCompressor('resumen'), 'm', 0.8);
    const messages = longAgenticTurn(12);

    await cm.maybeCompress(messages);

    expect(messages.some((m) => m.role === 'user' && m.content === TASK)).toBe(true);
  });

  it('con truncado duro (sin compresor), el mensaje user de la tarea se conserva', async () => {
    const cm = new ContextManager(4000, 2, undefined, undefined, 0.8);
    const messages = longAgenticTurn(12);

    const result = await cm.maybeCompress(messages);

    expect(result.kind).toBe('truncated');
    expect(messages.some((m) => m.role === 'user' && m.content === TASK)).toBe(true);
  });

  it('la tarea del turno en curso se ancla aunque la cola solo tenga iteraciones', async () => {
    // keepRounds=2 con una sola ronda de usuario: la cola son las 2 últimas
    // iteraciones y la tarea queda fuera de ella, así que se ancla aparte.
    const cm = new ContextManager(4000, 2, fakeCompressor('resumen'), 'm', 0.8);
    const messages = longAgenticTurn(12);
    const lastAssistant = messages.length - 2;
    const lastCallId = messages[lastAssistant]!.tool_calls![0]!.id;

    await cm.maybeCompress(messages);

    // La última iteración sigue ahí…
    expect(messages.some((m) => m.role === 'tool' && m.tool_call_id === lastCallId)).toBe(true);
    // …y la tarea también debería.
    expect(messages.findIndex((m) => m.content === TASK)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Huecos: resumen vacío y compresor ciego a las tool calls
// ---------------------------------------------------------------------------

describe('compresión — resumen vacío y contenido del compresor (defecto 3)', () => {
  it('un resumen vacío no sustituye al historial', async () => {
    const cm = new ContextManager(4000, 2, fakeCompressor(''), 'm', 0.8);
    const messages = longAgenticTurn(12);

    const result = await cm.maybeCompress(messages);

    expect(messages.some((m) => m.content === '<summary></summary>')).toBe(false);
    expect(result.kind).not.toBe('compressed');
  });

  it('un resumen solo de espacios tampoco cuenta como resumen', async () => {
    const cm = new ContextManager(4000, 2, fakeCompressor('   \n  '), 'm', 0.8);
    const messages = longAgenticTurn(12);

    const result = await cm.maybeCompress(messages);

    expect(messages.some((m) => /^<summary>\s*<\/summary>$/.test(m.content ?? ''))).toBe(false);
    expect(result.kind).not.toBe('compressed');
  });

  it('el compresor recibe las tool calls que hizo el agente, no solo el texto', async () => {
    const provider = fakeCompressor('resumen');
    const cm = new ContextManager(4000, 2, provider, 'm', 0.8);
    const messages = longAgenticTurn(12);

    await cm.maybeCompress(messages);

    const prompt = provider.requests[0]?.messages[0]?.content ?? '';
    // Antes cada assistant con tool_calls llegaba como «assistant: » vacío: el
    // resumen no podía decir qué ficheros se leyeron ni qué se ejecutó.
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('src/f0.ts');
  });
});

// ---------------------------------------------------------------------------
// 4. Robustez del resumen: cancelación, timeout, razonamiento y tamaño
// ---------------------------------------------------------------------------

/** Provider que no responde hasta que se aborta su señal. */
function hangingCompressor(): IProvider {
  return {
    async *complete(req: CompletionRequest) {
      await new Promise<void>((_, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  } as unknown as IProvider;
}

describe('compresión — robustez del resumen', () => {
  it('cancelar el turno durante el resumen deja el historial intacto', async () => {
    const cm = new ContextManager(4000, 2, hangingCompressor(), 'm', 0.8);
    const messages = longAgenticTurn(12);
    const before = structuredClone(messages);
    const ac = new AbortController();

    const pending = cm.maybeCompress(messages, ac.signal);
    ac.abort();

    expect((await pending).kind).toBe('skipped');
    expect(messages).toEqual(before);
  });

  it('un resumen que vence el timeout cae al truncado y dice por qué', async () => {
    const cm = new ContextManager(4000, 2, hangingCompressor(), 'm', 0.8, undefined, 50);
    const messages = longAgenticTurn(12);

    const result = await cm.maybeCompress(messages);

    expect(result.kind).toBe('truncated');
    expect(result.kind === 'truncated' && result.compressorError).toMatch(/timed out/);
    expect(messages.some((m) => m.role === 'user' && m.content === TASK)).toBe(true);
  });

  it('el razonamiento <think> del compresor no entra en el resumen', async () => {
    const provider = fakeCompressor('<think>pienso…</think>\nresumen');
    const cm = new ContextManager(4000, 2, provider, 'm', 0.8);
    const messages = longAgenticTurn(12);

    await cm.maybeCompress(messages);

    const summary = messages.find((m) => m.content?.includes('<summary>'))?.content ?? '';
    expect(summary).toContain('resumen');
    expect(summary).not.toContain('pienso');
  });

  it('la entrada del compresor recorta los tool results', async () => {
    const provider = fakeCompressor('resumen');
    const cm = new ContextManager(4000, 2, provider, 'm', 0.8);

    await cm.maybeCompress(longAgenticTurn(12, 20_000));

    const prompt = provider.requests[0]?.messages[0]?.content ?? '';
    expect(prompt.length).toBeLessThan(12 * 2_000);
    expect(prompt).toContain('output truncated');
  });

  it('en un chat sin tools el resumen abre la conversación como user', async () => {
    const cm = new ContextManager(1000, 2, fakeCompressor('resumen'), 'm', 0.8);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `pregunta ${i} `.repeat(40) });
      messages.push({ role: 'assistant', content: `respuesta ${i} `.repeat(40) });
    }

    const result = await cm.maybeCompress(messages);

    expect(result.kind).toBe('compressed');
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(messages[1]?.content).toMatch(
      /^<summary>[\s\S]*resumen[\s\S]*<\/summary>\n\npregunta 8/,
    );
  });

  it('el truncado duro nunca deja un assistant tras el system', async () => {
    const cm = new ContextManager(4000, 2, undefined, undefined, 0.8);
    // Turnos anteriores con varias iteraciones: cortar por la mitad de una
    // dejaría un assistant(tool_calls) justo después del system.
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      ...longAgenticTurn(6).slice(1),
      ...longAgenticTurn(6).slice(1),
    ];

    const result = await cm.maybeCompress(messages);

    expect(result.kind).toBe('truncated');
    expect(messages[1]?.role).toBe('user');
    expect(consecutiveAssistants(messages)).toEqual([]);
  });

  it('/compact con el compresor caído no toca nada y lo dice', async () => {
    const cm = new ContextManager(1_000_000, 2, fakeCompressor(''), 'm', 0.8);
    const messages = longAgenticTurn(6);
    const before = structuredClone(messages);

    const result = await cm.compress(messages);

    expect(result.kind).toBe('failed');
    expect(messages).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Contra un backend real (opt-in)
// ---------------------------------------------------------------------------

const LIVE_URL = process.env.STRATUM_LIVE_LLM_URL;
const LIVE_MODEL = process.env.STRATUM_LIVE_LLM_MODEL ?? 'gemma-4-12b';

describe.skipIf(!LIVE_URL)('compresión — backend real (STRATUM_LIVE_LLM_URL)', () => {
  const provider = (): IProvider => new OpenAICompatible(LIVE_URL!, '', LIVE_MODEL);

  /** Envía el historial y devuelve el error del backend, o null si lo aceptó. */
  async function backendAccepts(messages: Message[]): Promise<string | null> {
    try {
      for await (const _chunk of provider().complete({
        messages,
        model: LIVE_MODEL,
        stream: true,
        signal: AbortSignal.timeout(120_000),
      })) {
        /* drenar */
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it('el compresor real devuelve un resumen no vacío y el historial resultante se acepta', async () => {
    const cm = new ContextManager(4000, 2, provider(), LIVE_MODEL, 0.8);
    const messages = longAgenticTurn(12, 1500);

    const result = await cm.maybeCompress(messages);
    const summary = messages.find((m) => m.content?.startsWith('<summary>'))?.content ?? '';
    const detail = `roles: ${messages.map((m) => m.role).join(',')} | summary: ${summary.slice(0, 300)}`;

    // Defecto 4 (hallado aquí): `callCompressor` abortaba a los 30 s fijos y
    // gemma-4-12b en llama.cpp tarda ~40 s en este resumen, así que siempre se
    // caía al truncado duro sin aviso. Ahora `agent.compressionTimeoutMs`.
    expect(result.kind, detail).toBe('compressed');
    expect(summary.replace(/<\/?summary>/g, '').trim().length).toBeGreaterThan(0);
    expect(await backendAccepts(messages)).toBeNull();
    // Defecto 2 con el compresor real: ¿sobrevive el identificador de la tarea?
    expect(messages.some((m) => (m.content ?? '').includes('TASK-ZORBLAX-42'))).toBe(true);
  }, 180_000);
});
