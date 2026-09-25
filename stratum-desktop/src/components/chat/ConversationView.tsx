import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { AgentStream } from '../../hooks/useAgentStream';
import type { ModelsOffer } from '../../hooks/useConversations';
import { useAttachments } from '../../hooks/useAttachments';
import { ConfirmDialog } from './ConfirmDialog';
import { InputArea, type InputAreaHandle } from './InputArea';
import { MessageList } from './MessageList';
import { ModelPicker } from './ModelPicker';
import { QuestionPrompt } from './QuestionPrompt';
import { RetentionBanner } from './RetentionBanner';
import { TodoPanel } from './TodoPanel';
import type { CommandName } from './commands';
import { ICON, StrokeIcon } from './icons';
import { userMessageAnchor } from '../layout/OutlinePanel';
import { AppLogo } from '../onboarding/AppLogo';

/** Distancia al fondo por debajo de la cual se sigue el stream automáticamente. */
const STICK_PX = 80;

export interface ConversationViewHandle {
  focusInput: () => void;
  /** Salta con scroll suave a un mensaje del usuario (índice del sidebar). */
  jumpTo: (turnId: string) => void;
}

/**
 * Conversación con el asistente. El scroll sigue al stream mientras el usuario
 * esté abajo; si sube a leer algo, deja de arrastrarle y aparece «Ir al final»
 * (con un punto si llegó contenido nuevo). Informa al índice del sidebar de qué
 * mensaje del usuario está a la vista.
 */
export const ConversationView = forwardRef(function ConversationView(
  {
    stream,
    connected,
    onCommand,
    onVisibleTurn,
    models,
    onPickModel,
    onCloseModels,
    confirmClear,
    onConfirmClear,
    onCancelClear,
  }: {
    stream: AgentStream;
    connected: boolean;
    onCommand?: (name: CommandName, arg: string) => void;
    onVisibleTurn?: (turnId: string | null) => void;
    models?: ModelsOffer | null;
    onPickModel?: (model: string) => void;
    onCloseModels?: () => void;
    /** `/clear` o `Ctrl+L` pidió vaciar: confirmación en la propia conversación. */
    confirmClear?: boolean;
    onConfirmClear?: () => void;
    onCancelClear?: () => void;
  },
  ref: Ref<ConversationViewHandle>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputAreaHandle>(null);
  const stickRef = useRef(true);
  // «Ir al final»: visible si el usuario subió; `unread` si desde entonces
  // llegó contenido (creció la altura del scroll).
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false);
  const lastHeight = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      focusInput: () => inputRef.current?.focus(),
      jumpTo: (turnId) => {
        stickRef.current = false;
        document
          .getElementById(userMessageAnchor(turnId))
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }),
    [],
  );

  const reportVisible = () => {
    const el = scrollRef.current;
    if (!el || !onVisibleTurn) return;
    // El último mensaje del usuario cuyo inicio ya pasó el tercio superior.
    const top = el.getBoundingClientRect().top + el.clientHeight / 3;
    let current: string | null = null;
    for (const node of el.querySelectorAll<HTMLElement>('[data-user-turn]')) {
      if (node.getBoundingClientRect().top <= top) current = node.dataset.userTurn ?? null;
      else break;
    }
    if (!current) {
      const first = el.querySelector<HTMLElement>('[data-user-turn]');
      current = first?.dataset.userTurn ?? null;
    }
    onVisibleTurn(current);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stickRef.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnread(false);
    reportVisible();
  };

  // Un mensaje nuevo del usuario vuelve a anclar al fondo aunque antes hubiera
  // subido a leer: acaba de escribir y quiere ver la respuesta.
  const userCount = stream.messages.filter((m) => m.role === 'user').length;
  const seenUsers = useRef(userCount);
  if (userCount > seenUsers.current) stickRef.current = true;
  seenUsers.current = userCount;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
    else if (el.scrollHeight > lastHeight.current) setUnread(true);
    lastHeight.current = el.scrollHeight;
  });
  useEffect(reportVisible, [userCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    setUnread(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const generating = stream.activeTurnId !== null;
  const announcement = useTurnAnnouncement(stream);
  const empty = stream.messages.length === 0;
  const inputDisabled = !connected || !stream.opened || stream.pendingQuestions !== null;
  const attachments = useAttachments(stream.conversationId, !inputDisabled);

  return (
    <section className="conversation" aria-label="Conversación">
      {/* Un anuncio por turno (empieza, termina): el texto en streaming no se lee a trozos. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="conversation__viewport">
        <div
          className="conversation__scroll"
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Mensajes"
        >
          {empty ? (
            <div className="conversation__empty">
              <AppLogo className="conversation__empty-logo" />
              <p className="conversation__empty-title">¿En qué puedo ayudarte?</p>
              <p className="conversation__empty-hint">
                Adjunta ficheros con el botón + o soltándolos sobre la ventana. Escribe / para ver los
                comandos.
              </p>
            </div>
          ) : (
            <MessageList
              messages={stream.messages}
              onRetry={stream.retry}
              canRetry={!generating && connected}
              conversationId={stream.conversationId}
              filesExpiredAt={stream.workspace?.filesExpiredAt}
            />
          )}
        </div>
        {away && !empty && (
          <button
            type="button"
            className="jump-to-end"
            data-unread={unread || undefined}
            aria-label={unread ? 'Ir al final (hay contenido nuevo)' : 'Ir al final'}
            title="Ir al final"
            onClick={scrollToEnd}
          >
            <StrokeIcon d={ICON.arrowDown} size={16} />
          </button>
        )}
      </div>

      {stream.notice && (
        <p className="notice notice--dismissable" data-tone="warning" role="alert">
          {stream.notice}
          <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={stream.dismissNotice}>
            ×
          </button>
        </p>
      )}
      {stream.info && (
        <p className="notice notice--dismissable" data-tone="info" role="status">
          {stream.info}
          <button type="button" className="icon-button" aria-label="Cerrar aviso" onClick={stream.dismissInfo}>
            ×
          </button>
        </p>
      )}
      {confirmClear && (
        <section className="confirm-bar" role="alertdialog" aria-label="Vaciar la conversación">
          <p>
            ¿Vaciar esta conversación? Se borra el historial (también para el asistente); los
            ficheros se conservan.
          </p>
          <span className="confirm-bar__actions">
            <button type="button" className="button" onClick={onCancelClear} autoFocus>
              Cancelar
            </button>
            <button type="button" className="button button--danger" onClick={onConfirmClear}>
              Vaciar
            </button>
          </span>
        </section>
      )}
      {models && onPickModel && onCloseModels && (
        <ModelPicker offer={models} onPick={onPickModel} onClose={onCloseModels} />
      )}
      <RetentionBanner
        status={stream.workspace}
        conversationId={stream.conversationId}
        onPin={stream.pin}
      />
      <TodoPanel items={stream.todos} />
      {stream.pendingConfirm && (
        <ConfirmDialog request={stream.pendingConfirm} onDecide={stream.confirm} />
      )}
      {stream.pendingQuestions && (
        <QuestionPrompt
          key={stream.pendingQuestions.requestId}
          questions={stream.pendingQuestions.questions}
          onSubmit={stream.answerQuestions}
        />
      )}
      <InputArea
        ref={inputRef}
        disabled={inputDisabled}
        generating={generating}
        onSend={stream.send}
        onCommand={onCommand}
        attachments={attachments}
        onCancel={stream.cancel}
        placeholder={connected ? 'Escribe un mensaje…' : 'Esperando al agente…'}
      />
    </section>
  );
});

/**
 * Texto para el lector de pantalla cuando un turno empieza o termina. Cambiar
 * de conversación no anuncia nada: el componente se monta de nuevo.
 */
function useTurnAnnouncement(stream: AgentStream): string {
  const [text, setText] = useState('');
  const previous = useRef(stream.activeTurnId);
  useEffect(() => {
    const was = previous.current;
    previous.current = stream.activeTurnId;
    if (stream.activeTurnId && stream.activeTurnId !== was) {
      setText('Stratum está trabajando en la respuesta.');
    } else if (was && !stream.activeTurnId) {
      const turn = stream.messages.find((m) => m.role === 'agent' && m.turnId === was);
      const status = turn?.role === 'agent' ? turn.status : 'done';
      setText(
        status === 'cancelled'
          ? 'Respuesta detenida.'
          : status === 'error'
            ? 'La respuesta terminó con un error.'
            : 'Respuesta lista.',
      );
    }
  }, [stream.activeTurnId, stream.messages]);
  return text;
}
