import { useEffect, useState } from 'react';
import { approvalsStore, canResolve } from '../../client/approvals';
import {
  loadDiff,
  revert,
  revertPlan,
  type Changes,
  type FileDiff,
  type Loaded,
  type RevertResult,
} from '../../client/code-actions';
import { useStore } from '../../client/store';
import type { ChangesState } from '../../hooks/useChanges';
import type { NativeBridge } from '../../ipc/native';
import { ICON, StrokeIcon } from '../chat/icons';

type Change = Changes['changes'][number];

const STATUS_MARK: Record<Change['status'], { mark: string; label: string }> = {
  modified: { mark: 'M', label: 'modificado' },
  added: { mark: 'A', label: 'añadido' },
  deleted: { mark: 'D', label: 'borrado' },
  renamed: { mark: 'R', label: 'renombrado' },
  untracked: { mark: 'U', label: 'sin seguimiento' },
};

/** Cuántos turnos se pueden deshacer de una vez desde aquí. */
const MAX_UNDO_TURNS = 5;

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

/** Clasifica las líneas de un diff unificado para pintarlas. Puro. */
export function diffLines(diff: string): Array<{ kind: DiffLineKind; text: string }> {
  const lines = diff.replace(/\n$/, '').split('\n');
  let inHunk = false;
  return lines.map((text) => {
    if (text.startsWith('@@')) {
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (text.startsWith('diff --git')) inHunk = false;
    // La cabecera (`--- a/x`, `+++ b/x`, `index …`) va antes del primer hunk.
    if (!inHunk) return { kind: 'meta', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    if (text.startsWith('\\')) return { kind: 'meta', text };
    return { kind: 'context', text };
  });
}

export function DiffView({ diff }: { diff: FileDiff }) {
  if (diff.binary) return <p className="diff__note">Fichero binario o demasiado grande: no hay diff que enseñar.</p>;
  if (!diff.diff.trim()) return <p className="diff__note">Sin diferencias de contenido.</p>;
  return (
    <>
      <pre className="diff" tabIndex={0} aria-label="Diff del fichero">
        {diffLines(diff.diff).map((line, i) => (
          <span key={i} className="diff__line" data-kind={line.kind}>
            {line.text || ' '}
            {'\n'}
          </span>
        ))}
      </pre>
      {diff.truncated && <p className="diff__note">El diff es más largo: se enseña solo el principio.</p>}
    </>
  );
}

function ChangeRow({
  change,
  open,
  diff,
  onToggle,
}: {
  change: Change;
  open: boolean;
  diff: Loaded<FileDiff> | null;
  onToggle: () => void;
}) {
  const status = STATUS_MARK[change.status];
  const slash = change.path.lastIndexOf('/');
  return (
    <li className="change-row" data-open={open || undefined}>
      <button type="button" className="change-row__main" aria-expanded={open} title={change.path} onClick={onToggle}>
        <span className="change-row__status" data-status={change.status} title={status.label} aria-label={status.label}>
          {status.mark}
        </span>
        <span className="change-row__path">
          {slash >= 0 && <span className="change-row__dir">{change.path.slice(0, slash + 1)}</span>}
          {change.path.slice(slash + 1)}
        </span>
        {change.binary ? (
          <span className="change-row__count">bin</span>
        ) : (
          <span className="change-row__count">
            <span className="code-bar__added">+{change.added}</span> <span className="code-bar__deleted">−{change.deleted}</span>
          </span>
        )}
      </button>
      {open &&
        (diff === null ? (
          <p className="diff__note" role="status">
            Cargando el diff…
          </p>
        ) : diff.ok ? (
          <DiffView diff={diff.value} />
        ) : (
          <p className="notice" data-tone="warning" role="alert">
            {diff.message}
          </p>
        ))}
    </li>
  );
}

/** Rutas de un plan, recortadas: los primeros nombres y cuántos más. */
function PathList({ title, paths, tone }: { title: string; paths: string[]; tone?: 'warning' }) {
  if (paths.length === 0) return null;
  const shown = paths.slice(0, 6);
  return (
    <div className="undo-plan__group" data-tone={tone}>
      <span className="undo-plan__title">
        {title} ({paths.length})
      </span>
      <ul>
        {shown.map((p) => (
          <li key={p}>{p}</li>
        ))}
        {paths.length > shown.length && <li>y {paths.length - shown.length} más</li>}
      </ul>
    </div>
  );
}

type UndoState =
  | { step: 'idle' }
  | { step: 'planning' }
  | { step: 'planned'; result: RevertResult }
  | { step: 'confirming'; result: RevertResult }
  | { step: 'done'; result: RevertResult }
  | { step: 'failed'; message: string };

/**
 * Deshacer los ficheros de los últimos turnos (`sessions.revert`). Pisa
 * ficheros sin pasar por las aprobaciones del agente, así que exige la
 * autoridad de aprobar: primero se enseña qué haría (sin tocar nada) y deshacer
 * de verdad se confirma en la ventana nativa. Con conflictos no se ofrece:
 * forzarlo es cosa de la terminal.
 */
function UndoSection({
  native,
  sessionId,
  blocked,
  onDone,
}: {
  native: NativeBridge;
  sessionId: string;
  /** Por qué no se puede ahora (turno en marcha, sesión de una terminal…). */
  blocked: string | null;
  onDone: () => void;
}) {
  const status = useStore(approvalsStore, (s) => s.status);
  const [turns, setTurns] = useState(1);
  const [state, setState] = useState<UndoState>({ step: 'idle' });
  const ready = canResolve(status);
  const busy = state.step === 'planning' || state.step === 'confirming';

  const plan = async () => {
    setState({ step: 'planning' });
    const result = await revertPlan(native, sessionId, turns);
    setState(result.ok ? { step: 'planned', result: result.value } : { step: 'failed', message: result.message });
  };
  const run = async (planned: RevertResult) => {
    setState({ step: 'confirming', result: planned });
    const result = await revert(native, sessionId, turns);
    if (result.ok) {
      setState({ step: 'done', result: result.value });
      onDone();
    } else if ('cancelled' in result) setState({ step: 'planned', result: planned });
    else setState({ step: 'failed', message: result.message });
  };

  const shown = state.step === 'planned' || state.step === 'confirming' || state.step === 'done' ? state.result : null;
  const plannedOk = shown?.status === 'planned' && shown.plan !== null && shown.plan.conflicts.length === 0;

  return (
    <section className="undo" aria-label="Deshacer turnos">
      <div className="undo__row">
        <label className="undo__turns">
          Deshacer
          <select
            aria-label="Cuántos turnos deshacer"
            value={turns}
            disabled={busy}
            onChange={(e) => {
              setTurns(Number(e.target.value));
              setState({ step: 'idle' });
            }}
          >
            {Array.from({ length: MAX_UNDO_TURNS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n === 1 ? 'el último turno' : `los últimos ${n} turnos`}
              </option>
            ))}
          </select>
        </label>
        {ready ? (
          <button type="button" className="button button--small" disabled={busy || blocked !== null} onClick={() => void plan()}>
            {state.step === 'planning' ? 'Calculando…' : 'Ver qué se desharía'}
          </button>
        ) : (
          <button
            type="button"
            className="button button--small"
            disabled={status.kind === 'unlocking' || status.kind === 'unavailable'}
            title="Deshacer pisa ficheros: pide la misma autoridad que aprobar"
            onClick={() => void native.unlockApprovals().catch(() => undefined)}
          >
            {status.kind === 'unlocking' ? 'Desbloqueando…' : 'Desbloquear para deshacer'}
          </button>
        )}
      </div>
      {blocked && <p className="undo__hint">{blocked}</p>}
      {state.step === 'failed' && (
        <p className="notice" data-tone="warning" role="alert">
          {state.message}
        </p>
      )}
      {shown && (
        <div className="undo-plan" role="status">
          {shown.status === 'nothing' && <p className="undo__hint">No hay nada que deshacer en esos turnos.</p>}
          {shown.status === 'failed' && <p className="undo__hint">El daemon no pudo deshacer esos turnos.</p>}
          {shown.status === 'reverted' && <p className="undo__hint">Hecho: los ficheros han vuelto a como estaban.</p>}
          {shown.status === 'conflicts' && (
            <p className="undo__hint" data-tone="warning">
              Hay ficheros cambiados después de esos turnos: deshacer los pisaría. Desde Desktop no se fuerza; hazlo desde la
              terminal con <code>/undo</code> si de verdad lo quieres.
            </p>
          )}
          {shown.plan && (
            <>
              <PathList title="Se restauran" paths={shown.plan.restore} />
              <PathList title="Se borran" paths={shown.plan.remove} />
              <PathList title="Cambiados después (conflicto)" paths={shown.plan.conflicts} tone="warning" />
              <PathList title="Sin copia, no se deshacen" paths={shown.plan.skipped} />
              {shown.plan.truncated && <p className="undo__hint">La lista es más larga: se enseña solo una parte.</p>}
            </>
          )}
          {state.step !== 'done' && (
            <div className="undo__row">
              <button type="button" className="button button--small" disabled={busy} onClick={() => setState({ step: 'idle' })}>
                Cancelar
              </button>
              {plannedOk && (
                <button
                  type="button"
                  className="button button--danger button--small"
                  disabled={busy || blocked !== null}
                  onClick={() => void run(shown)}
                >
                  {state.step === 'confirming' ? 'Confírmalo en la ventana…' : 'Deshacer…'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Cambios del árbol de trabajo de la sesión (`git.changes`, los lee
 * `useChanges`) y el diff de cada fichero (`git.diff`), los dos de solo
 * lectura y calculados por el daemon. El diff se pide al abrir el fichero y se
 * descarta cuando la lista se vuelve a leer.
 */
export function ChangesPanel({
  native,
  sessionId,
  state,
  connected,
  undoBlocked,
}: {
  native: NativeBridge;
  sessionId: string | null;
  state: ChangesState;
  connected: boolean;
  undoBlocked: string | null;
}) {
  const { changes, loading, refresh } = state;
  const [open, setOpen] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, Loaded<FileDiff>>>({});

  // Lista nueva: los diffs que se tenían pueden ser de antes.
  useEffect(() => setDiffs({}), [changes]);
  useEffect(() => setOpen(null), [sessionId]);

  // El diff del fichero abierto, cuando no se tiene (también tras refrescar).
  useEffect(() => {
    if (!sessionId || !open || diffs[open]) return;
    let alive = true;
    const path = open;
    void loadDiff(native, sessionId, path).then((d) => alive && setDiffs((all) => ({ ...all, [path]: d })));
    return () => {
      alive = false;
    };
  }, [native, sessionId, open, diffs]);

  const body = () => {
    if (!sessionId) return <p className="side-panel__empty">Abre una sesión de código para ver sus cambios.</p>;
    if (changes === null) return <p className="side-panel__empty">{connected ? 'Leyendo los cambios…' : 'Sin conexión con Stratum.'}</p>;
    if (!changes.ok) {
      return (
        <p className="notice" data-tone="warning" role="alert">
          {changes.message}
        </p>
      );
    }
    const summary = changes.value;
    if (!summary.isRepo) {
      return <p className="side-panel__empty">La carpeta de esta sesión no es un repositorio git: no hay cambios que medir.</p>;
    }
    return (
      <>
        <UndoSection native={native} sessionId={sessionId} blocked={undoBlocked} onDone={refresh} />
        {summary.files === 0 ? (
          <p className="side-panel__empty">El árbol de trabajo está limpio.</p>
        ) : (
          <>
            <p className="changes__summary">
              {summary.files} {summary.files === 1 ? 'fichero' : 'ficheros'} ·{' '}
              <span className="code-bar__added">+{summary.added}</span> <span className="code-bar__deleted">−{summary.deleted}</span>
            </p>
            <ul className="change-list">
              {summary.changes.map((change) => (
                <ChangeRow
                  key={change.path}
                  change={change}
                  open={open === change.path}
                  diff={diffs[change.path] ?? null}
                  onToggle={() => setOpen((current) => (current === change.path ? null : change.path))}
                />
              ))}
            </ul>
            {summary.truncated && <p className="diff__note">Hay más ficheros cambiados de los que se listan.</p>}
          </>
        )}
      </>
    );
  };

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Cambios</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Actualizar los cambios"
          title="Actualizar"
          disabled={!sessionId || !connected || loading}
          onClick={refresh}
        >
          <StrokeIcon d={ICON.refresh} />
        </button>
      </div>
      <div className="side-panel__body">{body()}</div>
    </div>
  );
}
