import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useRef: <T>(value: T) => ({ current: value }),
}));

import { coalesceAgentEvents, useAgentStream } from './useAgentStream.js';
import type { AgentEvent } from '../../agent/types.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useAgentStream', () => {
  it('dispatches done(cancelled) after cancel instead of breaking early', async () => {
    const gate = deferred<void>();
    const dispatch = vi.fn();
    const agent = {
      run: vi.fn(async function* (_input: string, opts?: { signal?: AbortSignal }) {
        yield { type: 'text_delta' as const, delta: 'partial' };
        await gate.promise;
        yield {
          type: 'done' as const,
          stopReason: opts?.signal?.aborted ? ('cancelled' as const) : ('stop' as const),
        };
      }),
      getContextUsage: vi.fn(() => ({ used: 1, max: 10, estimated: true })),
      getTokenUsage: vi.fn(() => ({ status: 'reported' as const, tokens: 42 })),
      getLiveTurnUsage: vi.fn(() => null),
      getSessionUsage: vi.fn(() => ({
        llmCalls: 0,
        reportedCalls: 0,
        llmMs: 0,
        toolMs: 0,
        turns: 0,
      })),
      getLastTurnChanges: vi.fn(() => null),
    };

    const { send, cancel } = useAgentStream(agent as never, dispatch);

    const pending = send('hello');
    await Promise.resolve();

    cancel();
    gate.resolve();
    await pending;

    expect(dispatch).toHaveBeenCalledWith({ type: 'AGENT_START', input: 'hello' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'AGENT_FRAME',
      events: [{ type: 'done', stopReason: 'cancelled' }],
      context: {
        used: 1,
        max: 10,
        estimated: true,
        tokens: { status: 'reported', tokens: 42 },
        turnUsage: null,
      },
    });
    // El contexto se consulta una vez en la frontera `done`, no por text_delta.
    expect(agent.getContextUsage).toHaveBeenCalledTimes(1);
    // Sin registro de snapshots no se pinta «cambios por turno».
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'TURN_CHANGES' }));
  });

  it('manda los ficheros que cambió el turno antes del `done` que lo cierra', async () => {
    const dispatch = vi.fn();
    const files = [{ path: 'a.ts', status: 'modified' as const, additions: 3, deletions: 1 }];
    const agent = {
      run: vi.fn(async function* () {
        yield { type: 'done' as const, stopReason: 'stop' as const };
      }),
      getContextUsage: vi.fn(() => ({ used: 1, max: 10, estimated: true })),
      getTokenUsage: vi.fn(() => ({ status: 'unavailable' as const })),
      getLiveTurnUsage: vi.fn(() => null),
      getSessionUsage: vi.fn(() => null),
      getLastTurnChanges: vi.fn(() => ({ turn: 1, files })),
    };

    const { send } = useAgentStream(agent as never, dispatch);
    await send('hola');

    const actions = dispatch.mock.calls.map(([a]) => a as { type: string; events?: AgentEvent[] });
    const changesAt = actions.findIndex((a) => a.type === 'TURN_CHANGES');
    const doneAt = actions.findIndex((a) => a.events?.some((e) => e.type === 'done'));
    expect(changesAt).toBeGreaterThanOrEqual(0);
    expect(changesAt).toBeLessThan(doneAt);
    expect(dispatch).toHaveBeenCalledWith({ type: 'TURN_CHANGES', files });
  });

  it('coalesces high-frequency text and tool argument fragments without reordering', () => {
    expect(
      coalesceAgentEvents([
        { type: 'text_delta', delta: 'a' },
        { type: 'text_delta', delta: 'b' },
        { type: 'tool_call_start', id: 'c1', name: 'exec', input_so_far: '{' },
        { type: 'tool_call_start', id: 'c1', name: 'exec', input_so_far: '{"x":1}' },
        { type: 'warning', message: 'boundary' },
      ]),
    ).toEqual([
      { type: 'text_delta', delta: 'ab' },
      { type: 'tool_call_start', id: 'c1', name: 'exec', input_so_far: '{"x":1}' },
      { type: 'warning', message: 'boundary' },
    ]);
  });

  it('refreshes context after the harness has inserted a yielded tool result', async () => {
    const gate = deferred<void>();
    const dispatch = vi.fn();
    let inserted = false;
    const agent = {
      run: vi.fn(async function* () {
        yield { type: 'tool_result' as const, id: 'c1', name: 'exec', result: 'ok', durationMs: 1 };
        inserted = true;
        await gate.promise;
        yield { type: 'done' as const, stopReason: 'stop' as const };
      }),
      getContextUsage: vi.fn(() => ({ used: inserted ? 2 : 1, max: 10, estimated: true })),
      getTokenUsage: vi.fn(() => ({ status: 'unavailable' as const })),
      getLiveTurnUsage: vi.fn(() => null),
      getSessionUsage: vi.fn(() => ({
        llmCalls: 0,
        reportedCalls: 0,
        llmMs: 0,
        toolMs: 0,
        turns: 0,
      })),
      getLastTurnChanges: vi.fn(() => null),
    };

    const { send } = useAgentStream(agent as never, dispatch);
    const pending = send('hello');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'AGENT_FRAME',
        events: [],
        context: expect.objectContaining({ used: 2 }),
      }),
    );

    gate.resolve();
    await pending;
  });
});
