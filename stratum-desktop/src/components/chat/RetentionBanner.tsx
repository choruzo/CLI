import { useEffect, useState } from 'react';
import type { WorkspaceStatus } from '../../ipc/types';
import { errorMessage, exportWorkspace } from '../../ipc/files';

/**
 * Espejo de `PURGE_WARNING_DAYS` (`stratum-cli/src/desktop/protocol.ts`): días
 * antes de la purga en los que se avisa. Un test comprueba que coinciden.
 */
export const PURGE_WARNING_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Cada cuánto se reevalúa si toca avisar con la app abierta. */
const TICK_MS = 60 * 60 * 1000;

/** ¿Falta poco para la purga? Puro, para los tests. */
export function purgeIsNear(status: WorkspaceStatus | null, now: number): boolean {
  if (!status?.purgeAt || status.pinned || status.state === 'purged') return false;
  return Date.parse(status.purgeAt) - now <= PURGE_WARNING_DAYS * DAY_MS;
}

/** «hoy», «mañana», «en 3 días», con la fecha. */
export function describePurge(purgeAt: string, now: number): string {
  const at = new Date(purgeAt);
  const days = Math.ceil((at.getTime() - now) / DAY_MS);
  const date = at.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  if (days <= 0) return `hoy (${date})`;
  if (days === 1) return `mañana (${date})`;
  return `en ${days} días (${date})`;
}

/**
 * Retención del workspace de la conversación (D3, 16.7): indicador mientras se
 * restauran los ficheros de una conversación archivada, y aviso cuando falta
 * poco para la purga, con «Fijar» y «Descargar todo (.zip)».
 */
export function RetentionBanner({
  status,
  conversationId,
  onPin,
}: {
  status: WorkspaceStatus | null;
  conversationId: string;
  onPin: (pinned: boolean) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [exportNote, setExportNote] = useState<{ tone: 'error' | 'muted'; text: string } | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  if (status?.state === 'restoring') {
    return (
      <p className="retention" data-tone="info" role="status" aria-live="polite">
        Restaurando los ficheros de esta conversación…
      </p>
    );
  }
  if (!status || !purgeIsNear(status, now)) return null;

  const download = () => {
    setExportNote(null);
    setExporting(true);
    exportWorkspace(conversationId)
      .then((saved) => saved && setExportNote({ tone: 'muted', text: 'Descargado.' }))
      .catch((err) => setExportNote({ tone: 'error', text: errorMessage(err) }))
      .finally(() => setExporting(false));
  };

  return (
    <section className="retention" data-tone="warning" role="alert">
      <p className="retention__text">
        Los ficheros de esta conversación se eliminarán {describePurge(status.purgeAt!, now)} por
        falta de uso. La conversación se conserva.
      </p>
      <span className="retention__actions">
        <button type="button" className="button" onClick={() => onPin(true)}>
          Fijar
        </button>
        <button type="button" className="button" onClick={download} disabled={exporting}>
          {exporting ? 'Preparando…' : 'Descargar todo (.zip)'}
        </button>
      </span>
      {exportNote && (
        <p className="notice" data-tone={exportNote.tone}>
          {exportNote.text}
        </p>
      )}
    </section>
  );
}
