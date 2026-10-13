import type { ConnectionState } from '../bridge/native';
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

/** Aviso bajo la cabecera cuando no hay conexión. Con conexión no se pinta nada. */
export function ConnectionBanner({ state, hasStaleSessions, onRetry }: Props) {
  if (state.kind === 'connected' || state.kind === 'incompatible') return null;
  // «Starting…» y «Connecting…» ya los dice la cabecera, y duran un instante.
  if (state.kind === 'starting' || state.kind === 'connecting') return null;
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
