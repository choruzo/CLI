import type { ChatMessage } from '../../hooks/conversation-reducer';
import { AgentMessage } from './AgentMessage';
import { UserMessage } from './UserMessage';

export function MessageList({
  messages,
  onRetry,
}: {
  messages: ChatMessage[];
  onRetry: (turnId: string) => void;
}) {
  return (
    <div className="message-list">
      {messages.map((m) =>
        m.role === 'user' ? (
          <UserMessage key={`u-${m.turnId}`} text={m.text} />
        ) : (
          <AgentMessage key={`a-${m.turnId}`} turn={m} onRetry={() => onRetry(m.turnId)} />
        ),
      )}
    </div>
  );
}
