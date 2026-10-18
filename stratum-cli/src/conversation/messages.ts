/**
 * Un mensaje del historial del agente ↔ su forma explícita y serializable
 * (`ProtocolAgentMessage`). La usan el traspaso al daemon (M10) y el
 * `ConversationStore` (M11): una sola conversión, sin copias.
 */
import type { Message } from '../agent/types.js';
import type { ProtocolAgentMessage } from '../protocol/index.js';

export function toStoredMessage(m: Message): ProtocolAgentMessage {
  return {
    role: m.role,
    content: m.content ?? null,
    ...(m.tool_calls && m.tool_calls.length > 0
      ? {
          toolCalls: m.tool_calls.map((c) => ({
            id: c.id,
            name: c.function.name,
            arguments: c.function.arguments,
          })),
        }
      : {}),
    ...(m.tool_call_id !== undefined ? { toolCallId: m.tool_call_id } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}),
  };
}

export function fromStoredMessage(m: ProtocolAgentMessage): Message {
  return {
    role: m.role,
    content: m.content,
    ...(m.toolCalls && m.toolCalls.length > 0
      ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : {}),
    ...(m.toolCallId !== undefined ? { tool_call_id: m.toolCallId } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}),
  };
}
