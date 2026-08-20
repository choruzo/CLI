import type { AgentEvent } from '../../agent/types.js';
import type { ToolCallState } from './ToolCallBlock.js';

/**
 * Reduce un `AgentEvent` de tool sobre un array de `ToolCallState` (Hito 8C).
 * Misma semántica que el reducer principal de `App.tsx`, extraída para reutilizarla
 * en los nodos internos del `<AgentTree>` y en el transcript del inspector
 * `/subagents`. Devuelve el array (nuevo si hubo cambio, el mismo si el evento no
 * afecta a tool calls). No muta la entrada.
 */
export function applyToolEvent(toolCalls: ToolCallState[], ev: AgentEvent): ToolCallState[] {
  switch (ev.type) {
    case 'tool_call_start': {
      const exists = toolCalls.find((tc) => tc.id === ev.id);
      if (exists) {
        return toolCalls.map((tc) =>
          tc.id === ev.id ? { ...tc, inputSoFar: ev.input_so_far } : tc,
        );
      }
      return [
        ...toolCalls,
        { id: ev.id, name: ev.name, status: 'pending', inputSoFar: ev.input_so_far },
      ];
    }
    case 'tool_call_ready':
      return toolCalls.map((tc) =>
        tc.id === ev.id ? { ...tc, status: 'running', input: ev.input } : tc,
      );
    case 'tool_result':
      return toolCalls.map((tc) =>
        tc.id === ev.id
          ? { ...tc, status: 'completed', output: ev.result, durationMs: ev.durationMs }
          : tc,
      );
    case 'tool_error':
      return toolCalls.map((tc) =>
        tc.id === ev.id ? { ...tc, status: 'error', errorMsg: ev.error } : tc,
      );
    default:
      return toolCalls;
  }
}
