import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { describeCommandError } from '../app/actions';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import {
  PROTOCOL_MEMORY_SECTIONS,
  groupDecisionsBySection,
  memorySectionOf,
  type ProtocolDecision,
  type ProtocolMemorySection,
  type ProtocolSessionMemory,
  type ProtocolSessionSnapshot,
} from '../protocol';
import { parseDecisions, parseForget, parseMoved, parseSessionMemory } from '../protocol/results';
import { activeRun } from '../protocol/view';
import { useSessions } from '../stores/sessionStore';

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): olvidar. */
  canControl: boolean;
  /** La conversación del asistente, si ya se abrió (para su memoria de sesión). */
  companionId: string | null;
  /** Su foto: cuando termina un run, lo que recuerda puede haber cambiado. */
  snapshot: ProtocolSessionSnapshot | null;
  /** Abre la conversación donde se guardó algo, como cualquier otra. */
  onOpenSession(sessionId: string): void;
}

const UNREADABLE = 'The daemon answered in a way this version of Dot cannot read.';

const PROVENANCE: Record<NonNullable<ProtocolDecision['source']> | 'none', string> = {
  agent: 'Saved by the assistant',
  auto: 'Extracted automatically from a conversation',
  none: 'Origin not recorded',
};

/** M19 — las secciones de lo que recuerda, como títulos del inspector. */
const SECTION_LABEL: Record<ProtocolMemorySection, string> = {
  profile: 'You',
  person: 'People',
  project: 'Projects',
  topic: 'Topics',
  area: 'Areas',
};

const shortId = (id: string) => (id.length > 8 ? id.slice(-8) : id);
const when = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
};

/**
 * M17 — inspector de la memoria del asistente (PRD §23.6): ver, buscar y olvidar
 * lo que recuerda, con su procedencia. Nada de lo recordado decide permisos,
 * aprobaciones ni guardas. **Sin estado optimista**: tras olvidar se vuelve a
 * pedir la lista, no se quita la fila; una orden sin respuesta es «Result
 * unknown» y no se repite sola. El lado nativo fija de quién es la memoria.
 */
export function MemoryPanel({ connected, canControl, companionId, snapshot, onOpenSession }: Props) {
  const native = useNative();
  const sessions = useSessions((s) => s.sessions);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [decisions, setDecisions] = useState<ProtocolDecision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState<{ tone: 'info' | 'bad'; text: string } | null>(null);
  const alive = useRef(true);
  const requestSeq = useRef(0);
  const appliedRef = useRef('');
  appliedRef.current = applied;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Pide las decisiones (las últimas, o la búsqueda). Una respuesta vieja no pisa a una nueva. */
  const load = useCallback(
    async (query: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const raw = await native.memoryDecisions(query === '' ? undefined : query);
        if (!alive.current || seq !== requestSeq.current) return;
        const list = parseDecisions(raw);
        if (list) setDecisions(list);
        else setError(UNREADABLE);
      } catch (err) {
        if (alive.current && seq === requestSeq.current) setError(describeCommandError(toCommandError(err)));
      } finally {
        if (alive.current && seq === requestSeq.current) setLoading(false);
      }
    },
    [native],
  );

  // Al abrir la vista (y al recuperar la conexión).
  useEffect(() => {
    if (connected) void load(appliedRef.current);
  }, [connected, load]);

  // Cuando termina un run del asistente: puede haber guardado algo. Nada más (sin sondeo).
  const running = snapshot ? activeRun(snapshot) !== null : false;
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && connected) void load(appliedRef.current);
    wasRunning.current = running;
  }, [running, connected, load]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    const query = draft.trim();
    setApplied(query);
    setNote(null);
    setConfirming(null);
    void load(query);
  };

  const forget = async (decision: ProtocolDecision) => {
    setForgetting(true);
    setNote(null);
    try {
      const removed = parseForget(await native.memoryForget(decision.id));
      if (!alive.current) return;
      setConfirming(null);
      if (removed === null) setNote({ tone: 'bad', text: UNREADABLE });
      else if (!removed) setNote({ tone: 'info', text: 'It was already gone.' });
    } catch (err) {
      if (!alive.current) return;
      const failure = toCommandError(err);
      setNote({
        tone: 'bad',
        text:
          failure.kind === 'unknown'
            ? 'Result unknown: the daemon did not answer in time. Refresh to see whether it was forgotten.'
            : describeCommandError(failure),
      });
      setConfirming(null);
    } finally {
      if (alive.current) setForgetting(false);
    }
    // Sin optimismo: la lista es lo que contesta el daemon, no lo que se supone.
    if (alive.current) void load(appliedRef.current);
  };

  /** M19 — mover un recuerdo a otra sección. Sin estado optimista: se vuelve a pedir la lista. */
  const moveDecision = async (decision: ProtocolDecision, section: string) => {
    if (section === memorySectionOf(decision.type)) return;
    setMoving(true);
    setNote(null);
    try {
      const updated = parseMoved(await native.memoryMove(decision.id, section));
      if (!alive.current) return;
      if (updated === null) setNote({ tone: 'bad', text: UNREADABLE });
      else if (!updated) setNote({ tone: 'info', text: 'It was already gone.' });
    } catch (err) {
      if (!alive.current) return;
      const failure = toCommandError(err);
      setNote({
        tone: 'bad',
        text:
          failure.kind === 'unknown'
            ? 'Result unknown: the daemon did not answer in time. Refresh to see whether it moved.'
            : describeCommandError(failure),
      });
    } finally {
      if (alive.current) setMoving(false);
    }
    if (alive.current) void load(appliedRef.current);
  };

  const canChange = connected && canControl && !forgetting && !moving;

  return (
    <section className="memory-panel" aria-label="Memory">
      <div className="overview-head">
        <h2>Memory</h2>
        <span className="controls">
          <button
            type="button"
            className="btn ghost small"
            disabled={!connected || loading}
            onClick={() => void load(applied)}
            aria-label="Refresh the memory"
          >
            Refresh
          </button>
        </span>
      </div>
      <p className="muted small">
        What the assistant remembers across conversations. It never decides what the assistant may do.
      </p>
      <form className="memory-search" onSubmit={search} role="search">
        <input
          type="search"
          value={draft}
          maxLength={2000}
          placeholder="Search what it remembers"
          aria-label="Search the memory"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn small" disabled={!connected || loading}>
          Search
        </button>
      </form>
      {loading ? (
        <p className="muted small" role="status">
          Loading memory…
        </p>
      ) : null}
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
      {decisions !== null && decisions.length === 0 && !error ? (
        <p className="muted small" data-e2e="memory-empty">
          {applied ? 'Nothing matches.' : 'The assistant does not remember anything yet.'}
        </p>
      ) : null}
      {groupDecisionsBySection(decisions ?? []).map(({ section, items }) => (
        <section key={section} className="memory-section" data-section={section} aria-label={SECTION_LABEL[section]}>
          <h3 className="memory-section-title small">
            {SECTION_LABEL[section]} <span className="muted">({items.length})</span>
          </h3>
          <ul className="memory-list">
        {items.map((decision) => {
          const open = expanded[decision.id] === true;
          const origin = decision.source ?? 'none';
          const known = decision.sessionId ? sessions[decision.sessionId] !== undefined : false;
          return (
            <li key={decision.id} className="memory-item" data-decision={decision.id}>
              <div className="row-top">
                <button
                  type="button"
                  className="btn ghost small memory-title"
                  aria-expanded={open}
                  onClick={() => setExpanded((prev) => ({ ...prev, [decision.id]: !open }))}
                >
                  {decision.title}
                </button>
              </div>
              {decision.summary && !open ? <div className="small">{decision.summary}</div> : null}
              <div className="muted small">
                {decision.importance} · {when(decision.updatedAt ?? decision.timestamp)}
              </div>
              {decision.tags.length > 0 ? <div className="muted small">{decision.tags.join(', ')}</div> : null}
              {open ? (
                <div className="memory-detail">
                  {decision.content ? <p className="memory-content small">{decision.content}</p> : null}
                  <div className="muted small" data-e2e="memory-origin">
                    {PROVENANCE[origin]}
                    {decision.sessionId ? ` in conversation ${shortId(decision.sessionId)}` : ''}
                  </div>
                  {decision.sessionId && known ? (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => onOpenSession(decision.sessionId!)}
                      aria-label={`Open the conversation of ${decision.title}`}
                    >
                      Open
                    </button>
                  ) : null}
                </div>
              ) : null}
              {confirming === decision.id ? (
                <div className="decision" role="group" aria-label={`Forget ${decision.title}`}>
                  <span className="small">Forget “{decision.title}”? The assistant will no longer recall it.</span>
                  <span className="spacer" />
                  <button type="button" className="btn small" onClick={() => setConfirming(null)} disabled={forgetting}>
                    Keep
                  </button>
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={!canChange}
                    onClick={() => void forget(decision)}
                  >
                    Forget
                  </button>
                </div>
              ) : (
                <div className="controls">
                  <label className="muted small memory-move">
                    Move to{' '}
                    <select
                      value={memorySectionOf(decision.type)}
                      disabled={!canChange}
                      aria-label={`Move ${decision.title} to another section`}
                      onChange={(e) => void moveDecision(decision, e.target.value)}
                    >
                      {PROTOCOL_MEMORY_SECTIONS.map((s) => (
                        <option key={s} value={s}>
                          {SECTION_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn danger small"
                    disabled={!canChange}
                    onClick={() => {
                      setNote(null);
                      setConfirming(decision.id);
                    }}
                    aria-label={`Forget ${decision.title}`}
                  >
                    Forget
                  </button>
                </div>
              )}
            </li>
          );
        })}
          </ul>
        </section>
      ))}
      {companionId ? <ConversationMemory connected={connected} sessionId={companionId} /> : null}
    </section>
  );
}

/** La memoria de sesión (M11) de la conversación del asistente: solo lectura, plegada. */
function ConversationMemory({ connected, sessionId }: { connected: boolean; sessionId: string }) {
  const native = useNative();
  const [open, setOpen] = useState(false);
  const [memory, setMemory] = useState<ProtocolSessionMemory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setLoading(true);
    setError(null);
    try {
      const parsed = parseSessionMemory(await native.sessionMemory(sessionId));
      if (!alive.current || seq !== requestSeq.current) return;
      if (parsed) setMemory(parsed);
      else setError(UNREADABLE);
    } catch (err) {
      if (alive.current && seq === requestSeq.current) setError(describeCommandError(toCommandError(err)));
    } finally {
      if (alive.current && seq === requestSeq.current) setLoading(false);
    }
  }, [native, sessionId]);

  useEffect(() => {
    if (open && connected) void load();
  }, [open, connected, load]);

  const items = (memory?.items ?? []).filter((item) => item.status === 'active');
  const summary = memory?.summary?.text ?? '';

  return (
    <div className="memory-session" data-e2e="memory-session">
      <div className="overview-head">
        <h3>This conversation</h3>
        <span className="controls">
          {open ? (
            <button
              type="button"
              className="btn ghost small"
              disabled={!connected || loading}
              onClick={() => void load()}
              aria-label="Refresh this conversation's memory"
            >
              Refresh
            </button>
          ) : null}
          <button type="button" className="btn ghost small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </span>
      </div>
      {open ? (
        <>
          <p className="muted small">Kept only for this conversation; compacted from its older messages.</p>
          {loading ? (
            <p className="muted small" role="status">
              Loading…
            </p>
          ) : null}
          {error ? (
            <p className="note bad small" role="alert">
              {error}
            </p>
          ) : null}
          {memory && !error ? (
            summary === '' && items.length === 0 ? (
              <p className="muted small">Nothing compacted yet.</p>
            ) : (
              <>
                {summary !== '' ? <p className="memory-content small">{summary}</p> : null}
                <ul className="memory-list">
                  {items.map((item) => (
                    <li key={item.id} className="memory-item small" data-item={item.id}>
                      <span className="muted">{item.kind}</span> · {item.text}
                    </li>
                  ))}
                </ul>
              </>
            )
          ) : null}
          {memory?.inherited && !error ? (
            <div className="memory-inherited" data-e2e="memory-inherited">
              <h4 className="small">Carried over from the previous conversation</h4>
              <p className="muted small">
                Archived when this conversation started; read only.{' '}
                <span className="mono">{memory.inherited.fromSessionId}</span>
              </p>
              {memory.inherited.summary ? <p className="memory-content small">{memory.inherited.summary}</p> : null}
              <ul className="memory-list">
                {memory.inherited.items.map((item) => (
                  <li key={`${item.kind}:${item.key}`} className="memory-item small">
                    <span className="muted">{item.kind}</span> · {item.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
