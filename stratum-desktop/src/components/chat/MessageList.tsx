import type { ChatMessage } from '../../hooks/conversation-reducer';
import { AgentMessage } from './AgentMessage';
import { UserMessage } from './UserMessage';
import { userMessageAnchor } from '../layout/OutlinePanel';

export function MessageList({
  messages,
  onRetry,
  conversationId,
  filesExpiredAt,
  canRetry = false,
}: {
  messages: ChatMessage[];
  onRetry: (turnId: string) => void;
  conversationId?: string;
  filesExpiredAt?: string | null;
  /** No hay ningún turno en marcha: las respuestas se pueden reintentar. */
  canRetry?: boolean;
}) {
  return (
    <div className="message-list">
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserMessage
            key={`u-${m.turnId}`}
            id={userMessageAnchor(m.turnId)}
            turnId={m.turnId}
            text={m.text}
            attachments={m.attachments}
          />
        ) : (
          <AgentMessage
            key={`a-${m.turnId}`}
            turn={m}
            conversationId={conversationId}
            filesExpiredAt={filesExpiredAt}
            onRetry={() => onRetry(m.turnId)}
            canRetry={canRetry}
          />
        ),
      )}
    </div>
  );
}
