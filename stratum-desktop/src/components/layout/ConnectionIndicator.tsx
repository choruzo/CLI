import type { SidecarState } from '../../hooks/useSidecar';
import { isOperational } from '../../hooks/useSidecar';

type Tone = 'ok' | 'pending' | 'warn' | 'error';

export function describeConnection(state: SidecarState): { label: string; tone: Tone } {
  switch (state.status.state) {
    case 'starting':
      return { label: 'Iniciando agente…', tone: 'pending' };
    case 'connected':
      return isOperational(state)
        ? { label: 'Agente conectado', tone: 'ok' }
        : { label: 'Agente conectado con errores', tone: 'warn' };
    case 'disconnected':
      return { label: 'Agente desconectado', tone: 'error' };
    case 'reconnecting':
      return { label: 'Reconectando…', tone: 'warn' };
    case 'failed':
      return { label: 'Agente no disponible', tone: 'error' };
  }
}

/** Punto de estado + texto. `role="status"` para que un lector de pantalla anuncie los cambios. */
export function ConnectionIndicator({ state }: { state: SidecarState }) {
  const { label, tone } = describeConnection(state);
  return (
    <div className="connection" role="status" aria-live="polite" data-tone={tone}>
      <span className="connection__dot" aria-hidden="true" />
      <span className="connection__label">{label}</span>
      {state.status.state === 'connected' && state.latencyMs !== null && (
        <span className="connection__latency">{state.latencyMs.toFixed(1)} ms</span>
      )}
    </div>
  );
}
