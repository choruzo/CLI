import { useEffect, useRef } from 'react';
import type { AgentStream } from '../../hooks/useAgentStream';
import { ConfirmDialog } from './ConfirmDialog';
import { InputArea } from './InputArea';
import { MessageList } from './MessageList';
import { QuestionPrompt } from './QuestionPrompt';
import { TodoPanel } from './TodoPanel';

/** Distancia al fondo por debajo de la cual se sigue el stream automáticamente. */
const STICK_PX = 80;

/**
 * Conversación con el asistente. El scroll sigue al stream mientras el usuario
 * esté abajo; si sube a leer algo, deja de arrastrarle.
 */
export function ConversationView({ stream, connected }: { stream: AgentStream; connected: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  // Un mensaje nuevo del usuario vuelve a anclar al fondo aunque antes hubiera
  // subido a leer: acaba de escribir y quiere ver la respuesta.
  const userCount = stream.messages.filter((m) => m.role === 'user').length;
  const seenUsers = useRef(userCount);
  if (userCount > seenUsers.current) stickRef.current = true;
  seenUsers.current = userCount;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const generating = stream.activeTurnId !== null;
  const empty = stream.messages.length === 0;

  return (
    <section className="conversation" aria-label="Conversación">
      <div className="conversation__scroll" ref={scrollRef} onScroll={onScroll}>
        {empty ? (
          <div className="conversation__empty">
            <p>¿En qué puedo ayudarte?</p>
          </div>
        ) : (
          <MessageList messages={stream.messages} onRetry={stream.retry} />
        )}
      </div>

      {stream.notice && (
        <p className="notice" data-tone="warning" role="alert">
          {stream.notice}
        </p>
      )}
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
        disabled={!connected || !stream.opened || stream.pendingQuestions !== null}
        generating={generating}
        onSend={stream.send}
        onCancel={stream.cancel}
        placeholder={connected ? 'Escribe un mensaje…' : 'Esperando al agente…'}
      />
    </section>
  );
}
