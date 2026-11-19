import { useEffect, useRef, useState } from 'react';
import { pauseWatch, refreshWatches, removeWatch, resumeWatch } from '../app/watches';
import { useNative } from '../bridge/context';
import type { ProtocolWatch, ProtocolWatchCondition } from '../protocol';
import { useWatches } from '../stores/watchStore';

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): pausar, reanudar y quitar. */
  canControl: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `DD/MM HH:MM` en hora local, siempre de 24 h. */
function when(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** La condición en inglés legible: `state is "on"`, `value above 30`, `state changes`, con su « for at least N min». */
export function describeCondition(condition: ProtocolWatchCondition): string {
  let text: string;
  switch (condition.kind) {
    case 'state-is':
      text = `state is ${condition.values.map((v) => `"${v}"`).join(' or ')}`;
      break;
    case 'state-is-not':
      text = `state is not ${condition.values.map((v) => `"${v}"`).join(' or ')}`;
      break;
    case 'above':
      text = `value above ${condition.threshold}`;
      break;
    case 'below':
      text = `value below ${condition.threshold}`;
      break;
    default:
      text = 'state changes';
  }
  const minutes = condition.forMinutes;
  return minutes !== undefined && minutes > 0 ? `${text} for at least ${minutes} min` : text;
}

/** El intervalo entre comprobaciones: `every 90s`. */
export function describeEvery(intervalSec: number): string {
  return `every ${intervalSec}s`;
}

/**
 * M22 — los vigilantes del asistente (PRD de Dot §23.11): lista con su
 * condición y su estado, y *Pause* / *Resume* / *Remove*. **Sin estado
 * optimista**: lo que se ve es lo que contestó `watches.list`, que se vuelve a
 * pedir tras cada acción. Un resultado desconocido se dice y no se reintenta.
 * Crearlos no está aquí: los propone el asistente (y los aprueba la persona) o
 * se crean con `stratum watches add`.
 */
export function WatchesPanel({ connected, canControl }: Props) {
  const native = useNative();
  const watches = useWatches((s) => s.watches);
  const readOnly = useWatches((s) => s.readOnly);
  const disabled = useWatches((s) => s.disabled);
  const loading = useWatches((s) => s.loading);
  const error = useWatches((s) => s.error);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Al abrir la vista (y al recuperar la conexión). Después, solo por `app/watches.ts`.
  useEffect(() => {
    if (connected) void refreshWatches(native);
  }, [native, connected]);

  const act = async (
    watch: ProtocolWatch,
    label: string,
    run: (id: string) => Promise<string | null>,
  ) => {
    setBusy(watch.id);
    setNote(null);
    const failure = await run(watch.id);
    if (!alive.current) return;
    setBusy(null);
    setConfirming(null);
    if (failure) setNote({ tone: 'bad', text: `${label}: ${failure}` });
  };

  const canChange = connected && canControl && !readOnly && !disabled && busy === null;
  const list = watches ?? [];

  return (
    <section className="watches-panel" aria-label="Watches" data-watches={watches ? list.length : 'unknown'}>
      <div className="overview-head">
        <h2>Watches</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void refreshWatches(native)}
            aria-label="Refresh the watches"
          >
            Refresh
          </button>
        </span>
      </div>
      <p className="muted small">
        Things the assistant keeps an eye on and tells you about when a condition is met. A watch only tells you: it
        never starts a conversation.
      </p>
      {disabled ? (
        <p className="note small" role="note" data-e2e="watches-disabled">
          {error}
        </p>
      ) : error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      {readOnly ? (
        <p className="note small" role="note" data-e2e="watches-read-only">
          The watches file was written by a newer Stratum or is damaged: you can see the watches, not change them.
        </p>
      ) : null}
      {note ? (
        <p
          className={`note small ${note.tone === 'bad' ? 'bad' : ''}`}
          role={note.tone === 'bad' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      ) : null}
      {!connected ? (
        <p className="muted small" role="status">
          Not connected to the Stratum daemon.
        </p>
      ) : watches === null && !error ? (
        <p className="muted small" role="status">
          Loading watches…
        </p>
      ) : null}
      {watches !== null && list.length === 0 && !disabled ? (
        <p className="muted small" data-e2e="watches-empty">
          No watches yet. The assistant can propose one for you to approve, or you can create one with{' '}
          <span className="mono">stratum watches add</span>.
        </p>
      ) : null}
      <ul className="reminders">
        {list.map((watch) => (
          <li
            key={watch.id}
            className="reminder"
            data-watch={watch.id}
            data-status={watch.status}
            data-firing={watch.firing ? 'yes' : 'no'}
            data-health={watch.health}
          >
            <div className="row-top">
              <span className="watch-name">{watch.name}</span>
              <span className="spacer" />
              <span className={`small ${watch.status === 'active' ? 'tone-ok' : 'tone-paused'}`}>{watch.status}</span>
            </div>
            <div className="watch-meta small muted">
              <span className="mono">
                {watch.connector} · {watch.check}
              </span>
            </div>
            <div className="watch-meta small">
              {describeCondition(watch.condition)} · {describeEvery(watch.intervalSec)}
            </div>
            <div className="watch-marks small">
              {watch.firing ? <span className="tone-bad">Firing</span> : null}
              {watch.health === 'failing' ? <span className="tone-bad">Cannot check</span> : null}
              {watch.health === 'suspended' ? <span className="tone-paused">Suspended</span> : null}
              {watch.lastFiredAt !== null ? (
                <span className="tone-muted">Last fired {when(watch.lastFiredAt)}</span>
              ) : null}
              {watch.origin === 'agent' ? <span className="tone-muted">By the assistant</span> : null}
            </div>
            {confirming === watch.id ? (
              <div className="decision" role="group" aria-label={`Remove ${watch.name}`}>
                <span className="small">Remove “{watch.name}”?</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setConfirming(null)}
                  disabled={busy !== null}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="btn danger small"
                  disabled={!canChange}
                  onClick={() => void act(watch, 'Remove', (id) => removeWatch(native, id))}
                >
                  Remove watch
                </button>
              </div>
            ) : (
              <div className="controls">
                {watch.status === 'active' ? (
                  <button
                    type="button"
                    className="btn small"
                    disabled={!canChange}
                    onClick={() => void act(watch, 'Pause', (id) => pauseWatch(native, id))}
                    aria-label={`Pause ${watch.name}`}
                  >
                    {busy === watch.id ? 'Working…' : 'Pause'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn small"
                    disabled={!canChange}
                    onClick={() => void act(watch, 'Resume', (id) => resumeWatch(native, id))}
                    aria-label={`Resume ${watch.name}`}
                  >
                    {busy === watch.id ? 'Working…' : 'Resume'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn danger small"
                  disabled={!canChange}
                  onClick={() => setConfirming(watch.id)}
                  aria-label={`Remove ${watch.name}`}
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
