import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import type { DestructiveDecision, ToolContext, ToolDefinition } from '../agent/types.js';
import { ToolDispatcher, ToolRegistry } from '../tools/registry.js';
import { streamWithRetry } from '../providers/retry.js';
import { ProviderError } from '../providers/errors.js';
import type { IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { buildTraceModel, computeMetrics } from '../eval/metrics.js';
import { TraceRecorder, type TraceScope } from './recorder.js';
import { readTraceFile } from './read.js';
import type { TraceRuntimeEvent } from './records.js';

/**
 * Decisiones del runtime en la traza: confirmaciones, vetos y reintentos no son
 * `AgentEvent`, así que las anotan el dispatcher y el loop directamente.
 */

let dir: string;
let config: StratumConfig;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stratum-rt-'));
  config = StratumConfigSchema.parse({ trace: { dir } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Scope que solo recoge los eventos de runtime. */
function capture(): { scope: TraceScope; events: TraceRuntimeEvent[] } {
  const events: TraceRuntimeEvent[] = [];
  const scope: TraceScope = {
    turnStart: () => {},
    turnEnd: () => {},
    modelStart: () => ({ firstChunk: () => {}, usage: () => {}, end: () => {} }),
    event: () => {},
    runtime: (ev) => void events.push(ev),
    child: () => scope,
  };
  return { scope, events };
}

const tool = (over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: 'nuke',
  description: 'test tool',
  schema: z.object({ target: z.string() }),
  execute: async () => ({ ok: true, output: 'done' }),
  ...over,
});

function dispatcherWith(def: ToolDefinition): ToolDispatcher {
  const registry = new ToolRegistry();
  registry.register(def);
  return new ToolDispatcher(registry);
}

const ctx = (scope: TraceScope, over: Partial<ToolContext> = {}): ToolContext => ({
  signal: new AbortController().signal,
  cwd: process.cwd(),
  config,
  trace: scope,
  ...over,
});

const call = {
  type: 'tool_call_ready' as const,
  id: 'call_1',
  name: 'nuke',
  input: { target: 'x' },
};

describe('el dispatcher anota confirmaciones y vetos', () => {
  it.each<[DestructiveDecision, string]>([
    ['approve', 'approved'],
    ['allow-all', 'allow-all'],
    ['deny', 'denied'],
  ])('confirmación contestada con %s → %s', async (answer, decision) => {
    const { scope, events } = capture();
    await dispatcherWith(tool({ destructive: true })).dispatch(
      [call],
      ctx(scope, { destructivePolicy: 'ask', confirmDestructive: async () => answer }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'confirmation',
      decision,
      tool: 'nuke',
      callId: 'call_1',
    });
  });

  it('sin nadie que pueda contestar la confirmación queda `blocked`', async () => {
    const { scope, events } = capture();
    const [res] = await dispatcherWith(tool({ destructive: true })).dispatch(
      [call],
      ctx(scope, { destructivePolicy: 'deny' }),
    );
    expect(res!.result.ok).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({ event: 'confirmation', decision: 'blocked' }),
    ]);
  });

  it('con --allow-destructive no se pregunta y no se anota nada', async () => {
    const { scope, events } = capture();
    await dispatcherWith(tool({ destructive: true })).dispatch(
      [call],
      ctx(scope, { destructivePolicy: 'allow' }),
    );
    expect(events).toEqual([]);
  });

  it('un veto de preflight se anota con su motivo y sin confirmación', async () => {
    const { scope, events } = capture();
    const def = tool({
      destructive: true,
      preflight: () => ({ ok: false, error: 'nunca', recoverable: true }),
    });
    await dispatcherWith(def).dispatch(
      [call],
      ctx(scope, { destructivePolicy: 'ask', confirmDestructive: async () => 'approve' }),
    );
    expect(events).toEqual([
      { event: 'veto', source: 'preflight', tool: 'nuke', callId: 'call_1', reason: 'nunca' },
    ]);
  });

  it('una sesión read-only veta con source `read-only`', async () => {
    const { scope, events } = capture();
    await dispatcherWith(tool()).dispatch([call], ctx(scope, { readOnly: true }));
    expect(events).toEqual([expect.objectContaining({ event: 'veto', source: 'read-only' })]);
  });

  it('sin traza en el contexto el dispatcher funciona igual', async () => {
    const [res] = await dispatcherWith(tool()).dispatch([call], {
      signal: new AbortController().signal,
      cwd: process.cwd(),
      config,
    });
    expect(res!.result.ok).toBe(true);
  });
});

describe('streamWithRetry avisa de cada reintento', () => {
  it('llama a onRetry con el intento y el error anterior', async () => {
    let calls = 0;
    const provider: IProvider = {
      async *complete(): AsyncGenerator<OpenAIStreamChunk> {
        if (calls++ < 2) {
          throw new ProviderError('boom', 'http', true, { status: 500 });
        }
        yield { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
      },
      healthCheck: async () => true,
    };
    const seen: Array<[number, string]> = [];
    const chunks: OpenAIStreamChunk[] = [];
    for await (const c of streamWithRetry(
      provider,
      { messages: [], stream: true, model: 'm' },
      { baseDelayMs: 1, onRetry: (n, err) => seen.push([n, (err as Error).message]) },
    )) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(1);
    expect(seen).toEqual([
      [1, 'boom'],
      [2, 'boom'],
    ]);
  });
});

describe('el recorder los guarda como puntos `notice` y declara el cap', () => {
  it('formato en disco, redacción y lectura como métricas', async () => {
    const file = join(dir, 's1.jsonl');
    const rec = new TraceRecorder({ file, sessionId: 's1', config });
    const scope = rec.scope();
    scope.turnStart('tarea', [{ role: 'user', content: 'tarea' }]);
    scope.runtime({ event: 'retry', attempt: 1, error: 'HTTP 500' });
    scope.runtime({
      event: 'veto',
      source: 'preflight',
      tool: 'exec',
      callId: 'c1',
      reason: 'usa la key sk-proj-abcdefghij0123456789abcdefghij0123456789',
    });
    scope.runtime({
      event: 'confirmation',
      decision: 'denied',
      tool: 'exec',
      callId: 'c2',
      description: 'exec: rm x',
      environment: 'prod',
      forced: true,
    });
    scope
      .child('sub1')
      .runtime({ event: 'veto', source: 'toolset', tool: 'x', callId: 'c3', reason: 'r' });
    scope.turnEnd('stop');
    await rec.flush();

    const records = readTraceFile(file);
    expect(records[0]).toMatchObject({ t: 'meta', caps: ['runtime'] });
    const points = records.filter((r) => r.t === 'point' && r.kind === 'notice');
    expect(points).toHaveLength(4);
    expect(JSON.stringify(points)).not.toContain('sk-proj-abcdefghij');
    expect(points[3]).toMatchObject({ parent: 'sub1' });

    // El visor los pinta como avisos; el modelo los conserva con sus datos.
    const model = buildTraceModel(records);
    expect(model.steps.filter((s) => s.data.event === 'veto')).toHaveLength(2);
    expect(computeMetrics(records)).toMatchObject({
      retries: 1,
      policyBlocks: 3,
      confirmations: { asked: 1, approved: 0, denied: 1, blocked: 0 },
      warnings: 0,
    });
  });
});
