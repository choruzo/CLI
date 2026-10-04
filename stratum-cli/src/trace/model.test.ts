import { describe, it, expect } from 'vitest';
import type { TraceRecord } from './records.js';
import {
  applyRecords,
  emptyTrace,
  layoutTimeline,
  stepLabel,
  stepMatches,
  stepResult,
  traceStats,
} from './model.js';

/** Un turno con prompt del sistema, dos llamadas al modelo y una tool. */
const TURN: TraceRecord[] = [
  { t: 'meta', v: 1, at: 1000, sessionId: 's' },
  { t: 'point', at: 1000, id: 'p1', kind: 'system', name: 'Prompt inicial del sistema' },
  { t: 'turn', at: 1000, input: 'lee a.txt' },
  { t: 'begin', at: 1010, id: 'm1', kind: 'model', name: 'qwen' },
  { t: 'mark', at: 1110, id: 'm1', name: 'first_token' },
  {
    t: 'begin',
    at: 1200,
    id: 't1',
    kind: 'tool',
    name: 'read_file',
    data: { input: { path: 'a.txt' } },
  },
  {
    t: 'end',
    at: 1210,
    id: 'm1',
    status: 'ok',
    data: {
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }],
      usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020, cachedTokens: 500 },
    },
  },
  { t: 'end', at: 1260, id: 't1', status: 'ok', data: { output: '1: hola', execMs: 3 } },
  { t: 'begin', at: 1270, id: 'm2', kind: 'model', name: 'qwen' },
  { t: 'end', at: 2000, id: 'm2', status: 'ok', data: { text: 'Dice hola.' } },
  { t: 'turn_end', at: 2000, stopReason: 'stop' },
];

describe('modelo de trayectoria', () => {
  it('reconstruye los pasos y numera el primer turno aunque el sistema llegue antes', () => {
    const model = applyRecords(emptyTrace(), TURN);
    expect(model.steps.map((s) => s.kind)).toEqual(['system', 'user', 'model', 'tool', 'model']);
    expect(model.turns).toHaveLength(1);
    expect(model.steps.every((s) => s.turn === 0)).toBe(true);
    expect(model.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    const m1 = model.steps[model.index.m1];
    expect(m1).toMatchObject({ start: 1010, end: 1210, firstToken: 1110, status: 'ok' });
    expect(stepLabel(m1)).toBe('Llama a read_file');
    const tool = model.steps[model.index.t1];
    expect(stepLabel(tool)).toBe('read_file {"path":"a.txt"}');
    expect(stepResult(tool)).toBe('→ 1: hola');
    expect(stepLabel(model.steps[1])).toBe('lee a.txt');
  });

  it('da lo mismo aplicar los registros de una vez que por tandas, sin mutar el anterior', () => {
    const whole = applyRecords(emptyTrace(), TURN);
    const first = applyRecords(emptyTrace(), TURN.slice(0, 6));
    const snapshot = JSON.stringify(first);
    const second = applyRecords(first, TURN.slice(6));
    expect(second).toEqual(whole);
    expect(JSON.stringify(first)).toBe(snapshot);
    // Un paso abierto se ve abierto hasta que llega su `end`.
    expect(first.steps[first.index.m1].end).toBeNull();
  });

  it('ignora registros repetidos y `end` de pasos desconocidos', () => {
    const model = applyRecords(applyRecords(emptyTrace(), TURN), [
      TURN[3],
      { t: 'end', at: 5, id: 'nope', status: 'ok' },
    ]);
    expect(model.steps).toHaveLength(5);
  });

  it('los pasos de un subagente heredan el turno de su padre', () => {
    const model = applyRecords(emptyTrace(), [
      { t: 'turn', at: 1, input: 'a' },
      { t: 'begin', at: 2, id: 'sub_1', kind: 'subagent', name: 'code' },
      { t: 'turn_end', at: 3, stopReason: 'stop' },
      { t: 'turn', at: 4, input: 'b' },
      { t: 'point', at: 5, id: 'x', kind: 'context', name: 'tarde', parent: 'sub_1' },
    ]);
    expect(model.steps[model.index.x]).toMatchObject({ turn: 0, parent: 'sub_1' });
  });

  it('coloca los bloques por carril y según el eje', () => {
    const model = applyRecords(emptyTrace(), TURN);
    const calls = layoutTimeline(model, 'calls', 3000);
    expect(calls.map((b) => b.lane)).toEqual([0, 0, 1, 2, 1]);
    expect(calls[2]).toMatchObject({ x: 2 / 5 });
    expect(calls[2].w).toBeCloseTo(1 / 5);
    // 100 ms de espera y 100 de generación: la mitad del bloque es generación.
    expect(calls[2].gen).toBeCloseTo(0.5);

    const duration = layoutTimeline(model, 'duration', 3000);
    expect(duration[2].x).toBeCloseTo(10 / 1000);
    expect(duration[4].x + duration[4].w).toBeCloseTo(1);
    // Un paso instantáneo no tiene ancho: el mínimo lo pone el CSS.
    expect(duration[0].w).toBe(0);
  });

  it('suma tokens, velocidad y acierto de caché solo de lo que el backend reportó', () => {
    const stats = traceStats(applyRecords(emptyTrace(), TURN), 3000);
    expect(stats).toMatchObject({
      turns: 1,
      steps: 5,
      modelCalls: 2,
      toolCalls: 1,
      totalTokens: 1020,
      cacheHit: 0.5,
      activeMs: 1000,
    });
    expect(stats.tokensPerSecond).toBeCloseTo(200);
    expect(traceStats(emptyTrace(), 0)).toMatchObject({ tokensPerSecond: null, cacheHit: null });
  });

  it('busca en el nombre y en el contenido', () => {
    const model = applyRecords(emptyTrace(), TURN);
    expect(model.steps.filter((s) => stepMatches(s, 'hola')).map((s) => s.id)).toEqual([
      't1',
      'm2',
    ]);
    expect(stepMatches(model.steps[0], '')).toBe(true);
  });
});
