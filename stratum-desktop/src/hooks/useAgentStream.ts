import { sendSidecarFrame } from '../ipc/bridge';
import type {
  ClientFrame,
  DestructiveDecision,
  QuestionAnswer,
  SidecarFrame,
} from '../ipc/types';
import {
  agentEvent,
  conversationStats,
  isRecord,
  isStopReason,
  questionItems,
  todoItems,
  transcript,
  workspaceFiles,
  workspaceStatus,
} from '../ipc/validate';
import type {
  ConversationAction,
  ConversationState,
  SentAttachment,
} from './conversation-reducer';

/**
 * Tramas de una conversación → acciones del reducer, y la API de la
 * conversación activa que consumen los componentes de chat. El estado de todas
 * las conversaciones vive en `useConversations` (D4).
 */

const isString = (v: unknown): v is string => typeof v === 'string';

/** `conversationId` de una trama de conversación (el de `summary` en `conversation_updated`). */
export function frameConversationId(frame: SidecarFrame): string | null {
  const f = frame as unknown as Record<string, unknown>;
  if (!isRecord(f)) return null;
  if (isString(f.conversationId)) return f.conversationId;
  return null;
}

/**
 * Traduce una trama del sidecar a una acción del reducer, o `null` si no es de
 * esta conversación o no tiene la forma esperada. Aunque el sidecar es de
 * confianza, lo que entra al estado de la UI se comprueba: una trama mal
 * formada se descarta en lugar de romper el render.
 */
export function frameToAction(
  frame: SidecarFrame,
  conversationId: string,
): ConversationAction | null {
  const f = frame as unknown as Record<string, unknown>;
  if (!isRecord(f) || f.conversationId !== conversationId) return null;
  switch (f.type) {
    case 'conversation_opened': {
      const turns = f.transcript === undefined ? null : transcript(f.transcript);
      const base = { type: 'opened' as const, workspace: workspaceStatus(f.workspace) };
      if (!turns) return base;
      return {
        ...base,
        snapshot: {
          transcript: turns,
          activeTurnId: isString(f.activeTurnId) ? f.activeTurnId : null,
          todos: todoItems(f.todos) ?? [],
          stats: conversationStats(f.stats),
          title: isString(f.title) ? f.title : null,
        },
      };
    }
    case 'workspace_status': {
      const status = workspaceStatus(f.status);
      return status ? { type: 'workspace_status', status } : null;
    }
    case 'agent_event': {
      const event = agentEvent(f.event);
      return isString(f.turnId) && event ? { type: 'agent_event', turnId: f.turnId, event } : null;
    }
    case 'turn_ended':
      return isString(f.turnId) && isStopReason(f.stopReason)
        ? { type: 'turn_ended', turnId: f.turnId, stopReason: f.stopReason }
        : null;
    case 'turn_queued':
      return isString(f.turnId) && typeof f.position === 'number'
        ? { type: 'turn_queued', turnId: f.turnId, position: f.position }
        : null;
    case 'turn_started':
      return isString(f.turnId) ? { type: 'turn_started', turnId: f.turnId } : null;
    case 'chat_rejected':
      return isString(f.turnId) && isString(f.message)
        ? { type: 'chat_rejected', turnId: f.turnId, message: f.message }
        : null;
    case 'questions_request': {
      const questions = questionItems(f.questions);
      return isString(f.requestId) && questions && questions.length > 0
        ? { type: 'questions_request', requestId: f.requestId, questions }
        : null;
    }
    case 'confirm_request':
      return isString(f.callId) && isString(f.tool) && isString(f.description)
        ? { type: 'confirm_request', callId: f.callId, tool: f.tool, description: f.description }
        : null;
    case 'prompt_resolved':
      if (!isString(f.id)) return null;
      if (f.kind === 'confirm') return { type: 'confirm_resolved', callId: f.id };
      if (f.kind === 'questions') return { type: 'questions_resolved', requestId: f.id };
      return null;
    case 'conversation_error':
      return isString(f.message) ? { type: 'conversation_error', message: f.message } : null;
    case 'conversation_notice':
      if (!isString(f.message)) return null;
      return f.tone === 'warning'
        ? { type: 'conversation_error', message: f.message }
        : { type: 'info', message: f.message };
    case 'conversation_cleared':
      return { type: 'cleared' };
    case 'conversation_stats': {
      const stats = conversationStats(f.stats);
      return stats ? { type: 'stats', stats } : null;
    }
    case 'workspace_files': {
      const files = workspaceFiles(f.files);
      return isString(f.turnId) && files && files.length > 0
        ? { type: 'workspace_files', turnId: f.turnId, files }
        : null;
    }
    default:
      return null;
  }
}

/** La conversación activa, tal como la usan los componentes de chat. */
export interface AgentStream extends ConversationState {
  conversationId: string;
  /** `attachments`: adjuntos ya copiados al workspace (D2). */
  send: (text: string, attachments?: SentAttachment[]) => void;
  cancel: () => void;
  answerQuestions: (answers: QuestionAnswer[] | null) => void;
  confirm: (decision: DestructiveDecision) => void;
  retry: (turnId: string) => void;
  /** Fija o desfija la conversación: la excluye de la retención (D3). */
  pin: (pinned: boolean) => void;
  dismissNotice: () => void;
  dismissInfo: () => void;
}

export function post(frame: ClientFrame, onError?: (message: string) => void): void {
  sendSidecarFrame(frame).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[stratum] no se pudo enviar al agente', frame.type, message);
    onError?.(message);
  });
}
