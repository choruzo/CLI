import { describe, expect, it } from 'vitest';
import type { TraceRecord } from '../trace/records.js';
import { buildTraceModel, computeMetrics, countRepeatedCalls, turnOutcomes } from './metrics.js';
import { aggregateStats } from './stats.js';

/** Constructor de trazas sintéticas: cada helper añade registros con un reloj que avanza. */
function trace(opts: { runtime?: boolean } = {}) {
  const records: TraceRecord[] = [];
  let at = 1000;
  let seq = 0;
  const tick = (ms = 10): number => (at += ms);
  records.push({
    t: 'meta',
    v: 1,
    at,
    sessionId: 's1',
    ...(opts.runtime === false ? {} : { caps: ['runtime'] }),
  });
  const api = {
    records,
    turn(input = 'tarea') {
      records.push({ t: 'turn', at: tick(), input });
      return api;
    },
    end(stopReason = 'stop') {
      records.push({ t: 'turn_end', at: tick(), stopReason });
      return api;
    },
    model(o: { tokens?: [number, number]; error?: string; ms?: number; parent?: string } = {}) {
      const id = `m${++seq}`;
      records.push({
        t: 'begin',
        at: tick(),
        id,
        kind: 'model',
        name: 'test-model',
        ...(o.parent ? { parent: o.parent } : {}),
      });
      records.push({
        t: 'end',
        at: tick(o.ms ?? 100),
        id,
        status: o.error ? 'error' : 'ok',
        data: {
          ...(o.tokens
            ? {
                usage: {
                  promptTokens: o.tokens[0],
                  completionTokens: o.tokens[1],
                  totalTokens: o.tokens[0] + o.tokens[1],
                },
              }
            : {}),
          ...(o.error ? { error: o.error } : {}),
        },
      });
      return api;
    },
    tool(
      name: string,
      input: unknown,
      o: { error?: string; executed?: boolean; callId?: string; parent?: string } = {},
    ) {
      const id = `t${++seq}`;
      records.push({
        t: 'begin',
        at: tick(),
        id,
        kind: 'tool',
        name,
        ...(o.parent ? { parent: o.parent } : {}),
        data: { callId: o.callId ?? id, input },
      });
      records.push({
        t: 'end',
        at: tick(20),
        id,
        status: o.error ? 'error' : 'ok',
        data: o.error
          ? { error: o.error, ...(o.executed ? { executed: true } : {}) }
          : { output: 'ok' },
      });
      return api;
    },
    notice(data: Record<string, unknown>, status?: 'error') {
      records.push({
        t: 'point',
        at: tick(),
        id: `n${++seq}`,
        kind: 'notice',
        name: 'aviso',
        data,
        ...(status ? { status } : {}),
      });
      return api;
    },
    subagent(id: string, status: 'ok' | 'error' = 'ok') {
      records.push({ t: 'begin', at: tick(), id, kind: 'subagent', name: 'general' });
      return {
        close() {
          records.push({ t: 'end', at: tick(), id, status });
          return api;
        },
      };
    },
  };
  return api;
}

describe('computeMetrics', () => {
  it('cuenta llamadas, tokens y duración activa a partir de la traza', () => {
    const t = trace()
      .turn()
      .model({ tokens: [100, 20] })
      .tool('read_file', { path: 'a' })
      .model({ tokens: [150, 30] })
      .end();
    const m = computeMetrics(t.records);
    expect(m).toMatchObject({
      turns: 1,
      llmCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      tokens: 300,
      promptTokens: 250,
      completionTokens: 50,
      stopReason: 'stop',
      hadErrors: false,
    });
    expect(m.durationMs).toBeGreaterThan(0);
  });

  it('no estima tokens: sin usage en ninguna llamada son null', () => {
    const m = computeMetrics(trace().turn().model().end().records);
    expect(m.tokens).toBeNull();
    expect(m.promptTokens).toBeNull();
  });

  it('un bloqueo del runtime no es un error de la tool', () => {
    const t = trace()
      .turn()
      .model()
      .notice({ event: 'veto', source: 'preflight', tool: 'exec', callId: 'c1', reason: 'no' })
      .tool('exec', { command: 'rm -rf /' }, { error: 'blocked', callId: 'c1' })
      .tool('exec', { command: 'false' }, { error: 'exit 1', executed: true, callId: 'c2' })
      .end();
    const m = computeMetrics(t.records);
    expect(m.toolCalls).toBe(2);
    expect(m.toolErrors).toBe(1);
    expect(m.policyBlocks).toBe(1);
    expect(m.hadErrors).toBe(true);
  });

  it('separa las confirmaciones aprobadas de las denegadas y las bloqueadas', () => {
    const conf = (decision: string, callId: string) => ({
      event: 'confirmation',
      decision,
      tool: 'exec',
      callId,
      description: 'x',
    });
    const t = trace()
      .turn()
      .notice(conf('approved', 'a'))
      .tool('exec', {}, { callId: 'a' })
      .notice(conf('denied', 'b'))
      .tool('exec', {}, { error: 'denied', callId: 'b' })
      .notice(conf('blocked', 'c'))
      .tool('exec', {}, { error: 'blocked', callId: 'c' })
      .end();
    const m = computeMetrics(t.records);
    expect(m.confirmations).toEqual({ asked: 3, approved: 1, denied: 1, blocked: 1 });
    expect(m.policyBlocks).toBe(2);
    expect(m.toolErrors).toBe(0);
  });

  it('una traza anterior al cap `runtime` da n/d, no ceros', () => {
    const t = trace({ runtime: false }).turn().model().tool('exec', {}).end();
    const m = computeMetrics(t.records);
    expect(m.policyBlocks).toBeNull();
    expect(m.confirmations).toBeNull();
    expect(m.retries).toBeNull();
  });

  it('cuenta reintentos, fallbacks, avisos, errores fatales y subagentes', () => {
    const t = trace()
      .turn()
      .notice({ event: 'retry', attempt: 1, error: '500' })
      .notice({ message: 'provider_fallback: "a" no respondió' })
      .notice({ message: 'large_change: 500 líneas' })
      .model({ error: 'boom' })
      .notice({ message: 'boom', fatal: true }, 'error');
    t.subagent('sub1', 'error').close();
    t.end('error');
    const m = computeMetrics(t.records);
    expect(m).toMatchObject({
      retries: 1,
      providerFallbacks: 1,
      warnings: 2,
      fatalErrors: 1,
      llmErrors: 1,
      subagents: 1,
      subagentFailures: 1,
      stopReason: 'error',
      hadErrors: true,
    });
  });
});

describe('countRepeatedCalls', () => {
  const repeated = (t: ReturnType<typeof trace>): number =>
    countRepeatedCalls(buildTraceModel(t.records));

  it('releer lo mismo dos veces seguidas cuenta', () => {
    expect(
      repeated(
        trace().turn().tool('read_file', { path: 'a' }).tool('read_file', { path: 'a' }).end(),
      ),
    ).toBe(1);
  });

  it('releer tras una edición no cuenta', () => {
    const t = trace()
      .turn()
      .tool('read_file', { path: 'a' })
      .tool('edit_file', { path: 'a', old_string: 'x', new_string: 'y' })
      .tool('read_file', { path: 'a' })
      .end();
    expect(repeated(t)).toBe(0);
  });

  it('relanzar tal cual el comando que acaba de fallar cuenta', () => {
    const t = trace()
      .turn()
      .tool('exec', { command: 'node build.js' }, { error: 'exit 2', executed: true })
      .tool('exec', { command: 'node build.js' }, { error: 'exit 2', executed: true })
      .end();
    expect(repeated(t)).toBe(1);
  });

  it('el mismo comando tras arreglar la causa no cuenta', () => {
    const t = trace()
      .turn()
      .tool('exec', { command: 'node build.js' }, { error: 'exit 2', executed: true })
      .tool('write_file', { path: 'input.txt', content: 'x' })
      .tool('exec', { command: 'node build.js' })
      .end();
    expect(repeated(t)).toBe(0);
  });

  it('el orden de las claves de los argumentos no importa, y cada agente se cuenta aparte', () => {
    const t = trace().turn();
    t.tool('grep', { pattern: 'a', cwd: '.' }).tool('grep', { cwd: '.', pattern: 'a' });
    t.subagent('sub1');
    t.tool('grep', { pattern: 'a', cwd: '.' }, { parent: 'sub1' });
    t.end();
    expect(repeated(t)).toBe(1);
  });
});

describe('turnOutcomes y aggregateStats', () => {
  it('la recuperación se mide por turno: fallos por el camino y final en stop', () => {
    const t = trace()
      .turn('uno')
      .tool('read_file', { path: 'x' }, { error: 'no existe' })
      .tool('read_file', { path: 'y' })
      .end('stop')
      .turn('dos')
      .model({ error: 'boom' })
      .end('error')
      .turn('tres')
      .tool('glob', { pattern: '*' })
      .end('stop');
    expect(turnOutcomes(t.records).map((o) => [o.errors, o.stop])).toEqual([
      [1, 'stop'],
      [1, 'error'],
      [0, 'stop'],
    ]);

    const stats = aggregateStats([{ sessionId: 's1', updatedAt: 5000, records: t.records }]);
    expect(stats.turns).toBe(3);
    expect(stats.stopReasons).toEqual({ stop: 2, error: 1 });
    expect(stats.turnCompletionRate).toBeCloseTo(2 / 3);
    expect(stats.recovery).toEqual({ turnsWithErrors: 2, recovered: 1, rate: 0.5 });
    expect(stats.tools.find((x) => x.name === 'read_file')).toMatchObject({
      calls: 2,
      errors: 1,
      blocked: 0,
    });
  });

  it('las métricas de política solo salen de las trazas que las registran', () => {
    const veto = { event: 'veto', source: 'preflight', tool: 'exec', callId: 'c1', reason: 'no' };
    const modern = trace()
      .turn()
      .notice(veto)
      .tool('exec', {}, { error: 'blocked', callId: 'c1' })
      .tool('exec', {})
      .end();
    const old = trace({ runtime: false }).turn().tool('exec', {}).tool('exec', {}).end();

    const mixed = aggregateStats([
      { sessionId: 'a', updatedAt: 1, records: modern.records },
      { sessionId: 'b', updatedAt: 2, records: old.records },
    ]);
    expect(mixed.sessions).toBe(2);
    expect(mixed.runtimeSessions).toBe(1);
    expect(mixed.policyBlocks).toBe(1);
    // 1 bloqueo sobre las 2 tool calls de la sesión que lo registra, no sobre las 4.
    expect(mixed.policyViolationRate).toBe(0.5);
    expect(mixed.tools[0]).toMatchObject({ name: 'exec', calls: 4, errors: 0, blocked: 1 });

    const onlyOld = aggregateStats([{ sessionId: 'b', updatedAt: 2, records: old.records }]);
    expect(onlyOld.policyBlocks).toBeNull();
    expect(onlyOld.confirmations).toBeNull();
  });

  it('sin trazas no hay tasas inventadas', () => {
    const empty = aggregateStats([]);
    expect(empty.sessions).toBe(0);
    expect(empty.toolErrorRate).toBeNull();
    expect(empty.tokens).toBeNull();
  });
});
