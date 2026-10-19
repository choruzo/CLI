import type { ConnectionState } from '../../ipc/native';

type Tone = 'ok' | 'pending' | 'warn' | 'error';

/** Estado del enlace con `stratumd`, para una persona. */
export function describeConnection(state: ConnectionState): { label: string; tone: Tone } {
  switch (state.kind) {
    case 'starting':
      return { label: 'Buscando Stratum…', tone: 'pending' };
    case 'daemon-starting':
      return { label: 'Arrancando Stratum…', tone: 'pending' };
    case 'connecting':
      return { label: 'Conectando…', tone: 'pending' };
    case 'connected':
      return { label: 'Conectado a Stratum', tone: 'ok' };
    case 'reconnecting':
      return { label: 'Reconectando…', tone: 'warn' };
    case 'incompatible':
      return { label: 'Versión de Stratum incompatible', tone: 'error' };
    case 'error':
      return { label: 'Stratum no disponible', tone: 'error' };
  }
}

/** Punto de estado + texto. `role="status"` para que un lector de pantalla anuncie los cambios. */
export function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const { label, tone } = describeConnection(state);
  return (
    <div className="connection" role="status" aria-live="polite" data-tone={tone}>
      <span className="connection__dot" aria-hidden="true" />
      <span className="connection__label">{label}</span>
    </div>
  );
}

/**
 * Aviso no bloqueante con la app en uso: se perdió el daemon y se reconecta
 * solo, o no hay daemon (Reintentar lo arranca con el comando oficial). Lo que
 * se ve hasta entonces es lo último que contó el daemon; al volver, la foto
 * manda.
 */
export function ConnectionBanner({
  state,
  onRetry,
}: {
  state: ConnectionState;
  onRetry: () => void;
}) {
  if (state.kind === 'connected' || state.kind === 'starting' || state.kind === 'connecting') return null;
  let text: string;
  switch (state.kind) {
    case 'daemon-starting':
      text = 'Arrancando el daemon de Stratum (`stratum daemon start`)…';
      break;
    case 'reconnecting':
      text = 'Se perdió la conexión con Stratum. Reconectando… Lo que ves puede no estar al día.';
      break;
    case 'incompatible':
      text = `El daemon de Stratum habla otra versión del protocolo (${state.daemonProtocol ?? '?'}; Desktop habla la ${state.clientProtocol}). Actualiza Stratum o Desktop.`;
      break;
    case 'error':
      text = state.message;
      break;
  }
  return (
    <section className="alert" role="alert" data-fatal={state.kind === 'incompatible' || undefined}>
      <p>{text}</p>
      {(state.kind === 'error' || state.kind === 'incompatible') && (
        <div className="alert__actions">
          <button type="button" className="button" onClick={onRetry}>
            Reintentar
          </button>
        </div>
      )}
    </section>
  );
}
