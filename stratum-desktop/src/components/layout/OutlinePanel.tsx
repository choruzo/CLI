import type { ChatMessage } from '../../hooks/conversation-reducer';

/** Id del elemento de un mensaje de usuario, ancla del índice (§7.2). */
export const userMessageAnchor = (turnId: string): string => `msg-${turnId}`;

/** Primeros ~50 caracteres de un mensaje, en una línea. */
export function outlineLabel(text: string, fallback: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return line.length > 50 ? `${line.slice(0, 50).trimEnd()}…` : line;
}

/**
 * Índice de la conversación activa (§7.2): los mensajes del usuario como
 * anclas, con scroll suave y el que está a la vista resaltado.
 */
export function OutlinePanel({
  messages,
  visibleTurnId,
  onJump,
}: {
  messages: ChatMessage[];
  visibleTurnId: string | null;
  onJump: (turnId: string) => void;
}) {
  const users = messages.filter((m) => m.role === 'user');
  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Índice</h2>
      </div>
      <div className="side-panel__body">
        {users.length === 0 ? (
          <p className="side-panel__empty">
            La conversación está vacía.
            <br />
            Escribe un mensaje para empezar.
          </p>
        ) : (
          <ol className="outline-list">
            {users.map((m) => (
              <li key={m.turnId}>
                <button
                  type="button"
                  className="outline-item"
                  data-active={m.turnId === visibleTurnId || undefined}
                  aria-current={m.turnId === visibleTurnId ? 'location' : undefined}
                  onClick={() => onJump(m.turnId)}
                >
                  {outlineLabel(
                    m.text,
                    m.attachments?.map((a) => a.name).join(', ') || '(sin texto)',
                  )}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
