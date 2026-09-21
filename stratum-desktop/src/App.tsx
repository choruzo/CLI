import { ConnectionIndicator } from './components/layout/ConnectionIndicator';
import { useSidecar } from './hooks/useSidecar';

/**
 * D0: sin chat todavía. La ventana demuestra el camino completo webview → Rust →
 * pipe → sidecar y muestra lo que el sidecar sabe de sí mismo.
 */
export function App() {
  const sidecar = useSidecar();
  const { status } = sidecar;

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Stratum</h1>
        <ConnectionIndicator state={sidecar} />
      </header>

      <section className="panel" aria-label="Estado del agente">
        {status.state === 'connected' && (
          <>
            <dl className="facts">
              <dt>Core</dt>
              <dd>
                {status.core.version}
                {status.core.sea ? ' · binario autónomo' : ' · Node del sistema'}
              </dd>
              <dt>Runtime</dt>
              <dd>
                Node {status.core.node} · {status.core.platform}
              </dd>
              <dt>Esquemas</dt>
              <dd>
                config v{status.core.configSchemaVersion} · sesiones v
                {status.core.sessionSchemaVersion} · protocolo v{status.core.protocolVersion}
              </dd>
            </dl>
            <ul className="natives" aria-label="Módulos nativos">
              {status.natives.map((n) => (
                <li key={n.module} data-ok={n.ok} title={n.error}>
                  <span aria-hidden="true">{n.ok ? '✓' : '✗'}</span> {n.module}
                  {!n.ok && <span className="sr-only"> no disponible</span>}
                </li>
              ))}
            </ul>
            <button type="button" className="button" onClick={sidecar.ping}>
              Ping
            </button>
          </>
        )}
        {status.state === 'disconnected' && (
          <p className="message">
            {status.reason}
            {status.exitCode !== null && ` (código de salida ${status.exitCode})`}
          </p>
        )}
        {status.state === 'failed' && <p className="message">{status.message}</p>}
        {status.state === 'starting' && <p className="message">Arrancando stratum-core…</p>}
      </section>

      {sidecar.errors.map((e) => (
        <section key={`${e.code}:${e.message}`} className="alert" role="alert" data-fatal={e.fatal}>
          <strong>{e.code === 'schema_incompatible' ? 'Configuración incompatible' : 'Error del agente'}</strong>
          <p>{e.message}</p>
        </section>
      ))}
    </main>
  );
}
