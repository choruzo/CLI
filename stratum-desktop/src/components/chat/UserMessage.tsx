import type { SentAttachment } from '../../hooks/conversation-reducer';
import { SentChips } from './files/AttachmentChips';

/** Mensaje del usuario: texto plano, nunca markdown (es lo que escribió), y sus adjuntos. */
export function UserMessage({
  text,
  attachments,
}: {
  text: string;
  attachments?: SentAttachment[];
}) {
  return (
    <div className="message message--user">
      <div className="message__bubble">
        {attachments && attachments.length > 0 && <SentChips items={attachments} />}
        {text}
      </div>
    </div>
  );
}
