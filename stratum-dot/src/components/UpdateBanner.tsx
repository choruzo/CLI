import type { Updates } from '../app/useUpdates';

function formatMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Aviso de una versión nueva de Dot (M23). Nunca instala solo: la persona elige
 * «Install and restart» o «Later» (que aparca esa versión). El daemon y sus
 * sesiones siguen mientras Dot se reinicia.
 */
export function UpdateBanner({ updates }: { updates: Updates }) {
  const { offer, phase } = updates;
  if (!offer) return null;

  const busy = phase.kind === 'downloading' || phase.kind === 'installing';
  const failed = phase.kind === 'error' ? phase.message : null;
  const percent =
    phase.kind === 'downloading' && phase.total ? Math.round((phase.downloaded / phase.total) * 100) : null;

  return (
    <div className={`banner ${failed ? 'bad' : ''}`} role="status" aria-label="Update available" data-update={phase.kind}>
      <span>
        <strong>Stratum Dot {offer.version} is available</strong>
        <span className="banner-body">
          {busy
            ? phase.kind === 'installing'
              ? 'Installing: Dot will restart by itself. The daemon and its sessions keep running.'
              : `Downloading ${formatMB(phase.downloaded)}${phase.total ? ` of ${formatMB(phase.total)}` : ''}${percent !== null ? ` (${percent}%)` : ''}…`
            : failed
              ? `Could not install it: ${failed}`
              : `You have ${offer.currentVersion}. The daemon and its sessions keep running while Dot restarts.`}
        </span>
        {offer.notes && !busy ? (
          <details className="banner-body">
            <summary>What's new</summary>
            <pre className="update-notes">{offer.notes}</pre>
          </details>
        ) : null}
      </span>
      {busy ? null : (
        <span className="banner-actions">
          <button type="button" className="btn" onClick={updates.dismiss}>
            Later
          </button>
          {failed ? (
            // El paquete pendiente se consumió al intentarlo: hay que volver a buscar.
            <button type="button" className="btn primary" onClick={updates.check}>
              Retry
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={updates.install}>
              Install and restart
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** Texto del botón del pie: comprobar a mano y qué salió. */
export function updateCheckLabel(phase: Updates['phase']): { label: string; title: string } {
  switch (phase.kind) {
    case 'checking':
      return { label: 'Checking…', title: 'Looking for a newer Stratum Dot' };
    case 'none':
      return phase.manual
        ? { label: 'Dot is up to date', title: 'No newer Stratum Dot was found. Click to check again.' }
        : { label: 'Check for updates', title: 'Look for a newer Stratum Dot' };
    case 'error':
      return phase.manual && !phase.info
        ? { label: 'Update check failed', title: `${phase.message} Click to try again.` }
        : { label: 'Check for updates', title: 'Look for a newer Stratum Dot' };
    default:
      return { label: 'Check for updates', title: 'Look for a newer Stratum Dot' };
  }
}
