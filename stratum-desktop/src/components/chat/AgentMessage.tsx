import { useEffect, useRef, type RefObject } from 'react';
import type { AgentPart, AgentTurn } from '../../hooks/conversation-reducer';
import { useCopy } from '../../hooks/useCopy';
import { useNow } from '../../hooks/useNow';
import { ReasoningBlock } from './ReasoningBlock';
import { StreamingText } from './StreamingText';
import { ThinkingIndicator } from './ThinkingIndicator';
import type { ThinkingPhase } from './thinking-phrases';
import { ToolCallBlock } from './ToolCallBlock';
import { FileCard, isExpired } from './files/FileCard';
import { ICON, StrokeIcon } from './icons';

const STATUS_NOTE: Partial<Record<AgentTurn['status'], string>> = {
  cancelled: 'Respuesta detenida.',
  interrupted: 'El agente se reinició y esta respuesta quedó a medias.',
};

/**
 * Qué está haciendo un turno en marcha, o `null` si el texto está llegando
 * (entonces el cursor ya dice que sigue vivo).
 */
export function turnPhase(turn: Pick<AgentTurn, 'parts' | 'toolCalls'>): ThinkingPhase | null {
  const last: AgentPart | undefined = turn.parts[turn.parts.length - 1];
  if (!last) return 'waiting';
  if (last.kind === 'text') return null;
  if (last.kind === 'reasoning') return last.endedAt === undefined ? 'reasoning' : 'waiting';
  if (last.kind === 'tool') {
    const state = turn.toolCalls[last.id]?.state;
    return state === 'pending' || state === 'running' ? 'tool' : 'waiting';
  }
  return 'waiting';
}

/** Markdown de la respuesta: solo el texto, sin razonamiento ni tool calls. */
export function turnMarkdown(turn: Pick<AgentTurn, 'parts'>): string {
  return turn.parts
    .flatMap((p) => (p.kind === 'text' && p.text.trim() ? [p.text.trim()] : []))
    .join('\n\n');
}

/**
 * Texto visible de la respuesta, tal como se lee (sin `**`, `#`, vallas…).
 * `innerText` necesita maquetación para respetar los saltos entre bloques, así
 * que una copia sin las cabeceras de los bloques de código («ts · Copiar») se
 * monta un instante fuera de pantalla. Solo ocurre al pulsar el botón.
 */
function renderedText(message: HTMLElement | null): string {
  const blocks = message?.querySelectorAll<HTMLElement>(':scope > .streaming-text > .markdown');
  if (!blocks || blocks.length === 0) return '';
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:800px';
  for (const block of blocks) {
    const clone = block.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.code-block__header').forEach((h) => h.remove());
    holder.append(clone);
  }
  document.body.append(holder);
  try {
    return holder.innerText.trim();
  } finally {
    holder.remove();
  }
}

/**
 * Acciones de un turno cerrado: copiar el texto (lo que se ve), copiar el
 * markdown y reintentar. Se muestran al pasar el ratón o con el foco dentro
 * del mensaje.
 */
function MessageActions({
  markdown,
  messageRef,
  onRetry,
}: {
  markdown: string;
  messageRef: RefObject<HTMLDivElement>;
  onRetry?: () => void;
}) {
  const [copied, copy] = useCopy();
  if (!markdown && !onRetry) return null;
  return (
    <div className="message__actions" role="toolbar" aria-label="Acciones de la respuesta">
      {markdown && (
        <>
          <button
            type="button"
            className="message__action"
            aria-label={copied === 'text' ? 'Copiado' : 'Copiar respuesta'}
            title="Copiar respuesta"
            onClick={() => void copy(renderedText(messageRef.current) || markdown, 'text')}
          >
            <StrokeIcon d={copied === 'text' ? ICON.check : ICON.copy} />
          </button>
          <button
            type="button"
            className="message__action"
            aria-label={copied === 'md' ? 'Copiado' : 'Copiar como markdown'}
            title="Copiar como markdown"
            onClick={() => void copy(markdown, 'md')}
          >
            <StrokeIcon d={copied === 'md' ? ICON.check : ICON.markdown} />
          </button>
        </>
      )}
      {onRetry && (
        <button
          type="button"
          className="message__action"
          aria-label="Reintentar respuesta"
          title="Reintentar (reenvía tu mensaje)"
          onClick={onRetry}
        >
          <StrokeIcon d={ICON.retry} />
        </button>
      )}
    </div>
  );
}

/** Respuesta del asistente: razonamiento, texto, tool calls y avisos en el orden en que llegaron. */
export function AgentMessage({
  turn,
  onRetry,
  canRetry = false,
  conversationId,
  filesExpiredAt,
}: {
  turn: AgentTurn;
  /** Los ficheros anteriores a esta fecha se purgaron (D3): tarjetas «caducado». */
  filesExpiredAt?: string | null;
  /** Para las tarjetas de fichero (D2); sin él no se pintan. */
  conversationId?: string;
  /** Reenvía el mensaje del usuario de este turno. */
  onRetry?: () => void;
  /** No hay ningún turno en marcha: la barra de acciones ofrece reintentar. */
  canRetry?: boolean;
}) {
  const messageRef = useRef<HTMLDivElement>(null);
  const streaming = turn.status === 'streaming';
  const queued = turn.status === 'queued';
  const lastText = turn.parts.map((p) => p.kind).lastIndexOf('text');
  const note = STATUS_NOTE[turn.status];
  const phase = streaming ? turnPhase(turn) : null;
  const now = useNow(streaming);
  // Inicio del turno visto desde aquí: al salir de la cola, o al montar uno ya en marcha.
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (streaming && startedAt.current === null) startedAt.current = Date.now();
    if (!streaming) startedAt.current = null;
  }, [streaming]);
  const elapsed = startedAt.current === null ? 0 : now - startedAt.current;

  return (
    <div className="message message--agent" aria-busy={streaming || queued} ref={messageRef}>
      {turn.parts.map((part, i) => {
        if (part.kind === 'text') {
          return <StreamingText key={i} text={part.text} streaming={streaming && i === lastText} />;
        }
        if (part.kind === 'reasoning') {
          return (
            <ReasoningBlock
              key={i}
              text={part.text}
              live={streaming && part.endedAt === undefined && part.startedAt !== undefined}
              startedAt={part.startedAt}
              endedAt={part.endedAt}
              now={now}
            />
          );
        }
        if (part.kind === 'tool') {
          const call = turn.toolCalls[part.id];
          return call ? <ToolCallBlock key={part.id} call={call} /> : null;
        }
        return (
          <p key={i} className="notice" data-tone={part.tone} role={part.tone === 'error' ? 'alert' : undefined}>
            {part.text}
          </p>
        );
      })}
      {conversationId && turn.files && turn.files.length > 0 && (
        <div className="file-cards" aria-label="Ficheros generados">
          {turn.files.map((f) => (
            <FileCard
              key={f.path}
              conversationId={conversationId}
              file={f}
              expired={isExpired(f, filesExpiredAt)}
            />
          ))}
        </div>
      )}
      {queued && (
        <p className="message__thinking" aria-live="polite">
          En cola: empezará cuando termine otra conversación
          {turn.queuePosition && turn.queuePosition > 1 ? ` (${turn.queuePosition}.º)` : ''}.
        </p>
      )}
      {phase && <ThinkingIndicator seed={turn.turnId} phase={phase} elapsedMs={elapsed} />}
      {note && (
        <p className="notice" data-tone="muted">
          {note}
          {onRetry && turn.status === 'interrupted' && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={onRetry}>
                Reintentar
              </button>
            </>
          )}
        </p>
      )}
      {!streaming && !queued && (
        <MessageActions
          markdown={turnMarkdown(turn)}
          messageRef={messageRef}
          onRetry={canRetry ? onRetry : undefined}
        />
      )}
    </div>
  );
}
