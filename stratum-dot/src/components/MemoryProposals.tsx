import { useCallback, useEffect, useRef, useState } from 'react';
import { describeCommandError } from '../app/actions';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import type { ProtocolDreamResult, ProtocolMemorySection, ProtocolProposal } from '../protocol';
import { memorySectionOf } from '../protocol';
import { parseApplied, parseDream, parseProposals, parseRejected } from '../protocol/results';

interface Props {
  connected: boolean;
  /** Este Dot puede cambiar cosas (`control`): pedir una revisión, aplicar, rechazar. */
  canControl: boolean;
  /** Se aplicó una propuesta: la memoria cambió, el inspector vuelve a pedirla. */
  onApplied(): void;
}

const UNREADABLE = 'The daemon answered in a way this version of Dot cannot read.';

const SECTION_LABEL: Record<ProtocolMemorySection, string> = {
  profile: 'You',
  person: 'People',
  project: 'Projects',
  topic: 'Topics',
  area: 'Areas',
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
      return `Remember “${p.title ?? ''}”`;
    case 'correct':
      return `Update “${target}”`;
    case 'merge':
      return `Merge ${p.targets.length} memories into “${p.title ?? ''}”`;
    case 'prune':
      return `Forget “${target}”`;
    case 'reclassify':
      return `Move “${target}” to ${SECTION_LABEL[memorySectionOf(p.type ?? 'topic')]}`;
    case 'promote':
      return `Mark “${target}” as important`;
  }
}

const DREAM_NOTE: Partial<Record<NonNullable<ProtocolDreamResult['reason']>, string>> = {
  'nothing-new': 'No new conversations since the last review.',
  budget: 'Today’s limit for memory reviews has been reached.',
  'no-model': 'No model is available to review the memory.',
  cancelled: 'The review was cancelled.',
};

/**
 * M19 fase 5 — cambios que sugiere la revisión de la memoria (*dreaming*): el
 * asistente mira las conversaciones recientes y **propone**; nada cambia hasta
 * que la persona aplica una. **Sin estado optimista**: tras aplicar, rechazar o
 * revisar se vuelve a pedir la lista; una orden sin respuesta es «Result
 * unknown» y no se repite sola.
 */
export function MemoryProposals({ connected, canControl, onApplied }: Props) {
  const native = useNative();
  const [proposals, setProposals] = useState<ProtocolProposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
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
      const list = parseProposals(await native.memoryProposals());
      if (!alive.current || seq !== requestSeq.current) return;
      if (list) {
        setProposals(list);
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
          tone: 'bad',
          text: failure.kind === 'unknown' ? unknownText : describeCommandError(failure),
        });
      }
    } finally {
      if (alive.current) setBusy(false);
    }
    if (alive.current) void load();
  };

  const review = async () => {
    setReviewing(true);
    await act(async () => {
      const result = parseDream(await native.memoryDream(false));
      if (!alive.current) return;
      if (!result) return setNote({ tone: 'bad', text: UNREADABLE });
      if (result.status === 'done') {
        setNote({
          tone: 'info',
          text:
            result.proposals.length === 0
              ? 'Reviewed: nothing to change.'
              : `Reviewed: ${result.proposals.length} suggested ${result.proposals.length === 1 ? 'change' : 'changes'}.`,
        });
      } else {
        const text = (result.reason && DREAM_NOTE[result.reason]) || result.message;
        setNote({ tone: result.status === 'failed' ? 'bad' : 'info', text });
      }
    }, 'Result unknown: the daemon did not answer in time. Refresh to see whether there are new suggestions.');
    if (alive.current) setReviewing(false);
  };

  const apply = (p: ProtocolProposal) =>
    act(async () => {
      const done = parseApplied(await native.memoryApplyProposal(p.id));
      if (!alive.current) return;
      if (done === null) return setNote({ tone: 'bad', text: UNREADABLE });
      setNote({ tone: done.applied ? 'info' : 'bad', text: done.message });
      if (done.applied) onApplied();
    }, 'Result unknown: the daemon did not answer in time. Refresh to see whether it was applied.');

  const reject = (p: ProtocolProposal) =>
    act(async () => {
      const done = parseRejected(await native.memoryRejectProposal(p.id));
      if (!alive.current) return;
      if (done === null) return setNote({ tone: 'bad', text: UNREADABLE });
      if (!done.rejected) setNote({ tone: 'bad', text: done.message });
    }, 'Result unknown: the daemon did not answer in time. Refresh to see whether it was dismissed.');

  const canChange = connected && canControl && !busy;

  return (
    <section className="memory-proposals" aria-label="Suggested changes" data-e2e="memory-proposals">
      <div className="overview-head">
        <h3>Suggested changes</h3>
        <span className="controls">
          <button
            type="button"
            className="btn small"
            disabled={!canChange}
            onClick={() => void review()}
            aria-label="Review the memory now"
          >
            {reviewing ? 'Reviewing…' : 'Review now'}
          </button>
        </span>
      </div>
      <p className="muted small">
        The assistant looks at recent conversations and suggests changes to what it remembers. Nothing
        changes until you apply one.
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
      {proposals !== null && proposals.length === 0 && !error ? (
        <p className="muted small" data-e2e="proposals-empty">
          No suggestions right now.
        </p>
      ) : null}
      <ul className="memory-list">
        {(proposals ?? []).map((p) => (
          <li key={p.id} className="memory-item" data-proposal={p.id}>
            <div className="row-top">
              <strong>{headline(p)}</strong>
            </div>
            {p.content ? <p className="memory-content small">{p.content}</p> : null}
            <div className="muted small">{p.rationale}</div>
            <div className="muted small">
              {p.evidence.length > 0
                ? `From ${p.evidence.length} ${p.evidence.length === 1 ? 'message' : 'messages'} · `
                : ''}
              expires {when(p.expiresAt)}
            </div>
            <div className="controls">
              <button
                type="button"
                className="btn small"
                disabled={!canChange}
                onClick={() => void apply(p)}
                aria-label={`Apply: ${headline(p)}`}
              >
                Apply
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={!canChange}
                onClick={() => void reject(p)}
                aria-label={`Dismiss: ${headline(p)}`}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
