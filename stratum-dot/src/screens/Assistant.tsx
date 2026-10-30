import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { describeCommandError } from '../app/actions';
import { ErrorBoundary } from '../app/ErrorBoundary';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import type { ProtocolBoxStatus } from '../protocol';
import { parseBoxStatus, parseOpenedSession } from '../protocol/results';
import { useSessions } from '../stores/sessionStore';
import { OPENING_TTL_MS, useUi } from '../stores/uiStore';
import { SessionDetail } from './SessionDetail';

/** El agente embebido de Dot (M14, `docs/protocol.md` §22). */
export const COMPANION_AGENT = 'companion';

interface Props {
  now: number;
  /** Hay conexión con el daemon y este Dot puede conducir runs. */
  canControl: boolean;
  connected: boolean;
  composerRef: RefObject<HTMLTextAreaElement>;
  /** Vuelve a la cabina (las sesiones). El asistente sigue vivo en el daemon. */
  onBack(): void;
}

/**
 * La vista *Asistente* (M14, PRD de Dot §23.8): la conversación con el
 * `companion` y su caja. La sesión la abre el daemon, que devuelve la misma si
 * ya existe; Dot solo la pide y la pinta como cualquier otra (sale de su foto).
 * La caja la gobierna el daemon: aquí se consulta, se arranca y se para.
 */
export function Assistant({ now, canControl, connected, composerRef, onBack }: Props) {
  const native = useNative();
  const companionId = useUi((s) => s.companionId);
  const openedAt = useUi((s) => (s.companionId ? s.opening[s.companionId] : undefined));
  const entry = useSessions((s) => (companionId ? s.sessions[companionId] : undefined));
  const listed = useSessions((s) => s.listed);
  const [openError, setOpenError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const opening = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Abrir (o retomar) la sesión del asistente. Una vez por intento: si falla,
  // se dice y se reintenta solo si la persona lo pide.
  useEffect(() => {
    if (!connected || !canControl || companionId || opening.current || openError) return;
    opening.current = true;
    void native
      .openSession({ agent: COMPANION_AGENT })
      .then((raw) => {
        if (!alive.current) return;
        const session = parseOpenedSession(raw);
        if (!session) {
          setOpenError('The daemon answered in a way this version of Dot cannot read.');
          return;
        }
        const ui = useUi.getState();
        ui.setOpening(session.id, Date.now());
        ui.setCompanionId(session.id);
        void native.focusSession(session.id).catch(() => undefined);
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        const error = toCommandError(err);
        setOpenError(
          error.kind === 'unknown'
            ? 'Result unknown: the daemon did not answer in time. Retry: if the assistant was opened, you get the same one.'
            : describeCommandError(error),
        );
      })
      .finally(() => {
        opening.current = false;
      });
  }, [native, connected, canControl, companionId, openError, attempt]);

  // Lo que se mira recibe el texto según se genera.
  useEffect(() => {
    if (companionId) void native.focusSession(companionId).catch(() => undefined);
  }, [native, companionId]);

  const retry = () => {
    setOpenError(null);
    setAttempt((n) => n + 1);
  };
  /** La sesión ya no existe (se cerró en otro sitio): pedir otra es explícito. */
  const startOver = () => {
    useUi.getState().setCompanionId(null);
    retry();
  };

  let conversation;
  if (companionId && entry) {
    conversation = (
      <ErrorBoundary
        resetKey={`${companionId}:${entry.snapshot?.seq ?? ''}`}
        fallback={() => (
          <section className="detail" role="alert">
            <p>The assistant&apos;s conversation can&apos;t be displayed. The rest of Dot keeps working.</p>
          </section>
        )}
      >
        <SessionDetail
          sessionId={companionId}
          entry={entry}
          now={now}
          canControl={canControl}
          connected={connected}
          composerRef={composerRef}
          onBack={onBack}
        />
      </ErrorBoundary>
    );
  } else if (openError) {
    conversation = (
      <section className="detail" aria-label="Assistant">
        <p className="note bad" role="alert">
          The assistant could not be opened: {openError}
        </p>
        <div className="controls">
          <button type="button" className="btn primary" disabled={!canControl} onClick={retry}>
            Retry
          </button>
        </div>
      </section>
    );
  } else if (companionId && listed && connected && (openedAt === undefined || now - openedAt >= OPENING_TTL_MS)) {
    conversation = (
      <section className="detail" aria-label="Assistant" data-session="gone">
        <h2>The assistant&apos;s conversation ended</h2>
        <p className="muted">
          The daemon no longer has it (it was closed somewhere else). What the assistant remembers is kept: it is not
          part of the conversation.
        </p>
        <div className="controls">
          <button type="button" className="btn primary" disabled={!canControl} onClick={startOver}>
            New conversation
          </button>
        </div>
      </section>
    );
  } else {
    conversation = (
      <section className="detail" aria-label="Assistant">
        <p className="muted" role="status">
          {connected ? (canControl ? 'Opening the assistant…' : 'This client cannot talk to the assistant.') : 'Not connected to the Stratum daemon.'}
        </p>
      </section>
    );
  }

  return (
    <main className="body split assistant">
      <BoxPanel connected={connected} canControl={canControl} />
      {conversation}
    </main>
  );
}

const STATE_LABEL: Record<ProtocolBoxStatus['state'], string> = {
  unavailable: 'Unavailable',
  absent: 'Not created yet',
  stopped: 'Stopped',
  running: 'Running',
};

type BoxOrder = 'start' | 'stop';

/**
 * La caja del asistente (M13): su estado, y arrancarla o pararla. Lo que se
 * enseña es lo que contesta el daemon —a la consulta o a la orden—, nunca un
 * estado supuesto. Borrarla (`box.reset`) no está aquí: se hace desde la CLI.
 */
function BoxPanel({ connected, canControl }: { connected: boolean; canControl: boolean }) {
  const native = useNative();
  const [box, setBox] = useState<ProtocolBoxStatus | null>(null);
  const [busy, setBusy] = useState<BoxOrder | 'status' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((raw: unknown) => {
    const parsed = parseBoxStatus(raw);
    if (!parsed) {
      setError('The daemon answered in a way this version of Dot cannot read.');
      return;
    }
    setBox(parsed);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    setBusy('status');
    try {
      const raw = await native.boxStatus();
      if (alive.current) apply(raw);
    } catch (err) {
      if (alive.current) setError(describeCommandError(toCommandError(err)));
    } finally {
      if (alive.current) setBusy(null);
    }
  }, [native, apply]);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  const order = async (kind: BoxOrder) => {
    setBusy(kind);
    setError(null);
    try {
      const raw = kind === 'start' ? await native.boxStart() : await native.boxStop();
      if (alive.current) apply(raw);
    } catch (err) {
      if (!alive.current) return;
      const e = toCommandError(err);
      setError(
        e.kind === 'unknown'
          ? 'Result unknown: the daemon did not answer in time. Refresh to see the state of the box.'
          : describeCommandError(e),
      );
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const ordering = busy === 'start' || busy === 'stop';
  const can = connected && canControl && !ordering;
  return (
    <aside className="overview box-panel" aria-label="Assistant's box" data-box-state={box?.state ?? 'unknown'}>
      <div className="overview-head">
        <h2>Box</h2>
        <button
          type="button"
          className="btn ghost small"
          disabled={!connected || busy !== null}
          onClick={() => void refresh()}
          aria-label="Refresh the box state"
        >
          Refresh
        </button>
      </div>
      <p className="muted small">
        The assistant&apos;s own computer: an isolated container where it runs commands without asking. It cannot see
        your files.
      </p>
      {box ? (
        <dl className="fields">
          <dt>State</dt>
          <dd data-e2e="box-state">{STATE_LABEL[box.state]}</dd>
          <dt>Runtime</dt>
          <dd>{box.runtime ?? '—'}</dd>
          <dt>Image</dt>
          <dd className="mono">{box.image}</dd>
          <dt>Network</dt>
          <dd>{box.network ? 'Internet access' : 'No network'}</dd>
          <dt>Shared folder</dt>
          <dd className="mono" title="Mounted at /exchange inside the box">
            {box.exchangeDir}
          </dd>
        </dl>
      ) : busy === 'status' ? (
        <p className="muted small" role="status">
          Checking the box…
        </p>
      ) : null}
      {box?.reason ? <p className="note small">{box.reason}</p> : null}
      {box && !box.enabled ? (
        <p className="note small" role="note">
          The assistant cannot use the box yet: enable it with <span className="mono">box.enabled</span> in the global
          Stratum configuration.
        </p>
      ) : null}
      {box?.outdated ? (
        <p className="note small" role="note">
          Its image or settings changed: starting it recreates it. Its home is kept.
        </p>
      ) : null}
      {ordering ? (
        <p className="pending small" role="status">
          {busy === 'start'
            ? 'Starting the box… The first start builds its image and can take a few minutes.'
            : 'Stopping the box…'}
        </p>
      ) : null}
      {error ? (
        <p className="note bad small" role="alert">
          {error}
        </p>
      ) : null}
      <div className="controls">
        {box && box.state !== 'running' ? (
          <button
            type="button"
            className="btn primary small"
            disabled={!can || box.state === 'unavailable'}
            onClick={() => void order('start')}
          >
            Start box
          </button>
        ) : null}
        {box?.state === 'running' ? (
          <>
            <button type="button" className="btn small" disabled={!can} onClick={() => void order('stop')}>
              Stop box
            </button>
            {box.outdated ? (
              <button type="button" className="btn primary small" disabled={!can} onClick={() => void order('start')}>
                Recreate box
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  );
}
