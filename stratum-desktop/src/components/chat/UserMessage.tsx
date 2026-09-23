import type { SentAttachment } from '../../hooks/conversation-reducer';
import { SentChips } from './files/AttachmentChips';

/** Mensaje del usuario: texto plano, nunca markdown (es lo que escribió), y sus adjuntos. */
export function UserMessage({
  text,
  attachments,
  id,
  turnId,
}: {
  text: string;
  attachments?: SentAttachment[];
  /** Ancla del índice del sidebar (§7.2). */
  id?: string;
  turnId?: string;
}) {
  return (
    <div className="message message--user" id={id} data-user-turn={turnId}>
      <div className="message__bubble">
        {attachments && attachments.length > 0 && <SentChips items={attachments} />}
        {text}
      </div>
    </div>
  );
}
