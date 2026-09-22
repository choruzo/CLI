import { useCallback, useEffect, useReducer, useRef } from 'react';
import { sendSidecarFrame, subscribeSidecarFrames } from '../ipc/bridge';
import type {
  ClientFrame,
  DestructiveDecision,
  QuestionAnswer,
  SidecarFrame,
  SidecarStatus,
} from '../ipc/types';
import {
  agentEvent,
  isRecord,
  isStopReason,
  questionItems,
  workspaceFiles,
  workspaceStatus,
} from '../ipc/validate';
import {
  conversationReducer,
  initialConversationState,
  userMessageOf,
  type ConversationAction,
  type SentAttachment,
  type ConversationState,
} from './conversation-reducer';

/**
 * Stream de una conversación con el asistente (D1: una sola conversación).
 *
 * - El `conversationId` lo genera el webview y se guarda en `sessionStorage`:
 *   un reload del webview sigue siendo la misma conversación para el sidecar.
 * - En cada conexión (la primera y tras cada reinicio del sidecar) se envía
 *   `new_conversation {resume: true}`: el sidecar rehidrata el agente desde la
 *   sesión en disco si existe (15.5).
 * - Al perder la conexión, el turno en curso queda `interrupted` con opción de
 *   reintentarlo; las preguntas y confirmaciones pendientes se descartan.
 */

const STORAGE_KEY = 'stratum.conversationId';

function newConversationId(): string {
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    sessionStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';

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
    case 'conversation_opened':
      return { type: 'opened', workspace: workspaceStatus(f.workspace) };
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
}

function post(frame: ClientFrame, onError?: (message: string) => void): void {
  sendSidecarFrame(frame).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[stratum] no se pudo enviar al agente', frame.type, message);
    onError?.(message);
  });
}

export function useAgentStream(status: SidecarStatus): AgentStream {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const idRef = useRef<string>('');
  if (!idRef.current) idRef.current = newConversationId();
  const conversationId = idRef.current;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeSidecarFrames((frame) => {
      if (disposed) return;
      const action = frameToAction(frame, conversationId);
      if (action) dispatch(action);
    }).then((u) => {
      if (disposed) u();
      else unsubscribe = u;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [conversationId]);

  // Apertura en cada conexión nueva; pérdida de conexión en cuanto deja de estar conectado.
  const connected = status.state === 'connected';
  useEffect(() => {
    if (connected) {
      post({ type: 'new_conversation', conversationId, resume: true });
    } else {
      dispatch({ type: 'connection_lost' });
    }
  }, [connected, conversationId]);

  const send = useCallback(
    (text: string, attachments: SentAttachment[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      if (stateRef.current.activeTurnId || !stateRef.current.opened) return;
      const turnId = crypto.randomUUID();
      dispatch({ type: 'user_sent', turnId, text: trimmed, attachments });
      post(
        {
          type: 'chat',
          conversationId,
          turnId,
          text: trimmed,
          ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.path) } : {}),
        },
        (message) => dispatch({ type: 'chat_rejected', turnId, message }),
      );
    },
    [conversationId],
  );

  const cancel = useCallback(() => {
    const turnId = stateRef.current.activeTurnId;
    if (turnId) post({ type: 'cancel', conversationId, turnId });
  }, [conversationId]);

  const answerQuestions = useCallback(
    (answers: QuestionAnswer[] | null) => {
      const pending = stateRef.current.pendingQuestions;
      if (!pending) return;
      // El prompt sigue a la vista hasta el acuse del sidecar (`prompt_resolved`):
      // si el envío falla en plena reconexión, la respuesta no se pierde en silencio.
      post({ type: 'answer_questions', conversationId, requestId: pending.requestId, answers }, (m) =>
        dispatch({ type: 'conversation_error', message: `No se pudo enviar la respuesta: ${m}` }),
      );
    },
    [conversationId],
  );

  const confirm = useCallback(
    (decision: DestructiveDecision) => {
      const pending = stateRef.current.pendingConfirm;
      if (!pending) return;
      post({ type: 'confirm_response', conversationId, callId: pending.callId, decision }, (m) =>
        dispatch({ type: 'conversation_error', message: `No se pudo enviar la decisión: ${m}` }),
      );
    },
    [conversationId],
  );

  const retry = useCallback(
    (turnId: string) => {
      const message = userMessageOf(stateRef.current, turnId);
      if (message) send(message.text, message.attachments);
    },
    [send],
  );

  const pin = useCallback(
    (pinned: boolean) => {
      post({ type: 'workspace_pin', conversationId, pinned }, (m) =>
        dispatch({ type: 'conversation_error', message: `No se pudo fijar la conversación: ${m}` }),
      );
    },
    [conversationId],
  );

  return { ...state, conversationId, send, cancel, answerQuestions, confirm, retry, pin };
}
