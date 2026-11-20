import { useCallback, useEffect, useRef, useState } from 'react';
import { describeFailure } from '../../client/actions';
import type { NativeBridge } from '../../ipc/native';
import { toCommandError } from '../../ipc/native';
import type { ProtocolMemoryChange } from '../../protocol';
import { parseMemoryChanges, parseUndone } from '../../protocol/results';

const UNREADABLE = 'El daemon contestó algo que esta versión de Desktop no entiende.';

const when = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleDateString();
};

/** Qué hizo el agente, en una línea. */
export function changeHeadline(c: ProtocolMemoryChange): string {
  if (c.action === 'retired') return `Retirado «${c.title}»`;
  return c.newTitle !== undefined && c.newTitle !== c.title
    ? `Corregido «${c.title}» → «${c.newTitle}»`
    : `Corregido «${c.title}»`;
}

/**
 * Lo que el agente corrigió o retiró de su memoria, con «Deshacer». **Sin estado
 * optimista**: tras deshacer se vuelve a pedir la lista (y el panel pide las
 * decisiones); una orden sin respuesta es «resultado desconocido» y no se repite
 * sola. Sin cambios, la sección no se pinta.
 */
export function MemoryChanges({
  native,
  connected,
  onUndone,
}: {
  native: NativeBridge;
  connected: boolean;
  /** Se deshizo un cambio: la memoria cambió y el panel vuelve a pedirla. */
  onUndone: () => void;
}) {
  const [changes, setChanges] = useState<ProtocolMemoryChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const alive = useRef(true);
  const requestSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const list = parseMemoryChanges(await native.memoryChanges());
      if (!alive.current || seq !== requestSeq.current) return;
      if (list) {
        setChanges(list);
        setError(null);
      } else setError(UNREADABLE);
    } catch (err) {
      if (alive.current && seq === requestSeq.current) {
        setError(describeFailure('No se pudieron leer los cambios', toCommandError(err)));
      }
    }
  }, [native]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  const undo = async (c: ProtocolMemoryChange) => {
    setBusy(true);
    setNote(null);
    try {
      const done = parseUndone(await native.memoryUndoChange(c.id));
      if (!alive.current) return;
      if (done === null) setNote({ tone: 'error', text: UNREADABLE });
      else if (done.undone) onUndone();
      else setNote({ tone: 'error', text: done.message });
    } catch (err) {
      if (alive.current) {
        const failure = toCommandError(err);
        setNote({
          tone: 'error',
          text:
            failure.kind === 'unknown'
              ? 'Resultado desconocido: el daemon no contestó a tiempo. Recarga para ver si se deshizo.'
              : describeFailure('No se pudo deshacer', failure),
        });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const list = changes ?? [];
  if (list.length === 0 && !error && !note) return null;

  const canChange = connected && !busy;

  return (
    <section
      className="assistant-memory__proposals"
      aria-label="Cambios recientes del asistente"
      data-e2e="memory-changes"
    >
      <div className="assistant-memory__head">
        <h4 className="assistant-memory__section-title">Cambios recientes del asistente</h4>
      </div>
      <p className="side-panel__empty">
        Cuando algo que recordaba dejó de ser cierto, el asistente lo corrigió o lo retiró. Puedes
        deshacer cualquiera de estos cambios.
      </p>
      {error && (
        <p className="notice" data-tone="warning" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p
          className="notice"
          data-tone={note.tone === 'error' ? 'error' : 'info'}
          role={note.tone === 'error' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}
      <ul className="assistant-memory__list">
        {list.map((c) => (
          <li key={c.id} className="assistant-memory__item" data-change={c.id}>
            <strong className="assistant-memory__title-static">{changeHeadline(c)}</strong>
            <div className="assistant-memory__meta">
              {when(c.at)} · {c.action === 'retired' ? 'Retirado' : 'Corregido'}
              {c.by === 'dreaming' ? ' por dreaming' : ''}
              {c.undone ? ' · Deshecho' : ''}
            </div>
            <div className="assistant-memory__meta">{c.reason}</div>
            {c.undoable && (
              <div className="assistant-memory__actions">
                <button
                  type="button"
                  className="button button--small"
                  disabled={!canChange}
                  onClick={() => void undo(c)}
                  aria-label={`Deshacer: ${changeHeadline(c)}`}
                >
                  Deshacer
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
