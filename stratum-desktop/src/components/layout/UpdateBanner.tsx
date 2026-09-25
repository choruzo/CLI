import { useId, useState } from 'react';
import type { Updates } from '../../hooks/useUpdates';
import { Collapse } from '../chat/Collapse';

function formatMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Aviso de versión nueva (D7). Nunca instala solo: el usuario elige
 * «Instalar y reiniciar» o «Más tarde» (que aparca esa versión).
 */
export function UpdateBanner({ updates }: { updates: Updates }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const notesId = useId();
  const { offer, phase } = updates;
  if (!offer) return null;

  const busy = phase.kind === 'downloading' || phase.kind === 'installing';
  const failed = phase.kind === 'error' ? phase.message : null;
  const percent =
    phase.kind === 'downloading' && phase.total
      ? Math.round((phase.downloaded / phase.total) * 100)
      : null;

  return (
    <section className="update-banner" aria-label="Actualización disponible">
      <div className="update-banner__row">
        <p className="update-banner__text">
          <strong>Stratum {offer.version}</strong> está disponible
          <span className="update-banner__current"> (tienes la {offer.currentVersion})</span>
        </p>
        {!busy && (
          <span className="update-banner__actions">
            {offer.notes && (
              <button
                type="button"
                className="link-button"
                aria-expanded={notesOpen}
                aria-controls={notesId}
                onClick={() => setNotesOpen((v) => !v)}
              >
                Novedades
              </button>
            )}
            <button type="button" className="button" onClick={updates.dismiss}>
              Más tarde
            </button>
            {failed ? (
              // El paquete pendiente se consumió al intentarlo: hay que volver a buscar.
              <button type="button" className="button button--primary" onClick={updates.check}>
                Reintentar
              </button>
            ) : (
              <button type="button" className="button button--primary" onClick={updates.install}>
                Instalar y reiniciar
              </button>
            )}
          </span>
        )}
      </div>
      {failed && (
        <p className="notice" data-tone="error" role="alert">
          No se pudo instalar: {failed}
        </p>
      )}
      {busy && (
        <div className="update-banner__progress">
          <div
            className="progress"
            role="progressbar"
            aria-label="Descarga de la actualización"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            data-indeterminate={percent === null || undefined}
          >
            <span
              className="progress__bar"
              style={percent !== null ? { width: `${percent}%` } : undefined}
            />
          </div>
          <span className="update-banner__status" role="status">
            {phase.kind === 'installing'
              ? 'Instalando: la app se reiniciará sola…'
              : phase.kind === 'downloading'
                ? `Descargando ${formatMB(phase.downloaded)}${phase.total ? ` de ${formatMB(phase.total)}` : ''}…`
                : ''}
          </span>
        </div>
      )}
      {offer.notes && (
        <Collapse open={notesOpen} id={notesId}>
          <pre className="update-banner__notes">{offer.notes}</pre>
        </Collapse>
      )}
    </section>
  );
}
