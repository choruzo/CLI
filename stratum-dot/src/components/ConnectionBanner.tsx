import type { ConnectionState } from '../bridge/native';
import { revisionSkewNotice } from '../protocol/revision-skew';
import type { Tone } from '../protocol/view';

export function connectionLabel(state: ConnectionState): string {
  switch (state.kind) {
    case 'starting':
      return 'Starting…';
    case 'daemon-starting':
      return 'Starting the Stratum daemon…';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'incompatible':
      return 'Incompatible daemon';
    case 'error':
      return 'Not connected';
  }
}

export function connectionTone(state: ConnectionState): Tone {
  switch (state.kind) {
    case 'connected':
      return 'ok';
    case 'incompatible':
    case 'error':
      return 'bad';
    default:
      return 'waiting';
  }
}

interface Props {
  state: ConnectionState;
  /** Hay sesiones en pantalla de antes de perder la conexión. */
  hasStaleSessions: boolean;
  onRetry(): void;
}

/**
 * Aviso bajo la cabecera cuando no hay conexión. Con conexión solo se pinta el
 * desfase de revisión del protocolo con el daemon (M23): persistente y sin
 * bloquear nada.
 */
export function ConnectionBanner({ state, hasStaleSessions, onRetry }: Props) {
  if (state.kind === 'connected') {
    const skew = revisionSkewNotice(state.serverRevision, state.serverVersion);
    if (!skew) return null;
    return (
      <div className="banner warn" role="status" data-skew={skew.kind}>
        <span>
          <strong>{skew.title}</strong>
          <span className="banner-body">{skew.body}</span>
        </span>
      </div>
    );
  }
  if (state.kind === 'incompatible') return null;
  // «Starting…» y «Connecting…» ya los dice la cabecera, y duran un instante.
  if (state.kind === 'starting' || state.kind === 'connecting') return null;
  if (state.kind === 'error' && state.reason === 'cli-missing') {
    // Dot exige la CLI instalada aparte: es la que trae el daemon (M23).
    return (
      <div className="banner bad" role="alert" data-reason="cli-missing">
        <span>
          <strong>Stratum Dot needs the Stratum CLI</strong>
          <span className="banner-body">
            The CLI runs the daemon that Dot talks to, and it is installed on its own. With Node.js 22 or later, run{' '}
            <code>npm install -g stratum-cli</code>, then press Retry. If the daemon is already running elsewhere, Dot
            connects by itself.
          </span>
        </span>
        <button type="button" className="btn" onClick={onRetry} aria-label="Retry connecting to the daemon">
          Retry
        </button>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="banner bad" role="alert">
        <span>{state.message}</span>
        <button type="button" className="btn" onClick={onRetry} aria-label="Retry connecting to the daemon">
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="banner" role="status">
      <span>
        {state.kind === 'reconnecting'
          ? `Lost the connection to the Stratum daemon. Reconnecting (attempt ${state.attempt})…`
          : connectionLabel(state)}
        {hasStaleSessions && state.kind === 'reconnecting' ? ' Showing the last known state.' : ''}
      </span>
    </div>
  );
}
