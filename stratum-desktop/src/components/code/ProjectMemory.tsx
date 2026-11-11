import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { describeFailure } from '../../client/actions';
import type { NativeBridge } from '../../ipc/native';
import { toCommandError } from '../../ipc/native';
import type { ProtocolDecision } from '../../protocol';
import { parseDecisions, parseForget, parseMemoryDocuments } from '../../protocol/results';

const UNREADABLE = 'El daemon contestó algo que esta versión de Desktop no entiende.';

const PROVENANCE: Record<NonNullable<ProtocolDecision['source']> | 'none', string> = {
  agent: 'La guardó el agente',
  auto: 'Extraída sola de una conversación',
  none: 'Origen sin registrar',
};

type Documents = NonNullable<ReturnType<typeof parseMemoryDocuments>>;

const when = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString();
};

/** Por qué no se puede leer la memoria del proyecto, para una persona. */
function describeMemoryFailure(what: string, err: unknown): string {
  const error = toCommandError(err);
  if (error.kind === 'rejected' && error.reason === 'embedded-agent') {
    return 'Esta sesión es del asistente: no trabaja sobre un proyecto.';
  }
  return describeFailure(what, error);
}

/**
 * La memoria **del proyecto de la sesión de código que se mira**: sus
 * decisiones (`memory.decisions`, ver, buscar y olvidar) y sus `STRATUM.md`
 * (`memory.documents`). Es lo que `/memory list|search|forget|show` da en la
 * terminal. La memoria la fija la sesión —el daemon resuelve su directorio—,
 * no una ruta que elija la interfaz, y es la misma que ve el agente: si la
 * config la guarda fuera del proyecto, es esa. Nada de lo recordado decide
 * permisos. Sin estado optimista: tras olvidar se vuelve a pedir la lista, y
 * una orden sin respuesta no se repite sola.
 */
export function ProjectMemory({
  native,
  sessionId,
  connected,
  refreshKey,
}: {
  native: NativeBridge;
  sessionId: string;
  connected: boolean;
  /** Cambia cuando puede haber cambiado (un run que termina). */
  refreshKey: string;
}) {
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const [decisions, setDecisions] = useState<ProtocolDecision[] | null>(null);
  const [documents, setDocuments] = useState<Documents | null>(null);
  const [showing, setShowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
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

  // Otra sesión es otro proyecto: lo que se tenía no es suyo.
  useEffect(() => {
    requestSeq.current++;
    setDecisions(null);
    setDocuments(null);
    setShowing(false);
    setDraft('');
    setApplied('');
    setError(null);
    setNote(null);
    setConfirming(null);
    setExpanded({});
  }, [sessionId]);

  /** Pide decisiones y documentos. Una respuesta vieja no pisa a una nueva. */
  const load = useCallback(
    async (query: string) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const [rawDecisions, rawDocuments] = await Promise.all([
          native.projectMemoryDecisions(sessionId, query === '' ? undefined : query),
          native.projectMemoryDocuments(sessionId),
        ]);
        if (!alive.current || seq !== requestSeq.current) return;
        const list = parseDecisions(rawDecisions);
        const docs = parseMemoryDocuments(rawDocuments);
        if (list && docs) {
          setDecisions(list);
          setDocuments(docs);
        } else setError(UNREADABLE);
      } catch (err) {
        if (alive.current && seq === requestSeq.current) {
          setError(describeMemoryFailure('No se pudo leer la memoria del proyecto', err));
        }
      } finally {
        if (alive.current && seq === requestSeq.current) setLoading(false);
      }
    },
    [native, sessionId],
  );

  // Al abrir, al recuperar la conexión y cuando termina un run (pudo guardar algo). Sin sondeo.
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
      const removed = parseForget(await native.projectMemoryForget(sessionId, decision.id));
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
            : describeMemoryFailure('No se pudo olvidar', err),
      });
    } finally {
      if (alive.current) {
        setConfirming(null);
        setForgetting(false);
      }
    }
    if (alive.current) void load(appliedRef.current);
  };

  const docs: { label: string; doc: NonNullable<Documents['project']> }[] = [];
  if (documents?.project) docs.push({ label: 'Proyecto', doc: documents.project });
  if (documents?.global) docs.push({ label: 'Global', doc: documents.global });

  return (
    <section className="conv-group assistant-memory" aria-label="Memoria del proyecto">
      <div className="assistant-memory__head">
        <h3 className="conv-group__title">Memoria del proyecto</h3>
        <button
          type="button"
          className="button button--small"
          disabled={!connected || loading}
          onClick={() => void load(applied)}
          aria-label="Recargar la memoria del proyecto"
        >
          Recargar
        </button>
      </div>
      <p className="side-panel__empty">
        Lo que el agente recuerda de este proyecto entre sesiones. Nunca decide lo que puede hacer.
      </p>
      {documents && (
        <div className="project-memory__docs">
          {docs.length === 0 ? (
            <p className="side-panel__empty">
              Este proyecto no tiene <code>STRATUM.md</code>. Se crea con <code>stratum init</code>.
            </p>
          ) : (
            <>
              <button
                type="button"
                className="button button--small"
                aria-expanded={showing}
                onClick={() => setShowing((v) => !v)}
              >
                {showing ? 'Ocultar STRATUM.md' : 'Ver STRATUM.md'}
              </button>
              {showing &&
                docs.map(({ label, doc }) => (
                  <div key={label} className="project-memory__doc" role="group" aria-label={`STRATUM.md · ${label}`}>
                    <h4 className="assistant-memory__section-title">{label}</h4>
                    <pre className="project-memory__text">{doc.content}</pre>
                    {doc.truncated && <p className="side-panel__empty">El fichero es más largo: se enseña el principio.</p>}
                  </div>
                ))}
            </>
          )}
        </div>
      )}
      <form className="assistant-memory__search" onSubmit={search} role="search">
        <input
          type="search"
          className="side-panel__search"
          value={draft}
          maxLength={2000}
          placeholder="Buscar en las decisiones…"
          aria-label="Buscar en la memoria del proyecto"
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
        <p className="side-panel__empty">
          {applied ? 'Nada coincide.' : 'El agente aún no ha guardado ninguna decisión de este proyecto.'}
        </p>
      )}
      {decisions !== null && decisions.length > 0 && (
        <ul className="assistant-memory__list">
          {decisions.map((decision) => {
            const open = expanded[decision.id] === true;
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
                <div className="assistant-memory__meta">
                  {decision.type} · {decision.importance} · {when(decision.updatedAt ?? decision.timestamp)}
                  {decision.tags.length > 0 && ` · ${decision.tags.join(', ')}`}
                </div>
                {open && (
                  <div className="assistant-memory__detail">
                    {decision.content && <p className="memory-summary">{decision.content}</p>}
                    <div className="assistant-memory__meta">{PROVENANCE[decision.source ?? 'none']}</div>
                  </div>
                )}
                {confirming === decision.id ? (
                  <div className="assistant-memory__confirm" role="group" aria-label={`Olvidar ${decision.title}`}>
                    <span>¿Olvidar «{decision.title}»? El agente dejará de recordarlo en este proyecto.</span>
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
                        disabled={!connected || forgetting}
                        onClick={() => void forget(decision)}
                      >
                        Olvidar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="assistant-memory__actions">
                    <button
                      type="button"
                      className="button button--small button--danger"
                      disabled={!connected || forgetting}
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
      )}
    </section>
  );
}
