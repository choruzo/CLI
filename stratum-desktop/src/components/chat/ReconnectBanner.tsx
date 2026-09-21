import { useEffect, useState } from 'react';
import type { SidecarStatus } from '../../ipc/types';

/**
 * Banner de reconexión (15.5): intento N de 4 con cuenta atrás mientras el
 * supervisor relanza el sidecar; agotados, «Reintentar».
 */
export function ReconnectBanner({
  status,
  onRestart,
}: {
  status: SidecarStatus;
  onRestart: () => void;
}) {
  const reconnecting = status.state === 'reconnecting' ? status : null;
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!reconnecting) return;
    const until = Date.now() + reconnecting.delayMs;
    const tick = () => setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [reconnecting]);

  if (status.state === 'reconnecting') {
    return (
      <div className="banner" data-tone="warn" role="status" aria-live="polite">
        El agente se detuvo. Reintentando ({status.attempt}/{status.maxAttempts})
        {remaining > 0 ? ` en ${remaining} s…` : '…'}
      </div>
    );
  }
  if (status.state === 'failed') {
    return (
      <div className="banner" data-tone="error" role="alert">
        <span>El agente no está disponible: {status.message}</span>
        <button type="button" className="button" onClick={onRestart}>
          Reintentar
        </button>
      </div>
    );
  }
  if (status.state === 'disconnected') {
    return (
      <div className="banner" data-tone="warn" role="status">
        Conexión con el agente perdida: {status.reason}
      </div>
    );
  }
  return null;
}
