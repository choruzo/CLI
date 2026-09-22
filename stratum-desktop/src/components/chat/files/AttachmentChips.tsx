import type { DraftAttachment } from '../../../hooks/useAttachments';
import type { SentAttachment } from '../../../hooks/conversation-reducer';
import { formatBytes } from '../../../ipc/files';

const STATUS_TEXT: Record<DraftAttachment['status'], string> = {
  copying: 'Copiando…',
  ready: '',
  rejected: 'No se adjuntará',
};

/** Adjuntos del mensaje en preparación: copiando, listos o rechazados (con motivo). */
export function DraftChips({
  items,
  onRemove,
}: {
  items: DraftAttachment[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="attachments" aria-label="Ficheros adjuntos">
      {items.map((a) => (
        <li key={a.id} className="attachment" data-status={a.status}>
          <span className="attachment__name">{a.name}</span>
          <span className="attachment__detail">
            {a.status === 'rejected'
              ? `${STATUS_TEXT.rejected}: ${a.error ?? 'error desconocido'}`
              : a.status === 'copying'
                ? STATUS_TEXT.copying
                : formatBytes(a.size)}
          </span>
          <button
            type="button"
            className="attachment__remove"
            aria-label={`Quitar ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Adjuntos ya enviados, en la burbuja del usuario. */
export function SentChips({ items }: { items: SentAttachment[] }) {
  return (
    <ul className="attachments attachments--sent" aria-label="Ficheros adjuntos">
      {items.map((a) => (
        <li key={a.path} className="attachment" data-status="ready">
          <span className="attachment__name">{a.name}</span>
          <span className="attachment__detail">{formatBytes(a.size)}</span>
        </li>
      ))}
    </ul>
  );
}
