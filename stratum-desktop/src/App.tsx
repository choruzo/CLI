import { ConnectionIndicator } from './components/layout/ConnectionIndicator';
import { ConversationView } from './components/chat/ConversationView';
import { ReconnectBanner } from './components/chat/ReconnectBanner';
import { isOperational, useSidecar } from './hooks/useSidecar';
import { useAgentStream } from './hooks/useAgentStream';

/**
 * D1: una conversación con el asistente. Varias conversaciones, sidebar y
 * StatusBar completa llegan en D4.
 */
export function App() {
  const sidecar = useSidecar();
  const stream = useAgentStream(sidecar.status);
  const connected = isOperational(sidecar);

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">Stratum</h1>
        <ConnectionIndicator state={sidecar} />
      </header>

      <ReconnectBanner status={sidecar.status} onRestart={sidecar.restart} />
      {sidecar.errors.map((e) => (
        <section key={`${e.code}:${e.message}`} className="alert" role="alert" data-fatal={e.fatal}>
          <strong>
            {e.code === 'schema_incompatible' ? 'Configuración incompatible' : 'Error del agente'}
          </strong>
          <p>{e.message}</p>
        </section>
      ))}

      <ConversationView stream={stream} connected={connected} />
    </main>
  );
}
