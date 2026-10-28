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
import {
  COMPRESSOR_PREFIX_CLOSE,
  COMPRESSOR_PREFIX_OPEN,
  COMPRESSOR_PROMPT,
  ContextManager,
  type CompressionPrefix,
} from './harness.js';
import type { Message } from './types.js';
import type { CompletionRequest, IProvider, ToolSchema } from '../providers/base.js';
import { OpenAICompatible } from '../providers/openai-compatible.js';
import { ProviderError } from '../providers/errors.js';

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
// 5. Resumen que reutiliza el prefijo cacheado (agent.compressionReusePrefix)
// ---------------------------------------------------------------------------

const TOOLS: ToolSchema[] = [
  { type: 'function', function: { name: 'read_file', description: 'Lee', parameters: {} } },
];

/**
 * Como en el loop: antes de comprimir, la última petición mandó todo menos lo
 * último que entró en el historial (el resultado de tool, o el `user` nuevo).
 */
class LoopContextManager extends ContextManager {
  recordLoop = true;

  override async maybeCompress(
    messages: Message[],
    signal?: AbortSignal,
    trace?: undefined,
    prefix?: CompressionPrefix,
  ) {
    if (this.recordLoop) this.recordSent(messages.slice(0, -1), prefix?.tools ?? []);
    return super.maybeCompress(messages, signal, trace, prefix);
  }
}

/** Ventana y umbral en los que `longAgenticTurn(12)` (~7k tokens) comprime y aún cabe entero. */
function prefixManager(
  provider: IProvider,
  opts: {
    window?: number;
    compressorModel?: string;
    timeoutMs?: number;
    reuse?: boolean;
    recordLoop?: boolean;
  } = {},
): ContextManager {
  const cm = new LoopContextManager(
    opts.window ?? 12_000,
    2,
    provider,
    'm',
    0.5,
    opts.compressorModel,
    opts.timeoutMs,
    undefined,
    opts.reuse ?? true,
  );
  cm.recordLoop = opts.recordLoop ?? true;
  return cm;
}

const isDigest = (req: CompletionRequest | undefined): boolean =>
  req?.messages.length === 1 && (req.messages[0]?.content ?? '').startsWith(COMPRESSOR_PROMPT);

describe('compresión — reutilizar el prefijo cacheado', () => {
  it('manda el historial tal cual, con las mismas tools en none y la instrucción al final', async () => {
    const provider = fakeCompressor('resumen');
    const messages = longAgenticTurn(12);
    const before = structuredClone(messages);

    const result = await prefixManager(provider).maybeCompress(messages, undefined, undefined, {
      tools: TOOLS,
      sessionId: 's1',
      provider,
    });

    expect(result.kind).toBe('compressed');
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.messages.slice(0, before.length)).toEqual(before);
    expect(req.messages).toHaveLength(before.length + 1);
    const last = req.messages[req.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toContain(COMPRESSOR_PREFIX_OPEN);
    expect(last.content?.trimEnd().endsWith(COMPRESSOR_PREFIX_CLOSE)).toBe(true);
    // Dice qué se queda literal: la cola y la tarea anclada.
    expect(last.content).toContain("the user's current request");
    expect(req.tools).toEqual(TOOLS);
    expect(req.toolChoice).toBe('none');
    expect(req.sessionId).toBe('s1');
    expect(req.model).toBe('m');
    // El resultado es el de siempre: resumen aplicado y la tarea intacta.
    expect(messages.some((m) => m.content?.includes('<summary>\nresumen'))).toBe(true);
    expect(messages.some((m) => m.role === 'user' && m.content === TASK)).toBe(true);
  });

  it('si el historial acaba en un user, la instrucción va pegada a él: nunca dos user seguidos', async () => {
    const provider = fakeCompressor('resumen');
    const messages: Message[] = [...longAgenticTurn(12), { role: 'user', content: 'sigue' }];
    const sent = messages.length;

    await prefixManager(provider).maybeCompress(messages, undefined, undefined, {
      tools: TOOLS,
      provider,
    });

    const req = provider.requests[0]!;
    expect(req.messages).toHaveLength(sent);
    const last = req.messages[req.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/^sigue\n\n<context_compression_request>/);
    expect(req.messages[req.messages.length - 2]?.role).toBe('tool');
  });

  it('sin tools en la sesión no manda tools ni tool_choice', async () => {
    const provider = fakeCompressor('resumen');

    await prefixManager(provider).maybeCompress(longAgenticTurn(12), undefined, undefined, {
      tools: [],
      provider,
    });

    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(provider.requests[0]?.toolChoice).toBeUndefined();
    expect(isDigest(provider.requests[0])).toBe(false);
  });

  it('usa el resumen de siempre si la opción está apagada, aunque el loop dé el prefijo', async () => {
    const provider = fakeCompressor('resumen');

    await prefixManager(provider, { reuse: false }).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(isDigest(provider.requests[0])).toBe(true);
    expect(provider.requests[0]?.tools).toBeUndefined();
  });

  it('usa el resumen de siempre con otro modelo de compresión, otro provider o sin datos del loop', async () => {
    const provider = fakeCompressor('resumen');
    await prefixManager(provider, { compressorModel: 'pequeño' }).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );
    expect(isDigest(provider.requests[0])).toBe(true);
    expect(provider.requests[0]?.model).toBe('pequeño');

    // Tras un fallback el loop lo atiende otro provider: su caché no es la de este.
    const fallback = fakeCompressor('otro');
    await prefixManager(provider).maybeCompress(longAgenticTurn(12), undefined, undefined, {
      tools: TOOLS,
      provider: fallback,
    });
    expect(isDigest(provider.requests[1])).toBe(true);
    expect(fallback.requests).toHaveLength(0);

    await prefixManager(provider).maybeCompress(longAgenticTurn(12));
    expect(isDigest(provider.requests[2])).toBe(true);
  });

  it('si el historial entero no cabría con el resumen, usa el de siempre (que recorta)', async () => {
    const provider = fakeCompressor('resumen');

    await prefixManager(provider, { window: 8_000 }).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(isDigest(provider.requests[0])).toBe(true);
  });

  it('sin saber qué mandó el loop, o si el historial cambió debajo, usa el de siempre', async () => {
    const provider = fakeCompressor('resumen');
    await prefixManager(provider, { recordLoop: false }).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );
    expect(isDigest(provider.requests[0])).toBe(true);

    // Lo registrado es de otro historial (`/clear`, reanudar): el último
    // mensaje mandado no está en su sitio.
    const cm = prefixManager(provider, { recordLoop: false });
    cm.recordSent(longAgenticTurn(11), TOOLS);
    await cm.maybeCompress(longAgenticTurn(12), undefined, undefined, { tools: TOOLS, provider });
    expect(isDigest(provider.requests[1])).toBe(true);
  });

  it('si desde la última petición cambió el system, las tools o el modelo, usa el de siempre', async () => {
    const provider = fakeCompressor('resumen');
    const fresh = (): { cm: ContextManager; messages: Message[]; sent: Message[] } => {
      const messages = longAgenticTurn(12);
      return {
        cm: prefixManager(provider, { recordLoop: false }),
        messages,
        sent: messages.slice(0, -1),
      };
    };

    // Control: lo mismo que mandó el loop → prefijo.
    let t = fresh();
    t.cm.recordSent(t.sent, TOOLS, 'm');
    await t.cm.maybeCompress(t.messages, undefined, undefined, { tools: TOOLS, provider });
    expect(isDigest(provider.requests.at(-1))).toBe(false);

    // `rebuildSystemPrompt` sustituye el system: la caché se pierde desde el byte 0.
    t = fresh();
    t.cm.recordSent(t.sent, TOOLS, 'm');
    t.messages[0] = { role: 'system', content: 'sys v2' };
    await t.cm.maybeCompress(t.messages, undefined, undefined, { tools: TOOLS, provider });
    expect(isDigest(provider.requests.at(-1))).toBe(true);

    // Otras tools (modo plan, MCP).
    t = fresh();
    t.cm.recordSent(t.sent, [], 'm');
    await t.cm.maybeCompress(t.messages, undefined, undefined, { tools: TOOLS, provider });
    expect(isDigest(provider.requests.at(-1))).toBe(true);

    // Otro modelo.
    t = fresh();
    t.cm.recordSent(t.sent, TOOLS, 'otro');
    await t.cm.maybeCompress(t.messages, undefined, undefined, { tools: TOOLS, provider });
    expect(isDigest(provider.requests.at(-1))).toBe(true);
  });

  it('si lo que quedaría fuera de caché es mayor que el digest, usa el digest', async () => {
    // El caso típico: la compresión salta justo después de un resultado enorme,
    // que es lo único que no está en caché (y el digest lo recorta).
    const provider = fakeCompressor('resumen');
    const messages = longAgenticTurn(12);
    messages[messages.length - 1] = {
      ...messages[messages.length - 1]!,
      content: 'x'.repeat(20_000),
    };

    const result = await prefixManager(provider, { window: 20_000 }).maybeCompress(
      messages,
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(result.kind).toBe('compressed');
    expect(isDigest(provider.requests[0])).toBe(true);
  });

  /** Rechaza la petición con prefijo con `error`; el digest lo contesta con `text`. */
  function rejectingPrefix(
    error: Error,
    text = 'resumen',
  ): IProvider & { requests: CompletionRequest[] } {
    const requests: CompletionRequest[] = [];
    return {
      requests,
      async *complete(req: CompletionRequest) {
        requests.push(req);
        if (req.toolChoice === 'none') throw error;
        yield { choices: [{ delta: { content: text }, finish_reason: 'stop', index: 0 }] };
      },
    } as unknown as IProvider & { requests: CompletionRequest[] };
  }

  it('si el backend rechaza la petición con prefijo (no reintentable), resume con el digest', async () => {
    const provider = rejectingPrefix(
      new ProviderError('HTTP 400: tool_choice not supported', 'http', false, {
        status: 400,
      }),
    );

    const result = await prefixManager(provider).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(result.kind).toBe('compressed');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.toolChoice).toBe('none');
    expect(isDigest(provider.requests[1])).toBe(true);
  });

  it('un resumen vacío con prefijo también prueba con el digest', async () => {
    const requests: CompletionRequest[] = [];
    const provider = {
      async *complete(req: CompletionRequest) {
        requests.push(req);
        const content = req.toolChoice === 'none' ? '' : 'resumen';
        yield { choices: [{ delta: { content }, finish_reason: 'stop', index: 0 }] };
      },
    } as unknown as IProvider;

    const result = await prefixManager(provider).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(result.kind).toBe('compressed');
    expect(requests).toHaveLength(2);
    expect(isDigest(requests[1])).toBe(true);
  });

  it('un fallo de red o 5xx es el Caso A: no se prueba con el digest, se trunca', async () => {
    const provider = rejectingPrefix(
      new ProviderError('HTTP 503: overloaded', 'http', true, { status: 503 }),
    );

    const result = await prefixManager(provider).maybeCompress(
      longAgenticTurn(12),
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(provider.requests).toHaveLength(1);
    expect(result.kind).toBe('truncated');
    expect(result.kind === 'truncated' && result.compressorError).toMatch(/503/);
  });

  it('si la petición con prefijo vence el timeout, no espera otro: trunca y dice por qué', async () => {
    let calls = 0;
    const inner = hangingCompressor();
    const provider = {
      complete(req: CompletionRequest) {
        calls++;
        return inner.complete(req);
      },
    } as unknown as IProvider;
    const messages = longAgenticTurn(12);

    const result = await prefixManager(provider, { timeoutMs: 50 }).maybeCompress(
      messages,
      undefined,
      undefined,
      { tools: TOOLS, provider },
    );

    expect(calls).toBe(1);
    expect(result.kind).toBe('truncated');
    expect(result.kind === 'truncated' && result.compressorError).toMatch(/timed out/);
  });

  it('cancelar durante la petición con prefijo deja el historial intacto y no prueba la otra', async () => {
    let calls = 0;
    const inner = hangingCompressor();
    const provider = {
      complete(req: CompletionRequest) {
        calls++;
        return inner.complete(req);
      },
    } as unknown as IProvider;
    const messages = longAgenticTurn(12);
    const before = structuredClone(messages);
    const ac = new AbortController();

    const pending = prefixManager(provider).maybeCompress(messages, ac.signal, undefined, {
      tools: TOOLS,
      provider,
    });
    ac.abort();

    expect((await pending).kind).toBe('skipped');
    expect(calls).toBe(1);
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
