import type { AgentTurn } from '../../hooks/conversation-reducer';
import { StreamingText } from './StreamingText';
import { ToolCallBlock } from './ToolCallBlock';
import { FileCard } from './files/FileCard';

const STATUS_NOTE: Partial<Record<AgentTurn['status'], string>> = {
  cancelled: 'Respuesta detenida.',
  interrupted: 'El agente se reinició y esta respuesta quedó a medias.',
};

/** Respuesta del asistente: texto, tool calls y avisos en el orden en que llegaron. */
export function AgentMessage({
  turn,
  onRetry,
  conversationId,
}: {
  turn: AgentTurn;
  /** Para las tarjetas de fichero (D2); sin él no se pintan. */
  conversationId?: string;
  /** Solo en turnos interrumpidos: reenvía el mensaje del usuario. */
  onRetry?: () => void;
}) {
  const streaming = turn.status === 'streaming';
  const lastText = turn.parts.map((p) => p.kind).lastIndexOf('text');
  const note = STATUS_NOTE[turn.status];

  return (
    <div className="message message--agent" aria-busy={streaming}>
      {turn.parts.map((part, i) => {
        if (part.kind === 'text') {
          return <StreamingText key={i} text={part.text} streaming={streaming && i === lastText} />;
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
            <FileCard key={f.path} conversationId={conversationId} file={f} />
          ))}
        </div>
      )}
      {streaming && turn.parts.length === 0 && (
        <p className="message__thinking" aria-live="polite">
          Pensando…
        </p>
      )}
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
    </div>
  );
}
