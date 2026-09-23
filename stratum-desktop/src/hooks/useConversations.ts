import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { subscribeSidecarFrames } from '../ipc/bridge';
import type {
  ConversationSummary,
  DestructiveDecision,
  QuestionAnswer,
  SidecarFrame,
  SidecarStatus,
} from '../ipc/types';
import { conversationSummaries, conversationSummary, isRecord } from '../ipc/validate';
import {
  initialConversationState,
  userMessageOf,
  type SentAttachment,
} from './conversation-reducer';
import {
  conversationsReducer,
  idleBackground,
  initialConversationsState,
  type ConversationsState,
} from './conversations-store';
import { frameConversationId, frameToAction, post, type AgentStream } from './useAgentStream';

/**
 * Todas las conversaciones del webview (D4).
 *
 * - La activa se recuerda en `localStorage` (comodidad por usuario: si falta,
 *   se empieza una nueva). El historial de verdad lo guarda el sidecar.
 * - En cada conexión (la primera y tras cada reinicio del sidecar) se pide el
 *   listado y se abre la activa con `resume`: el sidecar devuelve su transcript.
 * - Las conversaciones que generan en segundo plano siguen abiertas hasta que
 *   terminan; entonces se cierran, como las que el usuario deja atrás.
 */

const ACTIVE_KEY = 'stratum.activeConversation';

function loadActiveId(): string {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY);
    if (saved) return saved;
  } catch {
    /* sin almacenamiento: conversación nueva */
  }
  return crypto.randomUUID();
}

function saveActiveId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    /* no crítico */
  }
}

export interface ModelsOffer {
  conversationId: string;
  current: string;
  models: string[];
  error?: string;
}

export interface Conversations {
  state: ConversationsState;
  active: AgentStream;
  /** El listado del sidebar más la activa si todavía no tiene mensajes guardados. */
  list: ConversationSummary[];
  /** La activa cuando aún no está guardada (borrador): sin acciones en el listado. */
  draftId: string | null;
  select: (id: string) => void;
  newConversation: () => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  /** Fija o desfija cualquier conversación del listado (abierta o no). */
  pinConversation: (id: string, pinned: boolean) => void;
  clear: () => void;
  compact: () => void;
  listModels: () => void;
  setModel: (model: string) => void;
  models: ModelsOffer | null;
  closeModels: () => void;
}

export function useConversations(status: SidecarStatus): Conversations {
  const [state, dispatch] = useReducer(conversationsReducer, undefined, () =>
    initialConversationsState(loadActiveId()),
  );
  const [models, setModels] = useState<ModelsOffer | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeId = state.activeId;
  // `open` se define más abajo; el oyente de tramas lo llama por aquí.
  const reopenRef = useRef<(id: string) => void>(() => undefined);

  useEffect(() => saveActiveId(activeId), [activeId]);

  // Tramas del sidecar: las de listado van al store; las de una conversación, a la suya.
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const onFrame = (frame: SidecarFrame) => {
      if (disposed) return;
      const f = frame as unknown as Record<string, unknown>;
      if (!isRecord(f)) return;
      switch (f.type) {
        case 'conversations': {
          const items = conversationSummaries(f.items);
          if (items) dispatch({ type: 'list', items });
          return;
        }
        case 'conversation_updated': {
          const summary = conversationSummary(f.summary);
          if (summary) dispatch({ type: 'summary', summary });
          return;
        }
        case 'conversation_deleted':
          if (typeof f.conversationId === 'string') {
            dispatch({ type: 'deleted', id: f.conversationId });
          }
          return;
        case 'config_state': {
          // D5: la activa no pudo abrirse (config rota, sin provider…) y ya
          // hay una config que funciona: se vuelve a intentar sin reiniciar.
          const applied = isRecord(f.applied) ? f.applied : null;
          const current = stateRef.current;
          const c = current.byId[current.activeId];
          if (applied?.ok === true && current.open[current.activeId] && c && !c.opened && c.notice) {
            dispatch({ type: 'conv', id: current.activeId, action: { type: 'dismiss_notice' } });
            reopenRef.current(current.activeId);
          }
          return;
        }
        case 'models':
          if (typeof f.conversationId === 'string' && typeof f.current === 'string') {
            setModels({
              conversationId: f.conversationId,
              current: f.current,
              models: Array.isArray(f.models) ? f.models.filter((m) => typeof m === 'string') : [],
              ...(typeof f.error === 'string' ? { error: f.error } : {}),
            });
          }
          return;
      }
      const id = frameConversationId(frame);
      if (!id) return;
      const action = frameToAction(frame, id);
      if (action) dispatch({ type: 'conv', id, action });
      // Una conversación que el webview no sabe abierta (se recargó con ella
      // generando en segundo plano) se cierra en cuanto termina su turno.
      const current = stateRef.current;
      if (f.type === 'turn_ended' && id !== current.activeId && !current.open[id]) {
        post({ type: 'close_conversation', conversationId: id });
      }
    };
    void subscribeSidecarFrames(onFrame).then((u) => {
      if (disposed) u();
      else unsubscribe = u;
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const open = useCallback((id: string) => {
    if (stateRef.current.open[id]) return;
    dispatch({ type: 'mark_open', id, open: true });
    // Siempre con `resume`: una conversación nueva no tiene sesión y abre vacía.
    post({ type: 'new_conversation', conversationId: id, resume: true }, (message) => {
      dispatch({ type: 'mark_open', id, open: false });
      dispatch({ type: 'conv', id, action: { type: 'conversation_error', message } });
    });
  }, []);
  reopenRef.current = (id: string) => {
    post({ type: 'new_conversation', conversationId: id, resume: true }, (message) =>
      dispatch({ type: 'conv', id, action: { type: 'conversation_error', message } }),
    );
  };

  // Cada conexión nueva: listado y apertura de la activa. Al perderla, lo que
  // estaba en vuelo no va a terminar.
  const connected = status.state === 'connected';
  useEffect(() => {
    if (connected) {
      post({ type: 'list_conversations' });
      open(stateRef.current.activeId);
    } else {
      dispatch({ type: 'connection_lost' });
    }
  }, [connected, open]);

  // Las conversaciones de fondo que ya no generan se cierran en el sidecar.
  useEffect(() => {
    if (!connected) return;
    for (const id of idleBackground(state)) {
      dispatch({ type: 'mark_open', id, open: false });
      post({ type: 'close_conversation', conversationId: id });
    }
  }, [state, connected]);

  const select = useCallback(
    (id: string) => {
      dispatch({ type: 'activate', id });
      if (stateRef.current.open[id] || status.state !== 'connected') return;
      open(id);
    },
    [open, status.state],
  );

  const newConversation = useCallback(() => {
    const current = stateRef.current;
    const c = current.byId[current.activeId];
    // La activa ya es una conversación vacía: no se crea otra.
    const listed = current.list.some((s) => s.conversationId === current.activeId);
    if (c && c.opened && c.messages.length === 0 && !listed) return;
    select(crypto.randomUUID());
  }, [select]);

  // La activa se eliminó (desde el sidebar): se sigue en una nueva.
  const activeDeleted = useRef(false);
  useEffect(() => {
    if (activeDeleted.current && !state.list.some((c) => c.conversationId === activeId)) {
      activeDeleted.current = false;
      select(crypto.randomUUID());
    }
  }, [state.list, activeId, select]);

  const rename = useCallback((id: string, title: string) => {
    const t = title.trim();
    if (t) post({ type: 'rename_conversation', conversationId: id, title: t });
  }, []);

  const remove = useCallback((id: string) => {
    if (id === stateRef.current.activeId) activeDeleted.current = true;
    dispatch({ type: 'mark_open', id, open: false });
    post({ type: 'delete_conversation', conversationId: id }, (message) =>
      dispatch({ type: 'conv', id, action: { type: 'conversation_error', message } }),
    );
  }, []);

  const pinConversation = useCallback((id: string, pinned: boolean) => {
    post({ type: 'workspace_pin', conversationId: id, pinned }, (message) =>
      dispatch({ type: 'conv', id, action: { type: 'conversation_error', message } }),
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Conversación activa
  // ---------------------------------------------------------------------------

  const conv = state.byId[activeId] ?? initialConversationState;
  const convRef = useRef(conv);
  convRef.current = conv;
  const report = useCallback(
    (prefix: string) => (message: string) =>
      dispatch({
        type: 'conv',
        id: stateRef.current.activeId,
        action: { type: 'conversation_error', message: `${prefix}: ${message}` },
      }),
    [],
  );

  const send = useCallback(
    (text: string, attachments: SentAttachment[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const c = convRef.current;
      if (c.activeTurnId || !c.opened) return;
      const id = activeId;
      const turnId = crypto.randomUUID();
      dispatch({ type: 'conv', id, action: { type: 'user_sent', turnId, text: trimmed, attachments } });
      post(
        {
          type: 'chat',
          conversationId: id,
          turnId,
          text: trimmed,
          ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.path) } : {}),
        },
        (message) => dispatch({ type: 'conv', id, action: { type: 'chat_rejected', turnId, message } }),
      );
    },
    [activeId],
  );

  const cancel = useCallback(() => {
    const turnId = convRef.current.activeTurnId;
    if (turnId) post({ type: 'cancel', conversationId: activeId, turnId });
  }, [activeId]);

  const answerQuestions = useCallback(
    (answers: QuestionAnswer[] | null) => {
      const pending = convRef.current.pendingQuestions;
      if (!pending) return;
      // El prompt sigue a la vista hasta el acuse del sidecar (`prompt_resolved`).
      post(
        { type: 'answer_questions', conversationId: activeId, requestId: pending.requestId, answers },
        report('No se pudo enviar la respuesta'),
      );
    },
    [activeId, report],
  );

  const confirm = useCallback(
    (decision: DestructiveDecision) => {
      const pending = convRef.current.pendingConfirm;
      if (!pending) return;
      post(
        { type: 'confirm_response', conversationId: activeId, callId: pending.callId, decision },
        report('No se pudo enviar la decisión'),
      );
    },
    [activeId, report],
  );

  const retry = useCallback(
    (turnId: string) => {
      const message = userMessageOf(convRef.current, turnId);
      if (message) send(message.text, message.attachments);
    },
    [send],
  );

  const pin = useCallback(
    (pinned: boolean) =>
      post({ type: 'workspace_pin', conversationId: activeId, pinned }, report('No se pudo fijar la conversación')),
    [activeId, report],
  );

  const clear = useCallback(
    () => post({ type: 'clear_conversation', conversationId: activeId }, report('No se pudo vaciar')),
    [activeId, report],
  );
  const compact = useCallback(
    () => post({ type: 'compact_conversation', conversationId: activeId }, report('No se pudo comprimir')),
    [activeId, report],
  );
  const listModels = useCallback(
    () => post({ type: 'list_models', conversationId: activeId }, report('No se pudieron listar los modelos')),
    [activeId, report],
  );
  const setModel = useCallback(
    (model: string) => {
      setModels(null);
      const m = model.trim();
      if (m) post({ type: 'set_model', conversationId: activeId, model: m }, report('No se pudo cambiar el modelo'));
    },
    [activeId, report],
  );
  const closeModels = useCallback(() => setModels(null), []);
  const dismissNotice = useCallback(
    () => dispatch({ type: 'conv', id: activeId, action: { type: 'dismiss_notice' } }),
    [activeId],
  );
  const dismissInfo = useCallback(
    () => dispatch({ type: 'conv', id: activeId, action: { type: 'dismiss_info' } }),
    [activeId],
  );

  const active: AgentStream = {
    ...conv,
    conversationId: activeId,
    send,
    cancel,
    answerQuestions,
    confirm,
    retry,
    pin,
    dismissNotice,
    dismissInfo,
  };

  const list = useMemo(() => {
    if (state.list.some((c) => c.conversationId === activeId)) return state.list;
    // La activa aún no está guardada: se muestra arriba como «Nueva conversación».
    const now = new Date().toISOString();
    const draft: ConversationSummary = {
      conversationId: activeId,
      title: conv.title ?? 'Nueva conversación',
      titleEdited: false,
      createdAt: now,
      updatedAt: now,
      provider: conv.stats?.provider ?? '',
      model: conv.stats?.model ?? '',
      turnCount: 0,
      workspace: conv.workspace,
    };
    return [draft, ...state.list];
  }, [state.list, activeId, conv.title, conv.stats, conv.workspace]);

  return {
    state,
    active,
    list,
    draftId: state.list.some((c) => c.conversationId === activeId) ? null : activeId,
    select,
    newConversation,
    rename,
    remove,
    pinConversation,
    clear,
    compact,
    listModels,
    setModel,
    models: models && models.conversationId === activeId ? models : null,
    closeModels,
  };
}
