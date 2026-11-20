import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCommandError } from '../app/actions';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import type { ProtocolMemoryChange } from '../protocol';
import { parseMemoryChanges, parseUndone } from '../protocol/results';

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): deshacer. */
  canControl: boolean;
  /** Se deshizo un cambio: la memoria cambió, el inspector vuelve a pedirla. */
  onUndone(): void;
}

const UNREADABLE = 'The daemon answered in a way this version of Dot cannot read.';

const when = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleDateString();
};

/** Qué hizo el agente, en una línea. */
export function changeHeadline(c: ProtocolMemoryChange): string {
  if (c.action === 'retired') return `Retired “${c.title}”`;
  return c.newTitle !== undefined && c.newTitle !== c.title
    ? `Corrected “${c.title}” → “${c.newTitle}”`
    : `Corrected “${c.title}”`;
}

/**
 * Lo que el agente corrigió o retiró de su memoria, con «Undo». **Sin estado
 * optimista**: tras deshacer se vuelve a pedir la lista (y el inspector pide las
 * decisiones); una orden sin respuesta es «Result unknown» y no se repite sola.
 * Sin cambios, la sección no se pinta.
 */
export function MemoryChanges({ connected, canControl, onUndone }: Props) {
  const native = useNative();
  const [changes, setChanges] = useState<ProtocolMemoryChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
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
        setError(describeCommandError(toCommandError(err)));
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
      if (done === null) setNote({ tone: 'bad', text: UNREADABLE });
      else if (done.undone) onUndone();
      else setNote({ tone: 'bad', text: done.message });
    } catch (err) {
      if (alive.current) {
        const failure = toCommandError(err);
        setNote({
          tone: 'bad',
          text:
            failure.kind === 'unknown'
              ? 'Result unknown: the daemon did not answer in time. Refresh to see whether it was undone.'
              : describeCommandError(failure),
        });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const list = changes ?? [];
  if (list.length === 0 && !error && !note) return null;

  const canChange = connected && canControl && !busy;

  return (
    <section className="memory-changes" aria-label="Recent changes by the assistant" data-e2e="memory-changes">
      <div className="overview-head">
        <h3>Recent changes by the assistant</h3>
      </div>
      <p className="muted small">
        When something it remembered stopped being true, the assistant corrected or retired it. You can
        undo any of these.
      </p>
      {error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className={`note small ${note.tone === 'bad' ? 'bad' : ''}`} role={note.tone === 'bad' ? 'alert' : 'status'}>
          {note.text}
        </p>
      ) : null}
      <ul className="memory-list">
        {list.map((c) => (
          <li key={c.id} className="memory-item" data-change={c.id}>
            <div className="row-top">
              <strong>{changeHeadline(c)}</strong>
            </div>
            <div className="muted small">
              {when(c.at)} · {c.action === 'retired' ? 'Retired' : 'Corrected'}
              {c.by === 'dreaming' ? ' by dreaming' : ''}
              {c.undone ? ' · Undone' : ''}
            </div>
            <div className="muted small">{c.reason}</div>
            {c.undoable ? (
              <div className="controls">
                <button
                  type="button"
                  className="btn ghost small"
                  disabled={!canChange}
                  onClick={() => void undo(c)}
                  aria-label={`Undo: ${changeHeadline(c)}`}
                >
                  Undo
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
