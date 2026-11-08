import { useCallback, useEffect, useRef, useState } from 'react';
import { describeFailure } from '../../client/actions';
import type { NativeBridge } from '../../ipc/native';
import { toCommandError } from '../../ipc/native';
import { memorySectionOf, type ProtocolMemorySection, type ProtocolProposal } from '../../protocol';
import { parseApplied, parseDream, parseProposals, parseRejected } from '../../protocol/results';

const UNREADABLE = 'El daemon contestó algo que esta versión de Desktop no entiende.';

const SECTION_LABEL: Record<ProtocolMemorySection, string> = {
  profile: 'Tú',
  person: 'Personas',
  project: 'Proyectos',
  topic: 'Temas',
  area: 'Áreas',
};

const when = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toLocaleDateString();
};

/** Qué cambiaría una propuesta, en una línea. */
export function headline(p: ProtocolProposal): string {
  const target = p.targets[0]?.title ?? '';
  switch (p.kind) {
    case 'create':
      return `Recordar «${p.title ?? ''}»`;
    case 'correct':
      return `Actualizar «${target}»`;
    case 'merge':
      return `Fusionar ${p.targets.length} recuerdos en «${p.title ?? ''}»`;
    case 'prune':
      return `Olvidar «${target}»`;
    case 'reclassify':
      return `Mover «${target}» a ${SECTION_LABEL[memorySectionOf(p.type ?? 'topic')]}`;
    case 'promote':
      return `Marcar «${target}» como importante`;
  }
}

const DREAM_NOTE = {
  'nothing-new': 'No hay conversaciones nuevas desde la última revisión.',
  budget: 'Se alcanzó el límite de revisiones de hoy.',
  'no-model': 'No hay ningún modelo disponible para revisar la memoria.',
  cancelled: 'La revisión se canceló.',
} as const;

/**
 * M19 fase 5 — cambios que sugiere la revisión de la memoria (*dreaming*): el
 * asistente mira las conversaciones recientes y **propone**; nada cambia hasta
 * que la persona aplica una. **Sin estado optimista**: tras aplicar, descartar
 * o revisar se vuelve a pedir la lista; una orden sin respuesta es «resultado
 * desconocido» y no se repite sola.
 */
export function MemoryProposals({
  native,
  connected,
  onApplied,
}: {
  native: NativeBridge;
  connected: boolean;
  /** Se aplicó una propuesta: la memoria cambió y el panel vuelve a pedirla. */
  onApplied: () => void;
}) {
  const [proposals, setProposals] = useState<ProtocolProposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
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
      const list = parseProposals(await native.memoryProposals());
      if (!alive.current || seq !== requestSeq.current) return;
      if (list) {
        setProposals(list);
        setError(null);
      } else setError(UNREADABLE);
    } catch (err) {
      if (alive.current && seq === requestSeq.current) {
        setError(describeFailure('No se pudieron leer las sugerencias', toCommandError(err)));
      }
    }
  }, [native]);

  useEffect(() => {
    if (connected) void load();
  }, [connected, load]);

  /** Ejecuta una orden y vuelve a pedir la lista; una sin respuesta se dice, no se repite. */
  const act = async (run: () => Promise<void>, unknownText: string) => {
    setBusy(true);
    setNote(null);
    try {
      await run();
    } catch (err) {
      if (alive.current) {
        const failure = toCommandError(err);
        setNote({
          tone: 'error',
          text: failure.kind === 'unknown' ? unknownText : describeFailure('No se pudo', failure),
        });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const review = async () => {
    setReviewing(true);
    await act(
      async () => {
        const result = parseDream(await native.memoryDream(false));
        if (!alive.current) return;
        if (!result) return setNote({ tone: 'error', text: UNREADABLE });
        if (result.status === 'done') {
          const n = result.proposals.length;
          setNote({
            tone: 'info',
            text:
              n === 0
                ? 'Revisado: no hay nada que cambiar.'
                : `Revisado: ${n} ${n === 1 ? 'cambio sugerido' : 'cambios sugeridos'}.`,
          });
        } else {
          const text = (result.reason && result.reason in DREAM_NOTE
            ? DREAM_NOTE[result.reason as keyof typeof DREAM_NOTE]
            : undefined) ?? result.message;
          setNote({ tone: result.status === 'failed' ? 'error' : 'info', text });
        }
      },
      'Resultado desconocido: el daemon no contestó a tiempo. Recarga para ver si hay sugerencias nuevas.',
    );
    if (alive.current) setReviewing(false);
  };

  const apply = (p: ProtocolProposal) =>
    act(async () => {
      const done = parseApplied(await native.memoryApplyProposal(p.id));
      if (!alive.current) return;
      if (done === null) return setNote({ tone: 'error', text: UNREADABLE });
      setNote({ tone: done.applied ? 'info' : 'error', text: done.message });
      if (done.applied) onApplied();
    }, 'Resultado desconocido: el daemon no contestó a tiempo. Recarga para ver si se aplicó.');

  const reject = (p: ProtocolProposal) =>
    act(async () => {
      const done = parseRejected(await native.memoryRejectProposal(p.id));
      if (!alive.current) return;
      if (done === null) return setNote({ tone: 'error', text: UNREADABLE });
      if (!done.rejected) setNote({ tone: 'error', text: done.message });
    }, 'Resultado desconocido: el daemon no contestó a tiempo. Recarga para ver si se descartó.');

  const canChange = connected && !busy;

  return (
    <section
      className="assistant-memory__proposals"
      aria-label="Cambios sugeridos"
      data-e2e="memory-proposals"
    >
      <div className="assistant-memory__head">
        <h4 className="assistant-memory__section-title">Cambios sugeridos</h4>
        <button
          type="button"
          className="button button--small"
          disabled={!canChange}
          onClick={() => void review()}
          aria-label="Revisar la memoria ahora"
        >
          {reviewing ? 'Revisando…' : 'Revisar ahora'}
        </button>
      </div>
      <p className="side-panel__empty">
        El asistente mira las conversaciones recientes y sugiere cambios en lo que recuerda. Nada
        cambia hasta que apliques uno.
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
      {proposals !== null && proposals.length === 0 && !error && (
        <p className="side-panel__empty" data-e2e="proposals-empty">
          No hay sugerencias ahora mismo.
        </p>
      )}
      <ul className="assistant-memory__list">
        {(proposals ?? []).map((p) => (
          <li key={p.id} className="assistant-memory__item" data-proposal={p.id}>
            <strong className="assistant-memory__title-static">{headline(p)}</strong>
            {p.content && <p className="memory-summary">{p.content}</p>}
            <div className="assistant-memory__meta">{p.rationale}</div>
            <div className="assistant-memory__meta">
              {p.evidence.length > 0
                ? `De ${p.evidence.length} ${p.evidence.length === 1 ? 'mensaje' : 'mensajes'} · `
                : ''}
              caduca {when(p.expiresAt)}
            </div>
            <div className="assistant-memory__actions">
              <button
                type="button"
                className="button button--small"
                disabled={!canChange}
                onClick={() => void apply(p)}
                aria-label={`Aplicar: ${headline(p)}`}
              >
                Aplicar
              </button>
              <button
                type="button"
                className="button button--small"
                disabled={!canChange}
                onClick={() => void reject(p)}
                aria-label={`Descartar: ${headline(p)}`}
              >
                Descartar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
