import { useCallback, useRef } from 'react';
import type { StratumAgent } from '../../agent/core.js';
import type { AgentEvent, RunOptions } from '../../agent/types.js';
import type { AppAction } from './App.js';

const STREAM_FRAME_MS = 40;

function isBufferedEvent(event: AgentEvent): boolean {
  return (
    event.type === 'text_delta' ||
    event.type === 'tool_call_start' ||
    (event.type === 'subagent_event' &&
      (event.event.type === 'text_delta' || event.event.type === 'tool_call_start'))
  );
}

export function coalesceAgentEvents(events: AgentEvent[]): AgentEvent[] {
  const result: AgentEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.type === 'text_delta' && previous?.type === 'text_delta') {
      result[result.length - 1] = { type: 'text_delta', delta: previous.delta + event.delta };
      continue;
    }
    if (
      event.type === 'tool_call_start' &&
      previous?.type === 'tool_call_start' &&
      previous.id === event.id
    ) {
      result[result.length - 1] = event;
      continue;
    }
    if (
      event.type === 'subagent_event' &&
      previous?.type === 'subagent_event' &&
      previous.subagentId === event.subagentId &&
      event.event.type === 'text_delta' &&
      previous.event.type === 'text_delta'
    ) {
      result[result.length - 1] = {
        type: 'subagent_event',
        subagentId: event.subagentId,
        event: { type: 'text_delta', delta: previous.event.delta + event.event.delta },
      };
      continue;
    }
    if (
      event.type === 'subagent_event' &&
      previous?.type === 'subagent_event' &&
      previous.subagentId === event.subagentId &&
      event.event.type === 'tool_call_start' &&
      previous.event.type === 'tool_call_start' &&
      previous.event.id === event.event.id
    ) {
      result[result.length - 1] = event;
      continue;
    }
    result.push(event);
  }
  return result;
}

export function useAgentStream(
  agent: StratumAgent,
  dispatch: (action: AppAction) => void,
  getRunOptions?: () => Partial<RunOptions>,
) {
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (
      input: string,
      extra?: {
        displayText?: string;
        runOptions?: Partial<RunOptions>;
        /** Hito 15 — `@perfil tarea`: el subagente atiende `input` sin pasar por el principal. */
        delegateProfile?: string;
      },
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;

      dispatch({ type: 'AGENT_START', input: extra?.displayText ?? input });

      const runOptions: RunOptions = {
        ...(getRunOptions?.() ?? {}),
        ...(extra?.runOptions ?? {}),
        signal: controller.signal,
      };
      const events = extra?.delegateProfile
        ? agent.runDelegate(extra.delegateProfile, input, runOptions)
        : agent.run(input, runOptions);

      let pending: AgentEvent[] = [];
      let frameTimer: ReturnType<typeof setTimeout> | null = null;
      let contextTimer: ReturnType<typeof setTimeout> | null = null;
      let contextDirty = false;
      const context = () => {
        const ctx = agent.getContextUsage();
        return {
          used: ctx.used,
          max: ctx.max,
          estimated: ctx.estimated,
          tokens: agent.getTokenUsage(),
        };
      };
      const flush = (includeContext = false) => {
        if (frameTimer) clearTimeout(frameTimer);
        frameTimer = null;
        if (pending.length === 0 && !includeContext) return;
        const batched = coalesceAgentEvents(pending);
        pending = [];
        dispatch({
          type: 'AGENT_FRAME',
          events: batched,
          context: includeContext ? context() : undefined,
        });
      };
      const enqueue = (event: AgentEvent) => {
        pending.push(event);
        if (!frameTimer) frameTimer = setTimeout(() => flush(false), STREAM_FRAME_MS);
      };

      try {
        for await (const event of events) {
          // Un tool_result se añade al historial justo cuando el generador se
          // reanuda para producir el evento siguiente. Refrescar aquí evita leer
          // el contexto un tick demasiado pronto.
          if (contextTimer) clearTimeout(contextTimer);
          contextTimer = null;
          const refreshPreviousBoundary = contextDirty;
          contextDirty = false;
          if (isBufferedEvent(event)) {
            enqueue(event);
            if (refreshPreviousBoundary) flush(true);
            continue;
          }
          flush(false);
          pending.push(event);
          // El historial/contexto solo cambia en fronteras de iteración y al
          // inyectar resultados; los deltas intermedios devolverían el mismo dato.
          const contextChanged =
            refreshPreviousBoundary || event.type === 'context_compressed' || event.type === 'done';
          flush(contextChanged);
          if (event.type === 'tool_result' || event.type === 'tool_error') {
            contextDirty = true;
            // Al solicitar el siguiente item del generador, el harness inserta
            // el resultado en `messages` antes de esperar la próxima respuesta.
            contextTimer = setTimeout(() => {
              if (!contextDirty) return;
              contextDirty = false;
              contextTimer = null;
              dispatch({ type: 'AGENT_FRAME', events: [], context: context() });
            }, 0);
          }
        }
      } catch (err) {
        flush(false);
        const msg = err instanceof Error ? err.message : String(err);
        const ev: AgentEvent = { type: 'error', message: msg, fatal: true };
        dispatch({
          type: 'AGENT_FRAME',
          events: [ev, { type: 'done', stopReason: 'stop' }],
          context: context(),
        });
      } finally {
        if (pending.length > 0) flush(true);
        else if (frameTimer) clearTimeout(frameTimer);
        if (contextTimer) clearTimeout(contextTimer);
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
