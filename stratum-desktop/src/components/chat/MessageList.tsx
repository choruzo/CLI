import type { ChatMessage } from '../../hooks/conversation-reducer';
import { AgentMessage } from './AgentMessage';
import { UserMessage } from './UserMessage';

export function MessageList({
  messages,
  onRetry,
  conversationId,
}: {
  messages: ChatMessage[];
  onRetry: (turnId: string) => void;
  conversationId?: string;
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
            onRetry={() => onRetry(m.turnId)}
          />
        ),
      )}
    </div>
  );
}
