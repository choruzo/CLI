import { useEffect, useRef, useState } from 'react';
import { describeReminderError, refreshReminders } from '../app/reminders';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import type { ProtocolReminder } from '../protocol';
import { parseCancelledReminder } from '../protocol/results';
import { useReminders } from '../stores/reminderStore';

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): cancelar un recordatorio. */
  canControl: boolean;
  /** La hora, para decir «today» o «tomorrow». */
  now: number;
}

/** Lo entregado o cancelado que aún se enseña (el daemon guarda 7 días). */
export const RECENT_MS = 7 * 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

function dayStart(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** La hora local de un recordatorio: «today 21:30», «tomorrow 18/11 09:00» o la fecha. */
export function reminderWhen(ms: number, now: number): string {
  const date = new Date(ms);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`;
  if (dayStart(ms) === dayStart(now)) return `today ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (dayStart(ms) === dayStart(tomorrow.getTime())) return `tomorrow ${day} ${time}`;
  return `${day}/${date.getFullYear()} ${time}`;
}

/**
 * M21 — los recordatorios del asistente (PRD de Dot §23.11): los pendientes por
 * hora, con su texto y *Cancel*, y lo entregado o cancelado de los últimos 7
 * días en una sección plegada. **Sin estado optimista**: lo que se ve es lo que
 * contestó `reminders.list` o la cancelación, que se vuelve a pedir después. Un
 * resultado desconocido se dice y no se reintenta solo.
 */
export function RemindersPanel({ connected, canControl, now }: Props) {
  const native = useNative();
  const reminders = useReminders((s) => s.reminders);
  const readOnly = useReminders((s) => s.readOnly);
  const disabled = useReminders((s) => s.disabled);
  const loading = useReminders((s) => s.loading);
  const error = useReminders((s) => s.error);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Al abrir la vista (y al recuperar la conexión). Después, solo por `app/reminders.ts`.
  useEffect(() => {
    if (connected) void refreshReminders(native);
  }, [native, connected]);

  const cancel = async (reminder: ProtocolReminder) => {
    setBusy(reminder.id);
    setNote(null);
    try {
      const cancelled = parseCancelledReminder(await native.remindersCancel(reminder.id));
      if (!alive.current) return;
      if (!cancelled) {
        setNote({ tone: 'bad', text: 'The daemon answered in a way this version of Dot cannot read.' });
      }
    } catch (err) {
      if (!alive.current) return;
      setNote({ tone: 'bad', text: `Cancel: ${describeReminderError(toCommandError(err))}` });
    } finally {
      if (alive.current) setBusy(null);
    }
    // Sin optimismo: la lista es lo que contesta el daemon.
    if (alive.current) void refreshReminders(native);
  };

  const canCancel = connected && canControl && !readOnly && !disabled && busy === null;
  const all = reminders ?? [];
  const pending = all
    .filter((r) => r.status === 'pending')
    .slice()
    .sort((a, b) => a.dueAt - b.dueAt);
  const recent = all
    .filter((r) => r.status !== 'pending' && r.endedAt !== undefined && now - r.endedAt <= RECENT_MS)
    .slice()
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  return (
    <section className="reminders-panel" aria-label="Reminders" data-reminders={reminders ? all.length : 'unknown'}>
      <div className="overview-head">
        <h2>Reminders</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void refreshReminders(native)}
            aria-label="Refresh the reminders"
          >
            Refresh
          </button>
        </span>
      </div>
      <p className="muted small">
        What the assistant said it would remind you about. A reminder only tells you: it never starts a conversation.
      </p>
      {disabled ? (
        <p className="note small" role="note">
          {error}
        </p>
      ) : error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      {readOnly ? (
        <p className="note small" role="note" data-e2e="reminders-read-only">
          The reminders file was written by a newer Stratum or is damaged: you can see the reminders, not cancel them.
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
      ) : reminders === null && !error ? (
        <p className="muted small" role="status">
          Loading reminders…
        </p>
      ) : null}
      {reminders !== null && pending.length === 0 && !disabled ? (
        <p className="muted small" data-e2e="reminders-empty">
          No reminders pending.
        </p>
      ) : null}
      <ul className="reminders">
        {pending.map((reminder) => (
          <li key={reminder.id} className="reminder" data-reminder={reminder.id}>
            <div className="row-top">
              <span className="reminder-when small mono">{reminderWhen(reminder.dueAt, now)}</span>
              <span className="spacer" />
              {canControl && !readOnly ? (
                <button
                  type="button"
                  className="btn danger small"
                  disabled={!canCancel}
                  onClick={() => void cancel(reminder)}
                  aria-label={`Cancel the reminder ${reminder.text}`}
                >
                  {busy === reminder.id ? 'Cancelling…' : 'Cancel'}
                </button>
              ) : null}
            </div>
            <div className="reminder-text" data-e2e="reminder-text">
              {reminder.text}
            </div>
          </li>
        ))}
      </ul>
      {recent.length > 0 ? (
        <details
          className="reminders-recent"
          data-e2e="reminders-recent"
          open={recentOpen}
          onToggle={(event) => setRecentOpen((event.target as HTMLDetailsElement).open)}
        >
          <summary>Recent</summary>
          <ul className="reminders">
            {recent.map((reminder) => (
              <li
                key={reminder.id}
                className="reminder"
                data-reminder={reminder.id}
                data-status={reminder.status}
                data-late={reminder.late ? 'yes' : 'no'}
              >
                <div className="row-top">
                  <span className="reminder-when small mono">
                    {reminderWhen(reminder.endedAt ?? reminder.dueAt, now)}
                  </span>
                  <span className="spacer" />
                  <span className="tone-muted small">
                    {reminder.status === 'delivered' ? 'Delivered' : 'Cancelled'}
                    {reminder.status === 'delivered' && reminder.late ? ' · late' : ''}
                  </span>
                </div>
                <div className="reminder-text muted" data-e2e="reminder-text">
                  {reminder.text}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
