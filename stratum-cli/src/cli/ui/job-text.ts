import { formatJobDuration, type JobEndReason, type JobStatus } from '../../jobs/types.js';

/**
 * Textos en español de los jobs que solo pinta la TUI. Las variantes de
 * `jobs/types.ts` (`jobOutcomeLabel`, `formatJobEndLine`) siguen en inglés
 * porque también las leen el modelo (tools de jobs) y `stratum run`.
 */

const STATUS_LABEL: Record<JobStatus, string> = {
  running: 'en curso',
  completed: 'terminado',
  failed: 'fallido',
  cancelled: 'cancelado',
};

export function jobStatusLabel(status: JobStatus): string {
  return STATUS_LABEL[status];
}

/** `exit 1`, `timeout`… el detalle que acompaña al estado. Vacío si no hay nada que contar. */
export function jobOutcomeText(job: {
  status: JobStatus;
  exitCode?: number | null;
  endReason?: JobEndReason;
}): string {
  if (job.status === 'running') return '';
  if (job.endReason === 'timeout') return 'timeout';
  if (job.endReason === 'spawn-error') return 'no arrancó';
  if (job.status === 'cancelled') {
    return job.endReason === 'session-closed'
      ? 'sesión cerrada'
      : job.endReason === 'scope-closed'
        ? 'el dueño terminó'
        : '';
  }
  return job.exitCode === null || job.exitCode === undefined
    ? 'exit desconocido'
    : `exit ${job.exitCode}`;
}

/** `[job #3 terminado · exit 1 · 38.2s]` */
export function formatJobEndText(job: {
  id: string;
  status: JobStatus;
  exitCode?: number | null;
  endReason?: JobEndReason;
  durationMs: number;
}): string {
  const parts = [`job #${job.id} ${jobStatusLabel(job.status)}`];
  const outcome = jobOutcomeText(job);
  if (outcome) parts.push(outcome);
  parts.push(formatJobDuration(job.durationMs));
  return `[${parts.join(' · ')}]`;
}
