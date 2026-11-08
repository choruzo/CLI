import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { describeFailure } from '../../client/actions';
import type { NativeBridge } from '../../ipc/native';
import { toCommandError } from '../../ipc/native';
import {
  PROTOCOL_MEMORY_SECTIONS,
  groupDecisionsBySection,
  memorySectionOf,
  type ProtocolDecision,
  type ProtocolMemorySection,
} from '../../protocol';
import { parseDecisions, parseForget, parseMoved } from '../../protocol/results';
import { MemoryProposals } from './MemoryProposals';

const UNREADABLE = 'El daemon contestó algo que esta versión de Desktop no entiende.';

const PROVENANCE: Record<NonNullable<ProtocolDecision['source']> | 'none', string> = {
  agent: 'La guardó el asistente',
  auto: 'Extraída sola de una conversación',
  none: 'Origen sin registrar',
};

/** M19 — las secciones de lo que recuerda, como títulos del panel. */
const SECTION_LABEL: Record<ProtocolMemorySection, string> = {
  profile: 'Tú',
  person: 'Personas',
  project: 'Proyectos',
  topic: 'Temas',
  area: 'Áreas',
};

const when = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
};

/**
 * La memoria **global** del asistente: lo que recuerda de una conversación a
 * otra (`memory.decisions`, agente fijado por el lado nativo). Ver, buscar y
 * olvidar, con su procedencia. Nada de lo recordado decide permisos,
 * aprobaciones ni guardas. **Sin estado optimista**: tras olvidar se vuelve a
 * pedir la lista; una orden sin respuesta es «resultado desconocido» y no se
 * repite sola. Es el inspector de Stratum Dot (M17) con la memoria de Desktop.
 */
export function AssistantMemory({
  native,
  connected,
  refreshKey,
  onOpenSession,
  knownSessions,
}: {
  native: NativeBridge;
  connected: boolean;
  /** Cambia cuando puede haber cambiado (un run que termina). */
  refreshKey: string;
  /** Abre la conversación donde se guardó algo. */
  onOpenSession: (sessionId: string) => void;
  /** Las sesiones que el daemon publica ahora: solo esas se pueden abrir. */
  knownSessions: ReadonlySet<string>;
}) {
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [decisions, setDecisions] = useState<ProtocolDecision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
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
        if (alive.current && seq === requestSeq.current) {
          setError(describeFailure('No se pudo leer la memoria', toCommandError(err)));
        }
      } finally {
        if (alive.current && seq === requestSeq.current) setLoading(false);
      }
    },
    [native],
  );

  // Al abrir el panel, al recuperar la conexión y cuando termina un run (pudo guardar algo). Sin sondeo.
  useEffect(() => {
    if (connected) void load(appliedRef.current);
  }, [connected, load, refreshKey]);

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
      if (removed === null) setNote({ tone: 'error', text: UNREADABLE });
      else if (!removed) setNote({ tone: 'info', text: 'Ya no estaba.' });
    } catch (err) {
      if (!alive.current) return;
      const failure = toCommandError(err);
      setNote({
        tone: 'error',
        text:
          failure.kind === 'unknown'
            ? 'Resultado desconocido: el daemon no contestó a tiempo. Recarga para ver si se olvidó.'
            : describeFailure('No se pudo olvidar', failure),
      });
    } finally {
      if (alive.current) {
        setConfirming(null);
        setForgetting(false);
      }
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
      if (updated === null) setNote({ tone: 'error', text: UNREADABLE });
      else if (!updated) setNote({ tone: 'info', text: 'Ya no estaba.' });
    } catch (err) {
      if (!alive.current) return;
      const failure = toCommandError(err);
      setNote({
        tone: 'error',
        text:
          failure.kind === 'unknown'
            ? 'Resultado desconocido: el daemon no contestó a tiempo. Recarga para ver si se movió.'
            : describeFailure('No se pudo mover', failure),
      });
    } finally {
      if (alive.current) setMoving(false);
    }
    if (alive.current) void load(appliedRef.current);
  };

  const canChange = connected && !forgetting && !moving;

  return (
    <section className="conv-group assistant-memory" aria-label="Memoria del asistente">
      <div className="assistant-memory__head">
        <h3 className="conv-group__title">Memoria del asistente</h3>
        <button
          type="button"
          className="button button--small"
          disabled={!connected || loading}
          onClick={() => void load(applied)}
          aria-label="Recargar la memoria del asistente"
        >
          Recargar
        </button>
      </div>
      <p className="side-panel__empty">
        Lo que el asistente recuerda de una conversación a otra. Nunca decide lo que puede hacer.
      </p>
      <MemoryProposals
        native={native}
        connected={connected}
        onApplied={() => void load(appliedRef.current)}
      />
      <form className="assistant-memory__search" onSubmit={search} role="search">
        <input
          type="search"
          className="side-panel__search"
          value={draft}
          maxLength={2000}
          placeholder="Buscar en lo que recuerda…"
          aria-label="Buscar en la memoria del asistente"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="button button--small" disabled={!connected || loading}>
          Buscar
        </button>
      </form>
      {!connected && <p className="side-panel__empty">Sin conexión con el daemon de Stratum.</p>}
      {loading && (
        <p className="side-panel__empty" role="status">
          Cargando la memoria…
        </p>
      )}
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
      {decisions !== null && decisions.length === 0 && !error && (
        <p className="side-panel__empty" data-e2e="memory-empty">
          {applied ? 'Nada coincide.' : 'El asistente aún no recuerda nada.'}
        </p>
      )}
      {groupDecisionsBySection(decisions ?? []).map(({ section, items }) => (
        <div
          key={section}
          className="assistant-memory__section"
          role="group"
          data-section={section}
          aria-label={SECTION_LABEL[section]}
        >
          <h4 className="assistant-memory__section-title">
            {SECTION_LABEL[section]} <span>({items.length})</span>
          </h4>
          <ul className="assistant-memory__list">
        {items.map((decision) => {
          const open = expanded[decision.id] === true;
          const origin = decision.source ?? 'none';
          const canOpen = decision.sessionId !== undefined && knownSessions.has(decision.sessionId);
          return (
            <li key={decision.id} className="assistant-memory__item" data-decision={decision.id}>
              <button
                type="button"
                className="assistant-memory__title"
                aria-expanded={open}
                onClick={() => setExpanded((prev) => ({ ...prev, [decision.id]: !open }))}
              >
                {decision.title}
              </button>
              {decision.summary && !open && (
                <div className="assistant-memory__summary">{decision.summary}</div>
              )}
              <div className="assistant-memory__meta">
                {decision.importance} · {when(decision.updatedAt ?? decision.timestamp)}
                {decision.tags.length > 0 && ` · ${decision.tags.join(', ')}`}
              </div>
              {open && (
                <div className="assistant-memory__detail">
                  {decision.content && <p className="memory-summary">{decision.content}</p>}
                  <div className="assistant-memory__meta" data-e2e="memory-origin">
                    {PROVENANCE[origin]}
                    {decision.sessionId && !canOpen && ' (en una conversación que ya no está)'}
                  </div>
                  {canOpen && (
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => onOpenSession(decision.sessionId!)}
                      aria-label={`Abrir la conversación de ${decision.title}`}
                    >
                      Abrir la conversación
                    </button>
                  )}
                </div>
              )}
              {confirming === decision.id ? (
                <div className="assistant-memory__confirm" role="group" aria-label={`Olvidar ${decision.title}`}>
                  <span>¿Olvidar «{decision.title}»? El asistente dejará de recordarlo.</span>
                  <div className="assistant-memory__actions">
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => setConfirming(null)}
                      disabled={forgetting}
                    >
                      Conservar
                    </button>
                    <button
                      type="button"
                      className="button button--small button--danger"
                      disabled={!canChange}
                      onClick={() => void forget(decision)}
                    >
                      Olvidar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="assistant-memory__actions">
                  <label className="assistant-memory__move">
                    Mover a{' '}
                    <select
                      value={memorySectionOf(decision.type)}
                      disabled={!canChange}
                      aria-label={`Mover ${decision.title} a otra sección`}
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
                    className="button button--small button--danger"
                    disabled={!canChange}
                    onClick={() => {
                      setNote(null);
                      setConfirming(decision.id);
                    }}
                    aria-label={`Olvidar ${decision.title}`}
                  >
                    Olvidar
                  </button>
                </div>
              )}
            </li>
          );
        })}
          </ul>
        </div>
      ))}
    </section>
  );
}
