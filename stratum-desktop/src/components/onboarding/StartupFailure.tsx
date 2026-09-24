import { useCallback, useEffect, useRef, useState } from 'react';
import { openLogsDir, readLogTail, type LogTail } from '../../ipc/os';
import { AppLogo } from './AppLogo';

/**
 * Fallo de inicio (D6): el agente no llegó a conectar ni una vez en esta
 * sesión y el supervisor se rindió (o falta el binario). Sin agente la app no
 * sirve de nada, así que ocupa la ventana: qué pasó, las últimas líneas del log
 * del sidecar, Reintentar y Ver logs. Una caída posterior, con la app ya en
 * uso, es un banner no bloqueante (`ReconnectBanner`).
 */
export function StartupFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [tail, setTail] = useState<LogTail | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  const load = useCallback(() => {
    readLogTail(40).then(setTail, (err) => setLogError(err instanceof Error ? err.message : String(err)));
  }, []);
  useEffect(load, [load, message]);
  // Lo reciente está al final: se abre desplazado hasta ahí.
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [tail]);

  return (
    <main className="startup-failure" role="alert" aria-labelledby="startup-failure-title">
      <div className="startup-failure__card">
        <AppLogo className="startup-failure__logo" />
        <h1 id="startup-failure-title" className="startup-failure__title">
          No se pudo iniciar el agente
        </h1>
        <p className="startup-failure__message">{message}</p>
        <div className="startup-failure__actions">
          <button
            type="button"
            className="button"
            onClick={() =>
              openLogsDir().catch((err) => setLogError(err instanceof Error ? err.message : String(err)))
            }
          >
            Ver logs
          </button>
          <button type="button" className="button button--primary" onClick={onRetry}>
            Reintentar
          </button>
        </div>
        {logError && <p className="notice" data-tone="error">{logError}</p>}
        {tail && (
          <details className="startup-failure__log" open={tail.text.length > 0}>
            <summary>Últimas líneas de {tail.path}</summary>
            <pre ref={pre}>{tail.text || '(el log está vacío)'}</pre>
          </details>
        )}
      </div>
    </main>
  );
}
