import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react';
import type { SendOutcome } from '../../client/actions';
import type { Notice } from '../../client/ui-store';
import { useAttachments } from '../../hooks/useAttachments';
import type { ProtocolTodo } from '../../protocol';
import type { ComposerMode } from '../../view/chat';
import type { AppMode } from '../../view/mode';
import type { ChatMessage, SentAttachment } from '../../view/model';
import { InputArea, type ComposerModel, type InputAreaHandle } from './InputArea';
import { MessageList } from './MessageList';
import { ModelPicker, type ModelChoice, type ModelsOffer } from './ModelPicker';
import { TodoPanel } from './TodoPanel';
import type { CommandName } from './commands';
import { ICON, StrokeIcon } from './icons';
import { userMessageAnchor } from '../layout/OutlinePanel';
import { AppLogo } from '../onboarding/AppLogo';

/** Sugerencias del estado vacío: rellenan el campo, no envían. */
export const SUGGESTIONS = [
  { label: 'Resume un documento', text: 'Resume el documento que adjunto: ' },
  { label: 'Redacta un correo', text: 'Redacta un correo para ' },
  { label: 'Explícame un concepto', text: 'Explícame, paso a paso, ' },
  { label: 'Planifica una tarea', text: 'Ayúdame a planificar ' },
] as const;

/** Estado vacío de una conversación: qué se ofrece antes del primer mensaje. */
export interface ConversationIntro {
  title: string;
  hint: string;
  suggestions: ReadonlyArray<{ label: string; text: string }>;
}

export const CHAT_INTRO: ConversationIntro = {
  title: '¿En qué puedo ayudarte?',
  hint: 'Adjunta ficheros con el botón + o soltándolos sobre la ventana. Escribe / para ver los comandos.',
  suggestions: SUGGESTIONS,
};

export const CODE_INTRO: ConversationIntro = {
  title: '¿Qué hacemos en este proyecto?',
  hint: 'El agente trabaja en la carpeta del proyecto: lee, edita y ejecuta con tus confirmaciones. Escribe / para ver los comandos.',
  suggestions: [
    { label: 'Explica el proyecto', text: 'Explícame cómo está organizado este proyecto y por dónde empezar a leerlo.' },
    { label: 'Arregla un fallo', text: 'Hay un fallo: ' },
    { label: 'Añade una función', text: 'Quiero añadir ' },
    { label: 'Revisa mis cambios', text: 'Revisa los cambios sin commitear y dime qué mejorarías.' },
  ],
};

/** Distancia al fondo por debajo de la cual se sigue el stream automáticamente. */
const STICK_PX = 80;

export interface ConversationViewHandle {
  focusInput: () => void;
  /** Salta con scroll suave a un mensaje del usuario (índice del sidebar). */
  jumpTo: (turnId: string) => void;
}

/**
 * La sesión que se mira, ya derivada de su foto (`view/chat.ts`). Nada de esto
 * es estado propio de Desktop: cambia cuando cambia la foto.
 */
export interface SessionStream {
  sessionId: string;
  /** Directorio de la sesión; los adjuntos solo valen en una carpeta de Desktop. */
  cwd: string | null;
  /** Ha llegado su foto. */
  loaded: boolean;
  messages: ChatMessage[];
  /** El run en marcha, si lo hay. */
  activeTurnId: string | null;
  todos: ProtocolTodo[];
  composer: ComposerMode;
  /** Un mensaje enviado que aún no se ve en la foto. */
  sending: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  historyError: string | null;
  /** Órdenes sobre el run pedidas y aún no reflejadas en la foto. */
  controls: Array<'pause' | 'resume' | 'cancel'>;
  notices: Notice[];
}

/**
 * Conversación de una sesión. El scroll sigue al stream mientras el usuario
 * esté abajo; si sube a leer algo, deja de arrastrarle y aparece «Ir al final»
 * (con un punto si llegó contenido nuevo). Arriba del todo se puede pedir lo
 * anterior (`sessions.history`, M11). Informa al índice del sidebar de qué
 * mensaje del usuario está a la vista.
 */
export const ConversationView = forwardRef(function ConversationView(
  {
    stream,
    onSend,
    onCancel,
    onControl,
    onLoadOlder,
    onDismissNotice,
    onCommand,
    onVisibleTurn,
    models,
    onPickModel,
    onCloseModels,
    model,
    pending,
    header,
    intro = CHAT_INTRO,
    mode = 'chat',
  }: {
    stream: SessionStream;
    onSend: (text: string, attachments: SentAttachment[]) => Promise<SendOutcome>;
    onCancel: () => void;
    onControl?: (action: 'pause' | 'resume' | 'cancel') => void;
    onLoadOlder: () => void;
    onDismissNotice: (id: number) => void;
    onCommand?: (name: CommandName, arg: string) => string | void;
    onVisibleTurn?: (turnId: string | null) => void;
    models?: ModelsOffer | null;
    onPickModel?: (choice: ModelChoice) => void;
    onCloseModels?: () => void;
    /** El botón «provider · modelo» del composer. */
    model?: ComposerModel;
    /** Lo que la sesión espera de una persona, para resolverlo (`PendingRequests`). */
    pending?: ReactNode;
    /** Barra propia del modo, encima de los mensajes (la de la sesión de código). */
    header?: ReactNode;
    intro?: ConversationIntro;
    /** De qué modo son los slash-commands del campo. */
    mode?: AppMode;
  },
  ref: Ref<ConversationViewHandle>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputAreaHandle>(null);
  const stickRef = useRef(true);
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

  // Un mensaje nuevo del usuario vuelve a anclar al fondo.
  const userCount = stream.messages.filter((m) => m.role === 'user').length;
  const seenUsers = useRef(userCount);
  if (userCount > seenUsers.current) stickRef.current = true;
  seenUsers.current = userCount;

  // Lo anterior se añade arriba: se conserva la posición de lectura.
  const firstId = stream.messages[0]?.turnId ?? null;
  const prevFirst = useRef(firstId);
  const anchorFromBottom = useRef<number | null>(null);
  if (firstId !== prevFirst.current && scrollRef.current && !stickRef.current) {
    anchorFromBottom.current = scrollRef.current.scrollHeight - scrollRef.current.scrollTop;
  }
  prevFirst.current = firstId;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchorFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - anchorFromBottom.current;
      anchorFromBottom.current = null;
    } else if (stickRef.current) el.scrollTop = el.scrollHeight;
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
  const empty = stream.loaded && stream.messages.length === 0 && !stream.hasOlder;
  const composer = stream.composer;
  const inputDisabled = composer.kind === 'none' || (stream.sending && composer.kind === 'ask');
  const attachments = useAttachments(stream.cwd, !inputDisabled && composer.kind === 'ask');

  const send = (text: string, sent: SentAttachment[]) => {
    void onSend(text, sent).then((outcome) => {
      if (outcome.restore) inputRef.current?.restore(text);
    });
  };

  return (
    <section className="conversation" aria-label="Conversación">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {header}
      <div className="conversation__viewport">
        <div
          className="conversation__scroll"
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          aria-label="Mensajes"
        >
          {stream.hasOlder && (
            <div className="conversation__older">
              <button
                type="button"
                className="button"
                onClick={onLoadOlder}
                disabled={stream.loadingOlder}
              >
                {stream.loadingOlder ? 'Cargando…' : 'Ver mensajes anteriores'}
              </button>
              {stream.historyError && (
                <p className="notice" data-tone="warning" role="status">
                  {stream.historyError}
                </p>
              )}
            </div>
          )}
          {!stream.loaded ? (
            <p className="conversation__loading" role="status">
              Cargando la conversación…
            </p>
          ) : empty ? (
            <div className="conversation__empty">
              <AppLogo className="conversation__empty-logo" />
              <p className="conversation__empty-title">{intro.title}</p>
              <p className="conversation__empty-hint">{intro.hint}</p>
              <div className="conversation__suggestions" role="group" aria-label="Sugerencias">
                {intro.suggestions.map((s) => (
                  <button
                    key={s.label}
                    type="button"
                    className="chip"
                    disabled={inputDisabled}
                    onClick={() => {
                      inputRef.current?.fill(s.text);
                      inputRef.current?.focus();
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList
              messages={stream.messages}
              onRetry={() => undefined}
              canRetry={false}
              cwd={stream.cwd ?? undefined}
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

      {stream.notices.map((n) => (
        <p
          key={n.id}
          className="notice notice--dismissable"
          data-tone={n.tone}
          role={n.tone === 'info' ? 'status' : 'alert'}
        >
          {n.text}
          <button
            type="button"
            className="icon-button"
            aria-label="Cerrar aviso"
            onClick={() => onDismissNotice(n.id)}
          >
            ×
          </button>
        </p>
      ))}
      {pending}
      {models && onPickModel && onCloseModels && (
        <ModelPicker offer={models} onPick={onPickModel} onClose={onCloseModels} />
      )}
      <TodoPanel items={stream.todos} />
      {composer.kind === 'steer' && onControl && (
        <RunControls paused={composer.paused} pending={stream.controls} onControl={onControl} />
      )}
      {composer.kind === 'none' && stream.loaded && (
        <p className="notice" data-tone="info" role="status">
          {composer.reason}
        </p>
      )}
      <InputArea
        ref={inputRef}
        disabled={inputDisabled}
        generating={generating}
        steer={composer.kind === 'steer'}
        onSend={send}
        onCommand={onCommand}
        attachments={composer.kind === 'ask' && stream.cwd ? attachments : undefined}
        onCancel={onCancel}
        placeholder={placeholderOf(composer, stream.sending)}
        model={model}
        mode={mode}
      />
    </section>
  );
});

/**
 * Pausar, reanudar y cancelar el run en marcha. Una orden aceptada se rotula
 * «pedida» hasta que el anfitrión publica el cambio: no se adelanta el estado.
 */
function RunControls({
  paused,
  pending,
  onControl,
}: {
  paused: boolean;
  pending: Array<'pause' | 'resume' | 'cancel'>;
  onControl: (action: 'pause' | 'resume' | 'cancel') => void;
}) {
  const asked = (a: 'pause' | 'resume' | 'cancel') => pending.includes(a);
  return (
    <div className="run-controls" role="group" aria-label="Trabajo en marcha">
      <span className="run-controls__state" role="status">
        {asked('cancel')
          ? 'Cancelación pedida…'
          : asked('pause')
            ? 'Pausa pedida…'
            : asked('resume')
              ? 'Reanudación pedida…'
              : paused
                ? 'En pausa'
                : 'Trabajando'}
      </span>
      {paused ? (
        <button type="button" className="button" disabled={asked('resume')} onClick={() => onControl('resume')}>
          Reanudar
        </button>
      ) : (
        <button type="button" className="button" disabled={asked('pause')} onClick={() => onControl('pause')}>
          Pausar
        </button>
      )}
      <button
        type="button"
        className="button button--danger"
        disabled={asked('cancel')}
        onClick={() => onControl('cancel')}
      >
        Cancelar
      </button>
    </div>
  );
}

function placeholderOf(composer: ComposerMode, sending: boolean): string {
  if (sending) return 'Enviando…';
  switch (composer.kind) {
    case 'ask':
      return 'Escribe un mensaje…';
    case 'steer':
      return composer.paused
        ? 'En pausa: escribe para redirigirla al reanudar…'
        : 'Trabajando: escribe para redirigirla…';
    case 'none':
      return composer.reason;
  }
}

/**
 * Texto para el lector de pantalla cuando un turno empieza o termina. Cambiar
 * de sesión no anuncia nada: el componente se monta de nuevo.
 */
function useTurnAnnouncement(stream: SessionStream): string {
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
