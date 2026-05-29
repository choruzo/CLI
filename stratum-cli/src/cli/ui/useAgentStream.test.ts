import { describe, expect, it, vi } from 'vitest';

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
  useRef: <T>(value: T) => ({ current: value }),
}));

import { useAgentStream } from './useAgentStream.js';

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
    };

    const { send, cancel } = useAgentStream(agent as never, dispatch);

    const pending = send('hello');
    await Promise.resolve();

    cancel();
    gate.resolve();
    await pending;

    expect(dispatch).toHaveBeenCalledWith({ type: 'AGENT_START', input: 'hello' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'AGENT_EVENT',
      event: { type: 'done', stopReason: 'cancelled' },
    });
    // CONTEXT_UPDATE debe propagar estimated
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CONTEXT_UPDATE', estimated: true }),
    );
  });
});
