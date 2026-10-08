import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { Message } from '../agent/types.js';
import { TraceRecorder } from './recorder.js';
import type { TraceRecord } from './records.js';
import {
  applyRecords,
  cacheBreaks,
  cacheSummary,
  cacheTemperature,
  emptyTrace,
  prefixOf,
  prefixStability,
  traceStats,
  usageOf,
  type TraceModel,
} from './model.js';
import { VIEWER_PAGE } from './viewer-page.js';

// ---------------------------------------------------------------------------
// Modelo puro: trazas sintéticas
// ---------------------------------------------------------------------------

interface Call {
  /** [prompt, cachedRead]; cachedRead undefined = el backend no lo reporta. */
  usage?: [number, number?];
  legacyCached?: number;
  write?: number;
  prefix?: Record<string, unknown>;
  ttft?: number;
  model?: string;
  provider?: string;
  parent?: string;
  compressedBefore?: boolean;
}

function modelOf(calls: Call[]): TraceModel {
  const records: TraceRecord[] = [{ t: 'meta', v: 1, at: 0, sessionId: 's' }];
  let at = 1000;
  records.push({ t: 'turn', at, input: 'tarea' });
  calls.forEach((c, i) => {
    const id = `m${i}`;
    if (c.compressedBefore) {
      records.push({
        t: 'point',
        at: ++at,
        id: `c${i}`,
        kind: 'context',
        name: 'Contexto comprimido',
        ...(c.parent ? { parent: c.parent } : {}),
      });
    }
    records.push({
      t: 'begin',
      at: (at += 10),
      id,
      kind: 'model',
      name: c.model ?? 'test-model',
      ...(c.parent ? { parent: c.parent } : {}),
      data: {
        ...(c.provider ? { provider: c.provider } : {}),
        ...(c.prefix ? { prefix: c.prefix } : {}),
      },
    });
    if (c.ttft !== undefined) records.push({ t: 'mark', at: at + c.ttft, id, name: 'first_token' });
    const usage = c.usage
      ? {
          promptTokens: c.usage[0],
          completionTokens: 10,
          totalTokens: c.usage[0] + 10,
          ...(c.usage[1] !== undefined ? { cachedReadTokens: c.usage[1] } : {}),
          ...(c.legacyCached !== undefined ? { cachedTokens: c.legacyCached } : {}),
          ...(c.write !== undefined ? { cacheWriteTokens: c.write } : {}),
        }
      : undefined;
    records.push({
      t: 'end',
      at: (at += (c.ttft ?? 0) + 50),
      id,
      status: 'ok',
      data: usage ? { usage } : {},
    });
  });
  records.push({ t: 'turn_end', at: ++at, stopReason: 'stop' });
  return applyRecords(emptyTrace(), records);
}

const stable = (chars: number, sharedChars?: number): Record<string, unknown> => ({
  chars,
  tools: 'aaaaaaaa',
  system: 'bbbbbbbb',
  ...(sharedChars !== undefined ? { sharedChars, prevMessages: 2 } : {}),
});

describe('uso de caché de una llamada', () => {
  it('deriva lo no cacheado y el acierto, y distingue fría de templada', () => {
    const model = modelOf([{ usage: [1000, 0] }, { usage: [1200, 900] }]);
    expect(usageOf(model.steps[1]!)).toMatchObject({
      cachedReadTokens: 0,
      uncachedPromptTokens: 1000,
      cacheHitRate: 0,
    });
    expect(usageOf(model.steps[2]!)).toMatchObject({
      cachedReadTokens: 900,
      uncachedPromptTokens: 300,
      cacheHitRate: 0.75,
    });
    expect(cacheTemperature(model.steps[1]!)).toBe('cold');
    expect(cacheTemperature(model.steps[2]!)).toBe('warm');
  });

  it('lee el campo cachedTokens de las trazas anteriores', () => {
    const model = modelOf([{ usage: [1000], legacyCached: 400 }]);
    expect(usageOf(model.steps[1]!)).toMatchObject({ cachedReadTokens: 400, cacheHitRate: 0.4 });
  });

  it('sin dato del backend no hay temperatura ni derivados: no se estima', () => {
    const model = modelOf([{ usage: [1000] }, { usage: [1200] }]);
    const usage = usageOf(model.steps[2]!);
    expect(usage).toEqual({ promptTokens: 1200, completionTokens: 10, totalTokens: 1210 });
    expect(cacheTemperature(model.steps[2]!)).toBeNull();
    expect(cacheSummary(model)).toBeNull();
    expect(cacheBreaks(model)).toEqual([]);
    const stats = traceStats(model, 0);
    expect(stats.cacheHit).toBeNull();
    expect(stats.cache).toBeNull();
    expect(stats.totalTokens).toBe(2220);
  });
});

describe('cacheSummary', () => {
  it('suma solo las llamadas que reportaron caché', () => {
    const model = modelOf([
      { usage: [1000, 0], ttft: 300 },
      { usage: [1200, 1000], ttft: 20 },
      { usage: [1400, 1200], ttft: 40 },
      { usage: [9000] },
    ]);
    expect(cacheSummary(model)).toEqual({
      reportedCalls: 3,
      promptTokens: 3600,
      cachedReadTokens: 2200,
      cacheWriteTokens: null,
      uncachedPromptTokens: 1400,
      hitRate: 2200 / 3600,
      coldCalls: 1,
      warmCalls: 2,
      ttftColdMs: 300,
      ttftWarmMs: 30,
      breaks: 0,
    });
  });

  it('una sesión entera en frío da acierto 0, no «sin datos»', () => {
    const summary = cacheSummary(modelOf([{ usage: [1000, 0] }, { usage: [1100, 0] }]));
    expect(summary).toMatchObject({ hitRate: 0, coldCalls: 2, warmCalls: 0, cachedReadTokens: 0 });
    expect(traceStats(modelOf([{ usage: [1000, 0] }]), 0).cacheHit).toBe(0);
  });

  it('las escrituras solo cuentan si alguna llamada las reportó', () => {
    const summary = cacheSummary(
      modelOf([
        { usage: [1000, 0], write: 900 },
        { usage: [1200, 900], write: 200 },
      ]),
    );
    expect(summary?.cacheWriteTokens).toBe(1100);
  });
});

describe('cacheBreaks', () => {
  it('una conversación que solo crece no rompe nada', () => {
    const model = modelOf([
      { usage: [1000, 0], prefix: stable(4000) },
      { usage: [1200, 1000], prefix: stable(4800, 4000) },
      { usage: [1500, 1200], prefix: stable(6000, 4800) },
    ]);
    expect(cacheBreaks(model)).toEqual([]);
  });

  it('atribuye la rotura a lo que cambió en el prompt', () => {
    const base = { usage: [1000, 0] as [number, number], prefix: stable(4000) };
    const warm = { usage: [1200, 1000] as [number, number], prefix: stable(4800, 4000) };
    const broken = (prefix: Record<string, unknown>, more: Partial<Call> = {}): Call => ({
      usage: [1300, 300],
      prefix: { ...stable(5200, 1200), ...prefix },
      ...more,
    });
    const cause = (call: Call): string[] =>
      cacheBreaks(modelOf([base, warm, call])).map((b) => b.cause);

    expect(cause(broken({ diverged: 'tools' }))).toEqual(['tools']);
    expect(cause(broken({ diverged: 'system', divergedAt: 0 }))).toEqual(['system']);
    expect(cause(broken({ diverged: 'history', divergedAt: 2 }))).toEqual(['history']);
    expect(
      cause(broken({ diverged: 'history', divergedAt: 2 }, { compressedBefore: true })),
    ).toEqual(['compression']);
    // El prompt solo creció y aun así se reutilizó menos: fue el backend.
    expect(cause({ usage: [1300, 300], prefix: stable(5200, 4800) })).toEqual(['backend']);
    expect(cause(broken({}, { model: 'otro-modelo' }))).toEqual(['model']);
  });

  it('una reescritura cuenta aunque el backend no reutilice menos que antes', () => {
    // Tras comprimir se reutiliza lo mismo que en la llamada anterior, pero no
    // el prompt anterior entero: es lo que una compresión temprana deja ver.
    const model = modelOf([
      { usage: [1000, 0], prefix: stable(4000) },
      { usage: [2000, 1000], prefix: stable(8000, 4000) },
      {
        usage: [1500, 1005],
        prefix: { ...stable(6000, 4020), diverged: 'history', divergedAt: 2 },
        compressedBefore: true,
      },
    ]);
    expect(cacheBreaks(model)).toEqual([
      { id: 'm2', n: 5, turn: 0, cause: 'compression', cachedBefore: 1000, cachedAfter: 1005 },
    ]);
    expect(cacheSummary(model)?.breaks).toBe(1);
  });

  it('cada agente se compara consigo mismo: un subagente no rompe la caché del padre', () => {
    const model = modelOf([
      { usage: [5000, 0], prefix: stable(20000) },
      { usage: [5200, 5000], prefix: stable(20800, 20000) },
      { usage: [2000, 800], prefix: stable(8000), parent: 'sub_1' },
      { usage: [2200, 2000], prefix: stable(8800, 8000), parent: 'sub_1' },
      { usage: [5400, 5200], prefix: stable(21600, 20800) },
    ]);
    expect(cacheBreaks(model)).toEqual([]);
  });

  it('la primera llamada de otro proceso (sesión reanudada) no es una rotura', () => {
    const model = modelOf([
      { usage: [1000, 0], prefix: stable(4000) },
      { usage: [1200, 1000], prefix: stable(4800, 4000) },
      // Reanudada: tiene `prefix` pero no con qué compararse.
      { usage: [1300, 0], prefix: stable(5200) },
    ]);
    expect(cacheBreaks(model)).toEqual([]);
  });

  it('en una traza anterior a `prefix` la causa queda como no registrada', () => {
    const model = modelOf([{ usage: [1000, 0] }, { usage: [1200, 1000] }, { usage: [1300, 200] }]);
    expect(cacheBreaks(model).map((b) => b.cause)).toEqual(['unknown']);
  });

  it('una llamada sin dato de caché ni rompe ni corta la comparación', () => {
    const model = modelOf([
      { usage: [1000, 0], prefix: stable(4000) },
      { usage: [1200, 1000], prefix: stable(4800, 4000) },
      { usage: [1300], prefix: stable(5200, 4800) },
      { usage: [1400, 1300], prefix: stable(5600, 5200) },
    ]);
    expect(cacheBreaks(model)).toEqual([]);
  });
});

describe('prefixStability', () => {
  it('fracción del prompt que repite el de la llamada anterior', () => {
    const model = modelOf([
      { prefix: stable(4000) },
      { prefix: stable(5000, 4000) },
      { prefix: stable(5000, 1000) },
    ]);
    expect(prefixStability(model)).toBe(0.5);
    expect(prefixOf(model.steps[2]!)).toMatchObject({ chars: 5000, sharedChars: 4000 });
  });

  it('null si ninguna llamada tiene con qué compararse (o la traza no lo registra)', () => {
    expect(prefixStability(modelOf([{ prefix: stable(4000) }]))).toBeNull();
    expect(prefixStability(modelOf([{ usage: [10, 0] }, { usage: [10, 0] }]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Recorder: lo que llega al disco
// ---------------------------------------------------------------------------

let dir: string;
let config: StratumConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-trace-cache-'));
  config = StratumConfigSchema.parse({ trace: { dir } });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [
  {
    type: 'function',
    function: { name: 'read_file', description: 'Reads a file', parameters: {} },
  },
  { type: 'function', function: { name: 'grep', description: 'Searches', parameters: {} } },
];

async function record(
  calls: Array<{
    messages: Message[];
    tools?: unknown[];
    usage?: Record<string, unknown>;
    timings?: Record<string, unknown>;
  }>,
): Promise<{ records: TraceRecord[]; text: string; model: TraceModel }> {
  const file = join(dir, 'sess.jsonl');
  const rec = new TraceRecorder({ file, sessionId: 'sess', config });
  const scope = rec.scope();
  scope.turnStart('tarea', calls[0]!.messages);
  calls.forEach((c, i) => {
    const tools = c.tools ?? TOOLS;
    const span = scope.modelStart({
      iteration: i,
      model: 'm',
      messages: c.messages,
      tools: tools.length,
      toolSchemas: tools,
    });
    span.firstChunk();
    span.usage(c.usage, c.timings);
    span.end({ text: 'ok', reasoning: '', toolCalls: [] });
  });
  scope.turnEnd('stop');
  await rec.flush();
  const text = readFileSync(file, 'utf8');
  const records = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceRecord);
  return { records, text, model: applyRecords(emptyTrace(), records) };
}

const SYSTEM: Message = { role: 'system', content: 'SYSTEM-PROMPT '.repeat(50) };
const USER: Message = { role: 'user', content: 'lee el fichero secreto-de-prueba' };
const ASSISTANT: Message = { role: 'assistant', content: 'voy a leerlo' };
const TOOL_RESULT: Message = { role: 'user', content: 'resultado de la lectura' };

const modelSteps = (model: TraceModel) => model.steps.filter((s) => s.kind === 'model');

describe('TraceRecorder — uso normalizado', () => {
  it('guarda la caché en la forma común y conserva el nombre antiguo', async () => {
    const { records } = await record([
      {
        messages: [SYSTEM, USER],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 20,
          total_tokens: 2020,
          prompt_tokens_details: { cached_tokens: 1500 },
        },
      },
    ]);
    const end = records.find((r) => r.t === 'end');
    expect(end && 'data' in end && end.data?.usage).toEqual({
      promptTokens: 2000,
      completionTokens: 20,
      totalTokens: 2020,
      cachedReadTokens: 1500,
      cachedTokens: 1500,
    });
  });

  it('un backend sin dato de caché no deja ninguno de los dos campos', async () => {
    const { records } = await record([
      { messages: [SYSTEM, USER], usage: { prompt_tokens: 2000, completion_tokens: 20 } },
    ]);
    const end = records.find((r) => r.t === 'end');
    const usage = (end && 'data' in end ? end.data?.usage : {}) as Record<string, unknown>;
    expect(usage).not.toHaveProperty('cachedReadTokens');
    expect(usage).not.toHaveProperty('cachedTokens');
  });

  it('Anthropic vía pasarela y los timings de llama.cpp', async () => {
    const { model } = await record([
      {
        messages: [SYSTEM, USER],
        usage: {
          prompt_tokens: 3000,
          completion_tokens: 5,
          cache_read_input_tokens: 2500,
          cache_creation_input_tokens: 400,
        },
      },
      {
        messages: [SYSTEM, USER, ASSISTANT],
        usage: { prompt_tokens: 3100, completion_tokens: 5 },
        timings: { cache_n: 3000, prompt_n: 100 },
      },
    ]);
    const [first, second] = modelSteps(model);
    expect(usageOf(first!)).toMatchObject({ cachedReadTokens: 2500, cacheWriteTokens: 400 });
    expect(usageOf(second!)).toMatchObject({ cachedReadTokens: 3000, uncachedPromptTokens: 100 });
  });
});

describe('TraceRecorder — prefijo del prompt', () => {
  it('una conversación que crece repite el prompt anterior entero', async () => {
    const { model } = await record([
      { messages: [SYSTEM, USER] },
      { messages: [SYSTEM, USER, ASSISTANT, TOOL_RESULT] },
    ]);
    const [first, second] = modelSteps(model).map((s) => prefixOf(s)!);
    expect(first!.sharedChars).toBeUndefined();
    expect(first!.tools).toMatch(/^[0-9a-f]{8}$/);
    expect(first!.system).toMatch(/^[0-9a-f]{8}$/);
    expect(second!.sharedChars).toBe(first!.chars);
    expect(second!.diverged).toBeUndefined();
    expect(second!.system).toBe(first!.system);
    expect(second!.tools).toBe(first!.tools);
    expect(prefixStability(model)).toBe(first!.chars / second!.chars);
  });

  it('un cambio al final del system prompt conserva lo anterior y pierde la conversación', async () => {
    const edited: Message = { role: 'system', content: `${SYSTEM.content}\n\n# Open tasks\n- a` };
    const { model } = await record([
      { messages: [SYSTEM, USER, ASSISTANT] },
      { messages: [edited, USER, ASSISTANT, TOOL_RESULT] },
    ]);
    const [first, second] = modelSteps(model).map((s) => prefixOf(s)!);
    expect(second).toMatchObject({ diverged: 'system', divergedAt: 0 });
    expect(second!.system).not.toBe(first!.system);
    // Se comparte el system hasta donde cambió, y nada de lo que va detrás.
    expect(second!.sharedChars).toBeGreaterThan(SYSTEM.content!.length);
    expect(second!.sharedChars).toBeLessThan(first!.chars);
  });

  it('un historial reescrito diverge en el mensaje que cambió', async () => {
    const summarized: Message = { role: 'assistant', content: '<summary>…</summary>' };
    const { model } = await record([
      { messages: [SYSTEM, USER, ASSISTANT, TOOL_RESULT] },
      { messages: [SYSTEM, USER, summarized] },
    ]);
    expect(prefixOf(modelSteps(model)[1]!)).toMatchObject({ diverged: 'history', divergedAt: 2 });
  });

  it('otro orden de tools diverge en las tools: nada de lo que sigue se comparte', async () => {
    const { model } = await record([
      { messages: [SYSTEM, USER] },
      { messages: [SYSTEM, USER, ASSISTANT], tools: [...TOOLS].reverse() },
    ]);
    const [first, second] = modelSteps(model).map((s) => prefixOf(s)!);
    expect(second!.diverged).toBe('tools');
    expect(second!.tools).not.toBe(first!.tools);
    expect(second!.sharedChars).toBeLessThan(JSON.stringify(TOOLS).length);
  });

  it('cada subagente tiene su propia referencia', async () => {
    const file = join(dir, 'sub.jsonl');
    const rec = new TraceRecorder({ file, sessionId: 'sub', config });
    const scope = rec.scope();
    const start = (s: typeof scope, messages: Message[]): void =>
      s
        .modelStart({ iteration: 0, model: 'm', messages, tools: 0, toolSchemas: [] })
        .end({ text: '', reasoning: '', toolCalls: [] });
    scope.turnStart('t', [SYSTEM, USER]);
    start(scope, [SYSTEM, USER]);
    scope.event({ type: 'subagent_started', subagentId: 'sub_1', profile: 'code', task: 't' });
    start(scope.child('sub_1'), [{ role: 'system', content: 'child' }, USER]);
    start(scope, [SYSTEM, USER, ASSISTANT]);
    await rec.flush();
    const model = applyRecords(
      emptyTrace(),
      readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TraceRecord),
    );
    const [parent1, child, parent2] = modelSteps(model).map((s) => prefixOf(s)!);
    expect(child!.sharedChars).toBeUndefined();
    expect(parent2!.sharedChars).toBe(parent1!.chars);
  });

  it('a la traza va el recuento, nunca el texto del prompt', async () => {
    const { records, text } = await record([
      { messages: [SYSTEM, USER] },
      { messages: [SYSTEM, USER, ASSISTANT] },
    ]);
    for (const r of records) {
      if (r.t !== 'begin' || r.kind !== 'model') continue;
      const prefix = r.data?.prefix as Record<string, unknown>;
      for (const value of Object.values(prefix)) {
        expect(
          typeof value === 'number' || /^[0-9a-f]{8}$|^(tools|system|history)$/.test(String(value)),
        ).toBe(true);
      }
    }
    // Las definiciones de tools no se escriben en ningún registro.
    expect(text).not.toContain('Reads a file');
  });
});

describe('página del visor', () => {
  it('lleva el desglose de caché y sigue siendo un String.raw válido', () => {
    expect(VIEWER_PAGE).toContain('Acierto de caché');
    expect(VIEWER_PAGE).toContain('cachedReadTokens');
    expect(VIEWER_PAGE).toContain('cachedTokens');
    expect(VIEWER_PAGE).toContain('Rotura de caché');
  });
});
