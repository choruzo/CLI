import { memo, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ProtocolChatMessage, ProtocolSessionSnapshot } from '../protocol';
import { STATUS_LABEL, activeRun, type Tone } from '../protocol/view';
import { Markdown } from './Markdown';
import { PendingSummary } from './PendingSummary';
import { Dot } from './StatusBadge';

/**
 * `pending` y `running` se enseñan igual, como «Active»: `tool.started` se
 * publica al conocerse la llamada y puede estar esperando una aprobación o una
 * pausa, así que desde aquí no se puede afirmar que se esté ejecutando.
 */
const TOOL_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Active', tone: 'active' },
  running: { label: 'Active', tone: 'active' },
  completed: { label: 'Done', tone: 'ok' },
  error: { label: 'Failed', tone: 'bad' },
  blocked: { label: 'Blocked', tone: 'muted' },
};
/** Quedó abierta y su run ya terminó: no se llegó a saber cómo acabó. */
const TOOL_INTERRUPTED = { label: 'Interrupted', tone: 'muted' as Tone };

/** El anfitrión describe una llamada como `nombre: resumen`: el nombre ya se enseña aparte. */
function summaryOf(name: string, description: string): string {
  return description.startsWith(`${name}: `) ? description.slice(name.length + 2) : description;
}

/** Una entrada de la conversación. Con `memo`: un fragmento nuevo no repinta las anteriores. */
const Entry = memo(function Entry({
  message,
  activeRunId,
}: {
  message: ProtocolChatMessage;
  /** El run en curso, si lo hay: solo sus tools pueden seguir abiertas. */
  activeRunId: string | null;
}) {
  switch (message.kind) {
    case 'user':
      return (
        <li className="msg user" data-kind="user">
          <p className="bubble">{message.text}</p>
          {message.truncated ? <p className="muted small">Shortened: the message was longer than this.</p> : null}
        </li>
      );
    case 'assistant':
      return (
        <li className="msg assistant" data-kind="assistant">
          <Markdown text={message.text} />
          {message.truncated ? <p className="muted small">Shortened: the reply was longer than this.</p> : null}
        </li>
      );
    case 'tool': {
      const open = message.state === 'pending' || message.state === 'running';
      const stale = open && message.runId !== activeRunId;
      const state = stale ? TOOL_INTERRUPTED : (TOOL_STATE[message.state] ?? TOOL_STATE.pending!);
      return (
        <li className="msg tool" data-kind="tool" data-state={stale ? 'interrupted' : message.state}>
          <Dot tone={state.tone} />
          <span className="mono">{message.name}</span>
          <span className="muted">{state.label}</span>
          {message.target && message.target !== 'local' ? <span className="mono muted">{message.target}</span> : null}
          <span className="tool-desc muted">{summaryOf(message.name, message.description)}</span>
        </li>
      );
    }
    case 'outcome':
      return (
        <li className={`msg outcome ${message.status === 'failed' ? 'tone-bad' : 'tone-muted'}`} data-kind="outcome">
          {message.status === 'failed' ? 'Run failed' : 'Run cancelled'}
          {message.text ? <span> — {message.text}</span> : null}
        </li>
      );
  }
});

/** El bloque que el asistente está escribiendo. Efímero: lo cierra un `message.completed`. */
function Streaming({ text }: { text: string }) {
  // El texto llega por fragmentos: se pinta cuando la interfaz está libre.
  const shown = useDeferredValue(text);
  return (
    <li className="msg assistant streaming" data-kind="partial" aria-label="Reply being written">
      <Markdown text={shown} />
    </li>
  );
}

interface Props {
  snapshot: ProtocolSessionSnapshot;
  /** Hay un mensaje enviado cuyo run aún no ha aparecido. */
  sending: boolean;
  /** Qué enseñar cuando aún no hay conversación. */
  empty: ReactNode;
}

const NEAR_BOTTOM_PX = 48;

/**
 * La conversación de una sesión. Sale entera de su foto: `messages` (lo cerrado,
 * de todos sus runs) y `partial` (lo que se está escribiendo). Dot no guarda
 * otra copia ni la reconstruye con los fragmentos.
 */
export function Transcript({ snapshot, sending, empty }: Props) {
  const { messages, messagesTruncated, partial } = snapshot;
  const run = activeRun(snapshot);
  const waiting = snapshot.approvals.length + snapshot.questions.length + snapshot.plans.length > 0;
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    if (pinned.current) setUnseen(false);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setUnseen(false);
  };

  // Quien está abajo sigue el texto; quien ha subido a leer, no se le mueve.
  const grown = `${messages.length}:${messages[messages.length - 1]?.id ?? ''}:${partial.text.length}:${sending}`;
  useLayoutEffect(() => {
    if (pinned.current) toBottom();
    else setUnseen(true);
  }, [grown]);
  // Otra sesión: se empieza por el final.
  useEffect(toBottom, [snapshot.session.id]);

  const nothing = messages.length === 0 && !partial.text && !run && !sending;
  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={scroller} onScroll={onScroll}>
        {messagesTruncated ? (
          <p className="muted small transcript-note">Earlier messages are not shown: this conversation is long.</p>
        ) : null}
        {nothing ? <div className="muted transcript-empty">{empty}</div> : null}
        <ol className="messages" aria-label="Conversation">
          {messages.map((message) => (
            <Entry key={message.id} message={message} activeRunId={run?.id ?? null} />
          ))}
          {partial.text && run ? <Streaming text={partial.text} /> : null}
        </ol>
        {sending ? (
          <p className="muted small transcript-status" role="status">
            Sending…
          </p>
        ) : run && !partial.text && !waiting ? (
          <p className="muted small transcript-status" role="status" data-run-status={run.status}>
            {STATUS_LABEL[run.status]}…
          </p>
        ) : null}
        <PendingSummary snapshot={snapshot} />
      </div>
      {unseen ? (
        <button type="button" className="btn small new-output" onClick={toBottom} aria-label="Jump to the latest output">
          ↓ New output
        </button>
      ) : null}
    </div>
  );
}
