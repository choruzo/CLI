import type { ConnectionState } from '../bridge/native';

interface Props {
  state: Extract<ConnectionState, { kind: 'incompatible' }>;
  onRetry(): void;
}

/**
 * El daemon habla otra versión del protocolo. Dot no intenta conectarse: lo
 * dice claro y espera a que se actualice uno de los dos lados.
 */
export function Incompatible({ state, onRetry }: Props) {
  return (
    <section className="blocking" role="alert" aria-label="Incompatible Stratum daemon">
      <h2>Incompatible Stratum daemon</h2>
      <p>Dot supports protocol {state.clientProtocol}.</p>
      <p>
        Daemon uses protocol {state.daemonProtocol ?? 'unknown'}
        {state.daemonVersion ? ` (Stratum ${state.daemonVersion})` : ''}.
      </p>
      <p className="muted">
        Update the older side. Sessions and runs are not affected: Dot has not connected and has not changed
        anything.
      </p>
      <button type="button" className="btn" onClick={onRetry} aria-label="Check the daemon again">
        Check again
      </button>
    </section>
  );
}
