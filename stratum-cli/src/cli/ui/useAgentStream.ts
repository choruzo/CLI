import { useCallback, useRef } from 'react';
import type { StratumAgent } from '../../agent/core.js';
import type { AgentEvent, RunOptions } from '../../agent/types.js';
import type { AppAction } from './App.js';

export function useAgentStream(
  agent: StratumAgent,
  dispatch: (action: AppAction) => void,
  getRunOptions?: () => Partial<RunOptions>,
) {
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (
      input: string,
      extra?: { displayText?: string; runOptions?: Partial<RunOptions> },
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;

      dispatch({ type: 'AGENT_START', input: extra?.displayText ?? input });

      try {
        for await (const event of agent.run(input, {
          ...(getRunOptions?.() ?? {}),
          ...(extra?.runOptions ?? {}),
          signal: controller.signal,
        })) {
          dispatch({ type: 'AGENT_EVENT', event });

          const ctx = agent.getContextUsage();
          dispatch({
            type: 'CONTEXT_UPDATE',
            used: ctx.used,
            max: ctx.max,
            estimated: ctx.estimated,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const ev: AgentEvent = { type: 'error', message: msg, fatal: true };
        dispatch({ type: 'AGENT_EVENT', event: ev });
        dispatch({ type: 'AGENT_EVENT', event: { type: 'done', stopReason: 'stop' } });
      } finally {
        abortRef.current = null;
      }
    },
    [agent, dispatch, getRunOptions],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, cancel };
}
