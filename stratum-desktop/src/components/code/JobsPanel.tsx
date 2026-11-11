import { useState } from 'react';
import { useNow } from '../../hooks/useNow';
import type { ProtocolJob } from '../../protocol';

const STATUS_LABEL: Record<ProtocolJob['status'], string> = {
  running: 'en marcha',
  completed: 'terminado',
  failed: 'falló',
  cancelled: 'cancelado',
};

/** `1 h 02 min`, `3 min 05 s`, `12 s`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Los que siguen en marcha primero; después, del más reciente al más antiguo. */
export function sortJobs(jobs: ProtocolJob[]): ProtocolJob[] {
  return [...jobs].sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt,
  );
}

function JobRow({ job, now, onCancel }: { job: ProtocolJob; now: number; onCancel?: () => void }) {
  const [asked, setAsked] = useState(false);
  const running = job.status === 'running';
  const elapsed = formatElapsed((job.endedAt ?? now) - job.startedAt);
  return (
    <li className="job-row" data-status={job.status}>
      <code className="job-row__command" title={`${job.command}\n${job.cwd}`}>
        {job.command}
      </code>
      <span className="job-row__meta">
        <span className="job-row__status" data-status={job.status}>
          {STATUS_LABEL[job.status]}
          {!running && job.exitCode != null ? ` · código ${job.exitCode}` : ''}
        </span>
        <span>{elapsed}</span>
        {job.scope !== 'main' && <span title="Lo lanzó un subagente">subagente</span>}
        {running && onCancel && (
          <button
            type="button"
            className="button button--small"
            disabled={asked}
            onClick={() => {
              setAsked(true);
              onCancel();
            }}
          >
            {asked ? 'Cancelación pedida…' : 'Cancelar'}
          </button>
        )}
      </span>
    </li>
  );
}

/**
 * Procesos en segundo plano de la sesión (`background: true` de `exec`). Salen
 * de la foto de la sesión; cancelar es una petición al daemon y el proceso deja
 * de figurar «en marcha» cuando el anfitrión lo publica.
 */
export function JobsPanel({
  jobs,
  hasSession,
  onCancel,
  onBackground,
}: {
  jobs: ProtocolJob[];
  hasSession: boolean;
  /**
   * Pasar a segundo plano el comando que el agente tiene en marcha (el Ctrl+B
   * de la terminal). Solo con un turno en curso en una sesión del daemon.
   */
  onBackground?: () => void;
  /** Sin él, no se ofrece cancelar (sesión de una terminal, sin conexión). */
  onCancel?: (jobId: string) => void;
}) {
  const sorted = sortJobs(jobs);
  const running = sorted.some((j) => j.status === 'running');
  const now = useNow(running);
  return (
    <div className="side-panel">
      <div className="side-panel__header">
        <h2 className="side-panel__title">Procesos</h2>
        {onBackground && (
          <button
            type="button"
            className="button button--small"
            title="Si el agente está esperando a un comando largo, lo deja corriendo como proceso y sigue"
            onClick={onBackground}
          >
            A segundo plano
          </button>
        )}
      </div>
      <div className="side-panel__body">
        {!hasSession ? (
          <p className="side-panel__empty">Abre una sesión de código para ver sus procesos.</p>
        ) : sorted.length === 0 ? (
          <p className="side-panel__empty">
            Esta sesión no tiene procesos en segundo plano.
            <br />
            Aparecen cuando el agente deja algo corriendo (un servidor de desarrollo, unos tests largos).
          </p>
        ) : (
          <ul className="job-list">
            {sorted.map((job) => (
              <JobRow key={job.id} job={job} now={now} onCancel={onCancel ? () => onCancel(job.id) : undefined} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
