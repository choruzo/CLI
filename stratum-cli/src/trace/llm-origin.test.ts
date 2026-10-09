import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ContextManager, ReactLoop } from '../agent/harness.js';
import { StratumAgent } from '../agent/core.js';
import type { Message } from '../agent/types.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { DecisionMemory } from '../memory/decision-memory.js';
import { extractAndStore } from '../memory/extractor.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import { ProviderRouter } from '../providers/router.js';
import { SessionStore } from '../session/store.js';
import { ToolRegistry } from '../tools/registry.js';
import { tracedCompletion } from './llm-call.js';
import {
  applyRecords,
  auxiliaryImpact,
  auxiliaryOverlaps,
  cacheBreaks,
  cacheSummary,
  emptyTrace,
  isAuxiliaryCall,
  llmBreakdown,
  originOf,
  stepLabel,
  traceStats,
  tracksAuxiliaryCalls,
  type TraceModel,
  type TraceStep,
} from './model.js';
import { TraceRecorder, type TraceScope } from './recorder.js';
import {
  AUXILIARY_LLM_ORIGINS,
  LLM_CALL_ORIGINS,
  TRACE_CAP_LLM_ORIGIN,
  isAuxiliaryOrigin,
  type TraceRecord,
} from './records.js';

let dir: string;
let config: StratumConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-origin-'));
  config = StratumConfigSchema.parse({
    trace: { dir },
    memory: {
      decisionsFile: join(dir, 'decisions.json'),
      vectorDb: join(dir, 'vectors.db'),
      embeddingDimension: 4,
    },
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newRecorder(id = 'sess_origin'): TraceRecorder {
  return new TraceRecorder({ file: join(dir, `${id}.jsonl`), sessionId: id, config });
}

async function read(rec: TraceRecorder): Promise<TraceRecord[]> {
  await rec.flush();
  let text = '';
  try {
    text = readFileSync(rec.file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceRecord);
}

const modelOf = (records: readonly TraceRecord[]): TraceModel =>
  applyRecords(emptyTrace(), records);

const modelSteps = (records: readonly TraceRecord[]): TraceStep[] =>
  modelOf(records).steps.filter((s) => s.kind === 'model');

type Chunk = OpenAIStreamChunk;
const text = (content: string): Chunk => ({
  choices: [{ delta: { content }, finish_reason: null, index: 0 }],
});
const usage = (prompt: number, completion: number, cached?: number): Chunk => ({
  choices: [],
  usage: {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(cached !== undefined ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  },
});

/** Provider de guion: devuelve los chunks dados, o lanza. */
function scripted(chunks: Chunk[], opts: { fail?: string; seen?: CompletionRequest[] } = {}) {
  const provider: IProvider = {
    async *complete(req: CompletionRequest): AsyncGenerator<Chunk> {
      opts.seen?.push(req);
      for (const c of chunks) yield c;
      if (opts.fail) throw new Error(opts.fail);
    },
    async healthCheck() {
      return true;
    },
  };
  return provider;
}

/** Provider que no contesta hasta que se aborta la señal de la petición. */
function hanging(): IProvider {
  return {
    async *complete(req: CompletionRequest): AsyncGenerator<Chunk> {
      await new Promise<void>((_, reject) => {
        if (req.signal?.aborted) reject(new Error('aborted'));
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    async healthCheck() {
      return true;
    },
  };
}

async function drain(gen: AsyncGenerator<Chunk>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c.choices?.[0]?.delta?.content ?? '';
  return out;
}

const request = (signal?: AbortSignal): CompletionRequest => ({
  messages: [
    { role: 'system', content: 'instrucciones del extractor' },
    { role: 'user', content: 'conversación a analizar' },
  ],
  model: 'aux-model',
  stream: true,
  ...(signal ? { signal } : {}),
});

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

describe('origen de una llamada al LLM — contrato', () => {
  it('los orígenes auxiliares son los que no son ni el agente ni un subagente', () => {
    expect(LLM_CALL_ORIGINS).toEqual([
      'agent',
      'subagent',
      'memory-extraction',
      'context-compression',
      'session-summary',
    ]);
    expect(LLM_CALL_ORIGINS.filter(isAuxiliaryOrigin)).toEqual([...AUXILIARY_LLM_ORIGINS]);
    expect(isAuxiliaryOrigin('agent')).toBe(false);
    expect(isAuxiliaryOrigin('subagent')).toBe(false);
  });

  it('el loop marca sus llamadas como `agent` y la cabecera declara el cap', async () => {
    const rec = newRecorder();
    const messages: Message[] = [
      { role: 'system', content: 'You are Stratum.' },
      { role: 'user', content: 'hola' },
    ];
    const scope = rec.scope();
    scope.turnStart('hola', messages);
    const loop = new ReactLoop(
      new MockProvider([makeTextRound('Hola.')]),
      new ToolRegistry(),
      messages,
      config,
      'mock-model',
      32768,
    );
    for await (const ev of loop.run({ trace: scope })) scope.event(ev);
    scope.turnEnd('stop');

    const records = await read(rec);
    expect(records[0]).toMatchObject({ t: 'meta' });
    expect((records[0] as { caps?: string[] }).caps).toContain(TRACE_CAP_LLM_ORIGIN);
    const begin = records.find((r) => r.t === 'begin' && r.kind === 'model');
    expect(begin).toMatchObject({ data: { origin: 'agent', iteration: 0, model: 'mock-model' } });
    expect(begin).not.toHaveProperty('parent');
  });

  it('el scope de un subagente marca las suyas como `subagent`, colgadas de él', async () => {
    const rec = newRecorder();
    const child = rec.scope().child('sub_1');
    child
      .modelStart({
        iteration: 0,
        model: 'm',
        messages: [{ role: 'user', content: 't' }],
        tools: 0,
      })
      .end({ text: 'ok', reasoning: '', toolCalls: [] });
    const [step] = modelSteps(await read(rec));
    expect(step?.data.origin).toBe('subagent');
    expect(step?.parent).toBe('sub_1');
  });

  it('una auxiliar dentro de un subagente conserva su origen y el padre', async () => {
    const rec = newRecorder();
    await drain(
      tracedCompletion({
        origin: 'context-compression',
        provider: scripted([text('resumen')]),
        request: request(),
        trace: rec.scope().child('sub_7'),
      }),
    );
    const [step] = modelSteps(await read(rec));
    expect(step?.data.origin).toBe('context-compression');
    expect(step?.parent).toBe('sub_7');
    expect(originOf(step!)).toBe('context-compression');
  });
});

// ---------------------------------------------------------------------------
// tracedCompletion
// ---------------------------------------------------------------------------

describe('tracedCompletion — una llamada auxiliar siempre deja su paso', () => {
  it('registra origen, provider, modelo, primer token, uso de caché y estado', async () => {
    const rec = newRecorder();
    const seen: CompletionRequest[] = [];
    const out = await drain(
      tracedCompletion({
        origin: 'memory-extraction',
        provider: scripted([text('[]'), usage(400, 2, 120)], { seen }),
        providerName: 'local',
        request: request(),
        trace: rec.scope(),
      }),
    );
    expect(out).toBe('[]');
    // La petición llega al provider tal cual: trazar no la cambia.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(request());

    const records = await read(rec);
    const [step] = modelSteps(records);
    expect(step).toMatchObject({ kind: 'model', name: 'aux-model', status: 'ok', parent: null });
    expect(step?.data).toMatchObject({
      origin: 'memory-extraction',
      provider: 'local',
      model: 'aux-model',
      messages: 2,
      tools: 0,
      text: '[]',
      usage: { promptTokens: 400, completionTokens: 2, cachedReadTokens: 120 },
    });
    expect(step?.data).not.toHaveProperty('iteration');
    expect(step?.firstToken).not.toBeNull();
    expect(step?.end).not.toBeNull();
    expect(records.some((r) => r.t === 'mark' && r.name === 'first_token')).toBe(true);
  });

  it('no guarda el prompt de la auxiliar: solo recuentos', async () => {
    const rec = newRecorder();
    await drain(
      tracedCompletion({
        origin: 'memory-extraction',
        provider: scripted([text('[]')]),
        request: request(),
        trace: rec.scope(),
      }),
    );
    const records = await read(rec);
    // Ni paso `system` ni `context`: el prompt se deriva de un historial ya trazado.
    expect(records.filter((r) => r.t === 'point')).toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain('instrucciones del extractor');
    expect(JSON.stringify(records)).not.toContain('conversación a analizar');
  });

  it('si falla, el paso queda en error y el fallo se relanza', async () => {
    const rec = newRecorder();
    await expect(
      drain(
        tracedCompletion({
          origin: 'memory-extraction',
          provider: scripted([], { fail: 'HTTP 503: sin slots' }),
          request: request(),
          trace: rec.scope(),
        }),
      ),
    ).rejects.toThrow('HTTP 503');
    const [step] = modelSteps(await read(rec));
    expect(step).toMatchObject({ status: 'error' });
    expect(step?.data.error).toContain('HTTP 503');
    expect(step?.firstToken).toBeNull();
  });

  it('cancelada por quien la pidió queda `cancelled`, no en error', async () => {
    const rec = newRecorder();
    const cancel = new AbortController();
    const pending = drain(
      tracedCompletion({
        origin: 'memory-extraction',
        provider: hanging(),
        request: request(cancel.signal),
        trace: rec.scope(),
        cancelSignal: cancel.signal,
      }),
    );
    cancel.abort();
    await expect(pending).rejects.toThrow();
    const [step] = modelSteps(await read(rec));
    expect(step?.status).toBe('cancelled');
    expect(step?.data).not.toHaveProperty('error');
  });

  it('un timeout de la propia petición es un error, no una cancelación', async () => {
    const rec = newRecorder();
    const user = new AbortController();
    await expect(
      drain(
        tracedCompletion({
          origin: 'context-compression',
          provider: hanging(),
          request: request(AbortSignal.timeout(20)),
          trace: rec.scope(),
          cancelSignal: user.signal,
        }),
      ),
    ).rejects.toThrow();
    const [step] = modelSteps(await read(rec));
    expect(step?.status).toBe('error');
  });

  it('sin texto y sin `usage` el paso se cierra igual, sin cifras inventadas', async () => {
    const rec = newRecorder();
    await drain(
      tracedCompletion({
        origin: 'session-summary',
        provider: scripted([]),
        request: request(),
        trace: rec.scope(),
      }),
    );
    const [step] = modelSteps(await read(rec));
    expect(step?.status).toBe('ok');
    expect(step?.data).not.toHaveProperty('usage');
    expect(step?.data).not.toHaveProperty('text');
    expect(step?.firstToken).toBeNull();
    expect(llmBreakdown(modelOf(await read(rec)), 0).byOrigin['session-summary']).toMatchObject({
      calls: 1,
      promptTokens: null,
      cachedReadTokens: null,
      ttftMs: null,
    });
  });

  it('abandonar el stream a medias cierra el paso', async () => {
    const rec = newRecorder();
    for await (const chunk of tracedCompletion({
      origin: 'memory-extraction',
      provider: scripted([text('uno'), text('dos'), text('tres')]),
      request: request(),
      trace: rec.scope(),
    })) {
      if (chunk.choices[0]?.delta.content === 'uno') break;
    }
    const [step] = modelSteps(await read(rec));
    expect(step?.end).not.toBeNull();
    expect(step?.data.text).toBe('uno');
  });

  it('redacta los secretos de la salida antes de que toquen el disco', async () => {
    const rec = newRecorder();
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    await drain(
      tracedCompletion({
        origin: 'context-compression',
        provider: scripted([text(`El token es ${secret} y sigue.`)]),
        request: request(),
        trace: rec.scope(),
      }),
    );
    await rec.flush();
    const raw = readFileSync(rec.file, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[redacted:');
  });

  it('sin scope hace la misma llamada y no escribe nada', async () => {
    const out = await drain(
      tracedCompletion({
        origin: 'memory-extraction',
        provider: scripted([text('[]')]),
        request: request(),
      }),
    );
    expect(out).toBe('[]');
  });
});

// ---------------------------------------------------------------------------
// Rutas auxiliares reales
// ---------------------------------------------------------------------------

/** Turno agéntico largo: lo bastante para que haya algo que comprimir. */
function longHistory(rounds: number): Message[] {
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'analiza los ficheros' },
  ];
  for (let i = 0; i < rounds; i++) {
    const id = `c${i}`;
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}"}` } },
      ],
    });
    messages.push({ role: 'tool', tool_call_id: id, content: 'x'.repeat(600) });
  }
  return messages;
}

describe('compresión de contexto — `context-compression`', () => {
  const manager = (provider: IProvider, timeoutMs?: number): ContextManager =>
    new ContextManager(4000, 2, provider, 'main-model', 0.8, undefined, timeoutMs, 'local');

  it('el resumen queda en la traza con su origen, provider y uso', async () => {
    const rec = newRecorder();
    const cm = manager(scripted([text('resumen del trabajo'), usage(900, 30, 0)]));
    const result = await cm.compress(longHistory(10), undefined, true, rec.scope());
    expect(result.kind).toBe('compressed');
    const [step] = modelSteps(await read(rec));
    expect(step).toMatchObject({ status: 'ok', name: 'main-model' });
    expect(step?.data).toMatchObject({
      origin: 'context-compression',
      provider: 'local',
      messages: 1,
      usage: { promptTokens: 900, cachedReadTokens: 0 },
    });
  });

  it('`maybeCompress` por encima del umbral también la registra', async () => {
    const rec = newRecorder();
    const cm = manager(scripted([text('resumen')]));
    const result = await cm.maybeCompress(longHistory(40), undefined, rec.scope());
    expect(result.kind).not.toBe('skipped');
    expect(modelSteps(await read(rec)).map((s) => s.data.origin)).toEqual(['context-compression']);
  });

  it('por debajo del umbral no hay llamada ni paso', async () => {
    const rec = newRecorder();
    const cm = new ContextManager(1_000_000, 2, scripted([text('resumen')]), 'm', 0.8);
    expect((await cm.maybeCompress(longHistory(4), undefined, rec.scope())).kind).toBe('skipped');
    expect(await read(rec)).toHaveLength(0);
  });

  it('si el compresor falla, el paso queda en error y se cae al truncado como siempre', async () => {
    const rec = newRecorder();
    const cm = manager(scripted([], { fail: 'backend caído' }));
    const result = await cm.maybeCompress(longHistory(40), undefined, rec.scope());
    expect(['truncated', 'pressure']).toContain(result.kind);
    const [step] = modelSteps(await read(rec));
    expect(step?.status).toBe('error');
    expect(step?.data.error).toContain('backend caído');
  });

  it('un resumen vacío cierra el paso sin error del provider (el fallo es del runtime)', async () => {
    const rec = newRecorder();
    const cm = manager(scripted([text('   ')]));
    await cm.maybeCompress(longHistory(40), undefined, rec.scope());
    const [step] = modelSteps(await read(rec));
    expect(step?.status).toBe('ok');
  });

  it('el timeout del resumen es un error; cancelar el turno, una cancelación', async () => {
    const recA = newRecorder('sess_timeout');
    await manager(hanging(), 30).maybeCompress(longHistory(40), undefined, recA.scope());
    expect(modelSteps(await read(recA))[0]?.status).toBe('error');

    const recB = newRecorder('sess_cancel');
    const turn = new AbortController();
    const pending = manager(hanging()).maybeCompress(longHistory(40), turn.signal, recB.scope());
    turn.abort();
    expect((await pending).kind).toBe('skipped');
    expect(modelSteps(await read(recB))[0]?.status).toBe('cancelled');
  });

  it('sin scope se comporta igual (los tests y llamadores de siempre)', async () => {
    const cm = manager(scripted([text('resumen')]));
    expect((await cm.compress(longHistory(10))).kind).toBe('compressed');
  });
});

describe('extracción de memoria — `memory-extraction`', () => {
  const convo: Message[] = [
    { role: 'user', content: 'Vamos a usar pnpm en este repo, no npm.' },
    { role: 'assistant', content: 'De acuerdo, uso pnpm.' },
  ];
  const memory = (): DecisionMemory =>
    new DecisionMemory(config, {
      embedding: {
        embedFn: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
      },
      forceFallbackVectors: true,
    });

  it('la llamada del extractor queda en la traza aunque no extraiga nada', async () => {
    const rec = newRecorder();
    const added = await extractAndStore({
      provider: scripted([text('[]'), usage(300, 1, 0)]),
      providerName: 'local',
      model: 'extract-model',
      messages: convo,
      memory: memory(),
      trace: rec.scope(),
    });
    expect(added).toBe(0);
    const [step] = modelSteps(await read(rec));
    expect(step).toMatchObject({ status: 'ok', name: 'extract-model' });
    expect(step?.data).toMatchObject({
      origin: 'memory-extraction',
      provider: 'local',
      text: '[]',
    });
  });

  it('si el provider falla, extrae 0 sin lanzar y la traza conserva el error', async () => {
    const rec = newRecorder();
    const added = await extractAndStore({
      provider: scripted([], { fail: 'HTTP 500' }),
      model: 'm',
      messages: convo,
      memory: memory(),
      trace: rec.scope(),
    });
    expect(added).toBe(0);
    const [step] = modelSteps(await read(rec));
    expect(step?.status).toBe('error');
    expect(step?.data.error).toContain('HTTP 500');
  });

  it('con menos de dos mensajes no hay llamada ni paso', async () => {
    const rec = newRecorder();
    await extractAndStore({
      provider: scripted([text('[]')]),
      model: 'm',
      messages: [convo[0]!],
      memory: memory(),
      trace: rec.scope(),
    });
    expect(await read(rec)).toHaveLength(0);
  });
});

describe('resumen de sesión — `session-summary`', () => {
  it('la llamada del resumen al guardar queda en la traza', async () => {
    const rec = newRecorder();
    const store = new SessionStore(join(dir, 'sessions'));
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: `pregunta ${i}` });
      messages.push({ role: 'assistant', content: `respuesta ${i}` });
    }
    const saved = await store.save({
      provider: 'local',
      model: 'main-model',
      project: dir,
      messages,
      toolCallCount: 0,
      llmProvider: scripted([text('Cinco preguntas y respuestas.')]),
      trace: rec.scope(),
    });
    expect(saved.summary).toBe('Cinco preguntas y respuestas.');
    const [step] = modelSteps(await read(rec));
    expect(step).toMatchObject({ status: 'ok', name: 'main-model' });
    expect(step?.data).toMatchObject({ origin: 'session-summary', provider: 'local' });
  });
});

describe('StratumAgent — extracción tras el turno', () => {
  const agentConfig = (): StratumConfig =>
    StratumConfigSchema.parse({
      provider: {
        default: 'test',
        providers: {
          test: {
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: '',
            model: 'test-model',
            contextWindow: 32768,
          },
        },
      },
      trace: { dir },
      memory: {
        autoExtract: true,
        embeddingWarmup: false,
        decisionsFile: join(dir, 'decisions.json'),
        vectorDb: join(dir, 'vectors.db'),
      },
    });

  async function runAgent(
    provider: IProvider,
    scope: TraceScope,
  ): Promise<{ agent: StratumAgent; stop: string | null }> {
    const cfg = agentConfig();
    const router = new ProviderRouter(cfg);
    (router as unknown as { getActive: () => IProvider }).getActive = () => provider;
    const agent = new StratumAgent(cfg, router, new ToolRegistry());
    let stop: string | null = null;
    for await (const ev of agent.run('Usa pnpm en este repo.', { trace: scope })) {
      if (ev.type === 'done') stop = ev.stopReason;
    }
    return { agent, stop };
  }

  /** Primera llamada: el turno del agente. Segunda: el extractor. */
  function twoCalls(second: (req: CompletionRequest) => AsyncGenerator<Chunk>): IProvider {
    let n = 0;
    return {
      async *complete(req: CompletionRequest): AsyncGenerator<Chunk> {
        if (n++ === 0) {
          yield { choices: [{ delta: { content: 'Hecho.' }, finish_reason: 'stop', index: 0 }] };
          return;
        }
        yield* second(req);
      },
      async healthCheck() {
        return true;
      },
    };
  }

  const waitForClosed = async (rec: TraceRecorder): Promise<TraceStep[]> => {
    for (let i = 0; i < 200; i++) {
      const steps = modelSteps(await read(rec));
      if (steps.length >= 2 && steps.every((s) => s.end !== null)) return steps;
      await new Promise((r) => setTimeout(r, 10));
    }
    return modelSteps(await read(rec));
  };

  it('el turno deja una llamada `agent` y, después de cerrarse, una `memory-extraction`', async () => {
    const rec = newRecorder();
    const { stop } = await runAgent(
      twoCalls(async function* () {
        yield text('[]');
      }),
      rec.scope(),
    );
    expect(stop).toBe('stop');
    const steps = await waitForClosed(rec);
    expect(steps.map((s) => s.data.origin)).toEqual(['agent', 'memory-extraction']);
    const records = await read(rec);
    const turnEnd = records.findIndex((r) => r.t === 'turn_end');
    const extraction = records.findIndex(
      (r) => r.t === 'begin' && r.data?.origin === 'memory-extraction',
    );
    expect(extraction).toBeGreaterThan(turnEnd);
  });

  it('una extracción que falla no cambia el resultado del turno y deja su error', async () => {
    const rec = newRecorder();
    const { stop } = await runAgent(
      twoCalls(async function* () {
        yield* [];
        throw new Error('HTTP 500: extractor caído');
      }),
      rec.scope(),
    );
    expect(stop).toBe('stop');
    const steps = await waitForClosed(rec);
    expect(steps.map((s) => [s.data.origin, s.status])).toEqual([
      ['agent', 'ok'],
      ['memory-extraction', 'error'],
    ]);
    const records = await read(rec);
    expect(records.find((r) => r.t === 'turn_end')).toMatchObject({ stopReason: 'stop' });
  });

  it('`cancelBackgroundWork` corta la extracción en vuelo, que queda `cancelled`', async () => {
    const rec = newRecorder();
    const stuck = hanging();
    const { agent } = await runAgent(
      twoCalls((req) => stuck.complete(req)),
      rec.scope(),
    );
    await agent.cancelBackgroundWork();
    const steps = modelSteps(await read(rec));
    expect(steps.map((s) => [s.data.origin, s.status])).toEqual([
      ['agent', 'ok'],
      ['memory-extraction', 'cancelled'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reconstrucción
// ---------------------------------------------------------------------------

interface CallSpec {
  id: string;
  start: number;
  end: number | null;
  origin?: string;
  parent?: string;
  first?: number;
  status?: 'ok' | 'error' | 'cancelled';
  usage?: { promptTokens: number; completionTokens: number; cachedReadTokens?: number };
  prefix?: Record<string, unknown>;
}

function call(c: CallSpec): TraceRecord[] {
  const out: TraceRecord[] = [
    {
      t: 'begin',
      at: c.start,
      id: c.id,
      kind: 'model',
      name: 'm',
      ...(c.parent ? { parent: c.parent } : {}),
      data: {
        ...(c.origin ? { origin: c.origin } : {}),
        provider: 'p',
        ...(c.prefix ? { prefix: c.prefix } : {}),
      },
    },
  ];
  if (c.first !== undefined) out.push({ t: 'mark', at: c.first, id: c.id, name: 'first_token' });
  if (c.end !== null) {
    out.push({
      t: 'end',
      at: c.end,
      id: c.id,
      status: c.status ?? 'ok',
      ...(c.usage ? { data: { usage: c.usage } } : {}),
    });
  }
  return out;
}

const meta = (caps?: string[]): TraceRecord => ({
  t: 'meta',
  v: 1,
  at: 0,
  sessionId: 's',
  ...(caps ? { caps } : {}),
});
const NEW_CAPS = ['runtime', TRACE_CAP_LLM_ORIGIN];

describe('reconstrucción — compatibilidad con trazas anteriores', () => {
  const old: TraceRecord[] = [
    meta(['runtime']),
    { t: 'turn', at: 10, input: 'tarea' },
    ...call({
      id: 'a',
      start: 20,
      end: 120,
      first: 60,
      usage: { promptTokens: 100, completionTokens: 5 },
    }),
    { t: 'begin', at: 130, id: 'sub1', kind: 'subagent', name: 'research' },
    ...call({ id: 'b', start: 140, end: 200, parent: 'sub1' }),
    { t: 'end', at: 210, id: 'sub1', status: 'ok' },
    { t: 'turn_end', at: 220, stopReason: 'stop' },
  ];

  it('sin `data.origin` el origen sale de la jerarquía: agente o subagente', () => {
    const steps = modelSteps(old);
    expect(steps.map(originOf)).toEqual(['agent', 'subagent']);
    expect(steps.some(isAuxiliaryCall)).toBe(false);
  });

  it('sin el cap, las auxiliares constan como no registradas, no como cero', () => {
    const model = modelOf(old);
    expect(tracksAuxiliaryCalls(model)).toBe(false);
    const llm = llmBreakdown(model, 300);
    expect(llm).toMatchObject({ auxiliaryTracked: false, calls: 2 });
    expect(llm.byOrigin.agent.calls).toBe(1);
    expect(llm.byOrigin.subagent.calls).toBe(1);
    expect(traceStats(model, 300).modelCalls).toBe(2);
  });

  it('una traza sin cabecera, o de un formato más nuevo con tipos desconocidos, se sigue leyendo', () => {
    const noMeta = old.slice(1);
    expect(tracksAuxiliaryCalls(modelOf(noMeta))).toBe(false);
    expect(modelSteps(noMeta)).toHaveLength(2);
    const future = [...old, { t: 'future_record', at: 500 } as unknown as TraceRecord];
    expect(modelSteps(future)).toHaveLength(2);
  });

  it('un origen que este lector no conoce cae al de la jerarquía', () => {
    const [step] = modelSteps([
      meta(NEW_CAPS),
      ...call({ id: 'x', start: 1, end: 2, origin: 'otra-cosa' }),
    ]);
    expect(originOf(step!)).toBe('agent');
  });

  it('reanudar con una versión nueva una traza antigua no la da por registrada entera', () => {
    const resumed = [...old, meta(NEW_CAPS), { t: 'turn', at: 900, input: 'sigue' } as TraceRecord];
    expect(tracksAuxiliaryCalls(modelOf(resumed))).toBe(false);
    expect(tracksAuxiliaryCalls(modelOf([meta(NEW_CAPS), meta(NEW_CAPS)]))).toBe(true);
  });
});

describe('reconstrucción — llamadas por origen', () => {
  /**
   * Un turno con compresión a mitad, un subagente, y la extracción de memoria
   * lanzada al cerrarse, que falla. Un segundo turno arranca con ella en vuelo.
   */
  const records: TraceRecord[] = [
    meta(NEW_CAPS),
    { t: 'turn', at: 1000, input: 'tarea' },
    ...call({
      id: 'a1',
      start: 1010,
      end: 1200,
      first: 1100,
      origin: 'agent',
      usage: { promptTokens: 1000, completionTokens: 50, cachedReadTokens: 0 },
    }),
    ...call({
      id: 'c1',
      start: 1210,
      end: 1500,
      first: 1300,
      origin: 'context-compression',
      usage: { promptTokens: 800, completionTokens: 100, cachedReadTokens: 0 },
    }),
    { t: 'point', at: 1505, id: 'cx', kind: 'context', name: 'Contexto comprimido' },
    ...call({
      id: 'a2',
      start: 1510,
      end: 1700,
      first: 1560,
      origin: 'agent',
      usage: { promptTokens: 400, completionTokens: 20, cachedReadTokens: 100 },
      prefix: { chars: 1000, sharedChars: 200, diverged: 'history' },
    }),
    { t: 'begin', at: 1710, id: 'sub1', kind: 'subagent', name: 'research' },
    ...call({
      id: 's1',
      start: 1720,
      end: 1800,
      first: 1750,
      origin: 'subagent',
      parent: 'sub1',
      usage: { promptTokens: 300, completionTokens: 10, cachedReadTokens: 0 },
    }),
    { t: 'end', at: 1810, id: 'sub1', status: 'ok' },
    { t: 'turn_end', at: 1900, stopReason: 'stop' },
    ...call({
      id: 'x1',
      start: 1900,
      end: 2600,
      origin: 'memory-extraction',
      status: 'error',
    }),
    { t: 'turn', at: 2000, input: 'otra' },
    ...call({
      id: 'a3',
      start: 2010,
      end: 2900,
      first: 2700,
      origin: 'agent',
      usage: { promptTokens: 500, completionTokens: 20, cachedReadTokens: 450 },
      prefix: { chars: 1200, sharedChars: 1100 },
    }),
    { t: 'turn_end', at: 2950, stopReason: 'stop' },
  ];
  // El `begin` de x1 va antes del segundo `turn`: pertenece al primero.
  records.sort((a, b) => a.at - b.at);
  const model = modelOf(records);

  it('reparte las llamadas por origen, con el total', () => {
    const llm = llmBreakdown(model, 3000);
    expect(llm.auxiliaryTracked).toBe(true);
    expect(llm.calls).toBe(6);
    expect(Object.fromEntries(LLM_CALL_ORIGINS.map((o) => [o, llm.byOrigin[o].calls]))).toEqual({
      agent: 3,
      subagent: 1,
      'memory-extraction': 1,
      'context-compression': 1,
      'session-summary': 0,
    });
    expect(llm.auxiliary.calls).toBe(2);
  });

  it('cada origen lleva sus tokens, su caché, su TTFT, su duración y sus errores', () => {
    const { byOrigin, auxiliary } = llmBreakdown(model, 3000);
    expect(byOrigin.agent).toMatchObject({
      calls: 3,
      errors: 0,
      promptTokens: 1900,
      completionTokens: 90,
      cachedReadTokens: 550,
      uncachedPromptTokens: 1350,
      durationMs: 190 + 190 + 890,
      ttftCalls: 3,
    });
    expect(byOrigin.agent.ttftMs).toBeCloseTo((90 + 50 + 690) / 3);
    expect(byOrigin.agent.cacheHitRate).toBeCloseTo(550 / 1900);
    expect(byOrigin['context-compression']).toMatchObject({
      calls: 1,
      promptTokens: 800,
      completionTokens: 100,
      cachedReadTokens: 0,
      ttftMs: 90,
      durationMs: 290,
    });
    // Falló sin llegar a responder: ni tokens ni TTFT, y no se inventan.
    expect(byOrigin['memory-extraction']).toMatchObject({
      calls: 1,
      errors: 1,
      promptTokens: null,
      cachedReadTokens: null,
      cacheHitRate: null,
      ttftMs: null,
      durationMs: 700,
    });
    expect(auxiliary).toMatchObject({ calls: 2, errors: 1, promptTokens: 800, durationMs: 990 });
  });

  it('la caché y las roturas del agente no mezclan las auxiliares', () => {
    const cache = cacheSummary(model)!;
    expect(cache.reportedCalls).toBe(4);
    expect(cache.promptTokens).toBe(2200);
    // a2 leyó más que a1 y a3 más que a2: la compresión intermedia no cuenta
    // como llamada de comparación, así que no hay rotura falsa por su prompt.
    expect(cacheBreaks(model)).toEqual([]);
    expect(traceStats(model, 3000).modelCalls).toBe(4);
  });

  it('una auxiliar se etiqueta por lo que es, no por su salida', () => {
    const byId = Object.fromEntries(model.steps.map((s) => [s.id, s]));
    expect(stepLabel(byId.c1!)).toBe('compresión de contexto');
    expect(stepLabel(byId.x1!)).toBe('extracción de memoria');
    expect(byId.x1!.turn).toBe(0);
  });

  it('la extracción lanzada tras el turno no alarga el tiempo activo', () => {
    // Turnos: 1000→1900 y 2000→2950. La extracción (hasta 2600) no cuenta.
    expect(traceStats(model, 3000).activeMs).toBe(900 + 950);
  });

  it('relación temporal: en curso al empezar, espera solapada y justo antes', () => {
    const overlaps = auxiliaryOverlaps(model, 3000);
    // a2 arranca justo después de la compresión (1210→1500): la precede, no la solapa.
    expect(overlaps.get('a2')).toEqual({
      activeAtStart: 0,
      overlappingAuxiliaryMs: 0,
      precedingAuxiliaryMs: 290,
    });
    // a3 arranca con la extracción en vuelo (1900→2600) y espera hasta 2700.
    expect(overlaps.get('a3')).toEqual({
      activeAtStart: 1,
      overlappingAuxiliaryMs: 2600 - 2010,
      precedingAuxiliaryMs: 0,
    });
    expect(overlaps.get('a1')).toEqual({
      activeAtStart: 0,
      overlappingAuxiliaryMs: 0,
      precedingAuxiliaryMs: 0,
    });
    // Las auxiliares no tienen entrada: se mide el loop frente a ellas.
    expect(overlaps.has('c1')).toBe(false);

    const impact = auxiliaryImpact(model, 3000);
    expect(impact).toMatchObject({
      overlappedCalls: 1,
      overlappingAuxiliaryMs: 590,
      precedingAuxiliaryMs: 290,
      ttftOverlappedMs: 690,
      ttftOverlappedCalls: 1,
      ttftClearCalls: 3,
    });
    expect(impact.ttftClearMs).toBeCloseTo((90 + 50 + 30) / 3);
  });

  it('dos auxiliares solapadas no cuentan dos veces la misma espera', () => {
    const overlapping: TraceRecord[] = [
      meta(NEW_CAPS),
      { t: 'turn', at: 0, input: 't' },
      ...call({ id: 'x', start: 10, end: 100, origin: 'memory-extraction' }),
      ...call({ id: 'y', start: 50, end: 150, origin: 'session-summary' }),
      ...call({ id: 'a', start: 60, end: 400, first: 300, origin: 'agent' }),
    ];
    const m = modelOf(overlapping.sort((p, q) => p.at - q.at));
    expect(auxiliaryOverlaps(m, 500).get('a')).toMatchObject({
      activeAtStart: 2,
      overlappingAuxiliaryMs: 90,
    });
  });

  it('una auxiliar todavía abierta cuenta hasta ahora', () => {
    const m = modelOf([
      meta(NEW_CAPS),
      { t: 'turn', at: 0, input: 't' },
      ...call({ id: 'x', start: 10, end: null, origin: 'memory-extraction' }),
      ...call({ id: 'a', start: 20, end: 200, first: 120, origin: 'agent' }),
    ]);
    expect(auxiliaryOverlaps(m, 1000).get('a')).toMatchObject({
      activeAtStart: 1,
      overlappingAuxiliaryMs: 100,
    });
    expect(llmBreakdown(m, 1000).byOrigin['memory-extraction'].durationMs).toBe(990);
  });
});
