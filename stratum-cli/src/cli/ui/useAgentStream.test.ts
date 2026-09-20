import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useRef: <T>(value: T) => ({ current: value }),
}));

import { coalesceAgentEvents, useAgentStream } from './useAgentStream.js';

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
      },
    });
    // El contexto se consulta una vez en la frontera `done`, no por text_delta.
    expect(agent.getContextUsage).toHaveBeenCalledTimes(1);
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
