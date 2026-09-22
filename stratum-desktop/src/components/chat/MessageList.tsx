import type { ChatMessage } from '../../hooks/conversation-reducer';
import { AgentMessage } from './AgentMessage';
import { UserMessage } from './UserMessage';

export function MessageList({
  messages,
  onRetry,
  conversationId,
  filesExpiredAt,
}: {
  messages: ChatMessage[];
  onRetry: (turnId: string) => void;
  conversationId?: string;
  filesExpiredAt?: string | null;
}) {
  return (
    <div className="message-list">
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserMessage key={`u-${m.turnId}`} text={m.text} attachments={m.attachments} />
        ) : (
          <AgentMessage
            key={`a-${m.turnId}`}
            turn={m}
            conversationId={conversationId}
            filesExpiredAt={filesExpiredAt}
            onRetry={() => onRetry(m.turnId)}
          />
        ),
      )}
    </div>
  );
}
