import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addAttachments,
  discardAttachment,
  errorMessage,
  onDragState,
  onDropped,
  pickAttachments,
  type Candidate,
} from '../ipc/files';

/**
 * Adjuntos del mensaje que se está escribiendo (D2).
 *
 * Flujo: el usuario elige (botón o soltar) → Rust devuelve candidatos → los que
 * superan un límite se muestran como rechazados **sin copiarse** → el resto se
 * copian al `inputs/` del workspace en el acto (el error aparece ya, no al
 * enviar). Quitar un adjunto listo antes de enviar lo borra del workspace.
 */

export type DraftStatus = 'copying' | 'ready' | 'rejected';

export interface DraftAttachment {
  /** Id de la concesión de Rust; clave estable del chip. */
  id: string;
  name: string;
  size: number;
  status: DraftStatus;
  /** Ruta en el workspace, con `status: 'ready'`. */
  path?: string;
  error?: string;
}

export interface Attachments {
  items: DraftAttachment[];
  /** Arrastrando ficheros sobre la ventana. */
  dragging: boolean;
  /** Rutas listas para el `chat`. */
  readyPaths: string[];
  busy: boolean;
  pick: () => void;
  remove: (id: string) => void;
  /** Tras enviar: los adjuntos ya son parte de la conversación. */
  clear: () => void;
  /** Error que no es de ningún fichero (diálogo, conexión). */
  error: string | null;
}

export function candidatesToDrafts(candidates: Candidate[]): DraftAttachment[] {
  return candidates.map((c) => ({
    id: c.id,
    name: c.name,
    size: c.size,
    status: c.error ? 'rejected' : 'copying',
    error: c.error,
  }));
}

export function useAttachments(conversationId: string, enabled: boolean): Attachments {
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const patch = (id: string, fields: Partial<DraftAttachment>) =>
    setItems((prev) => prev.map((d) => (d.id === id ? { ...d, ...fields } : d)));

  const accept = useCallback(
    (candidates: Candidate[]) => {
      if (candidates.length === 0) return;
      setError(null);
      const drafts = candidatesToDrafts(candidates);
      setItems((prev) => [...prev, ...drafts]);
      const ids = drafts.filter((d) => d.status === 'copying').map((d) => d.id);
      if (ids.length === 0) return;
      addAttachments(conversationId, ids)
        .then((results) => {
          for (const r of results) {
            // Quitado mientras se copiaba: la copia no debe quedarse en el workspace.
            if (!itemsRef.current.some((d) => d.id === r.id)) {
              if (r.path) void discardAttachment(conversationId, r.path).catch(() => {});
              continue;
            }
            patch(
              r.id,
              r.path
                ? { status: 'ready', path: r.path, size: r.size }
                : { status: 'rejected', error: r.error ?? 'no se pudo adjuntar' },
            );
          }
        })
        .catch((err) => {
          for (const id of ids) patch(id, { status: 'rejected', error: errorMessage(err) });
        });
    },
    [conversationId],
  );

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const keep = (p: Promise<() => void>) =>
      p
        .then((u) => (disposed ? u() : unlisteners.push(u)))
        .catch(() => {
          /* fuera de Tauri (tests): sin drag & drop */
        });
    keep(onDragState((active) => setDragging(active && enabledRef.current)));
    keep(
      onDropped((candidates) => {
        if (enabledRef.current) accept(candidates);
      }),
    );
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, [accept]);

  const pick = useCallback(() => {
    if (!enabledRef.current) return;
    pickAttachments()
      .then(accept)
      .catch((err) => setError(`No se pudo abrir el selector de ficheros: ${errorMessage(err)}`));
  }, [accept]);

  const remove = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((d) => d.id === id);
      if (item?.status === 'ready' && item.path) {
        discardAttachment(conversationId, item.path).catch(() => {
          /* ya enviado o ya borrado: no queda nada que hacer */
        });
      }
      setItems((prev) => prev.filter((d) => d.id !== id));
    },
    [conversationId],
  );

  const clear = useCallback(() => setItems([]), []);

  const readyPaths = items.flatMap((d) => (d.status === 'ready' && d.path ? [d.path] : []));
  const busy = items.some((d) => d.status === 'copying');
  return { items, dragging, readyPaths, busy, pick, remove, clear, error };
}
