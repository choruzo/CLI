import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startBridge } from '../bridge/connect';
import { tauriBridge } from '../bridge/native';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import '../styles.css';

function Crashed({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <section className="blocking" role="alert">
      <h2>Stratum Dot hit a problem</h2>
      <p className="muted">
        The interface failed to draw. Nothing was changed in the daemon or in any session: Dot only observes.
      </p>
      <p className="mono small">{error.message}</p>
      <button type="button" className="btn" onClick={retry}>
        Try again
      </button>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={(error, retry) => <Crashed error={error} retry={retry} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

void startBridge(tauriBridge).catch((err) => console.error('dot: cannot reach the native side', err));
