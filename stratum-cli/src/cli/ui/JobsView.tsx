import React from 'react';
import { Box, Text } from 'ink';
import type { BackgroundJob } from '../../jobs/types.js';
import { formatJobDuration, jobOutcomeLabel, shortJobCommand } from '../../jobs/types.js';
import { theme } from './theme.js';

/** Un job terminado sigue a la vista este tiempo; después solo queda en `/jobs`. */
export const JOB_LINGER_MS = 60_000;

const STATUS_COLOR: Record<BackgroundJob['status'], string> = {
  running: theme.accent,
  completed: theme.success,
  failed: theme.error,
  cancelled: theme.warning,
};

/** `running  18s` mientras corre; `failed  exit 101` al terminar. */
export function jobStatusDetail(job: BackgroundJob, now: number): string {
  if (job.status === 'running') return formatJobDuration(now - job.startedAt);
  return jobOutcomeLabel(job) || formatJobDuration((job.endedAt ?? now) - job.startedAt);
}

/** `#3  npm test        running   18s` — una fila por job, columnas alineadas. */
export function formatJobRows(
  jobs: readonly BackgroundJob[],
  now: number,
  commandWidth = 32,
): string[] {
  const idWidth = Math.max(...jobs.map((j) => j.id.length), 1) + 1;
  return jobs.map((job) => {
    const id = `#${job.id}`.padEnd(idWidth + 1);
    const command = shortJobCommand(job.command, commandWidth).padEnd(commandWidth);
    return `${id} ${command}  ${job.status.padEnd(9)} ${jobStatusDetail(job, now)}`;
  });
}

/** Los jobs que merece la pena tener delante: los vivos y los recién terminados. */
export function visibleJobs(jobs: readonly BackgroundJob[], now: number): BackgroundJob[] {
  return jobs.filter(
    (job) => job.status === 'running' || now - (job.endedAt ?? now) < JOB_LINGER_MS,
  );
}

interface Props {
  jobs: BackgroundJob[];
  now: number;
  maxRows?: number;
}

/**
 * Panel de jobs en segundo plano, anclado bajo la barra de estado como
 * <TodoView>. Solo aparece si hay algo que mirar: jobs corriendo o terminados
 * hace menos de un minuto. El listado completo está en `/jobs`.
 */
export function JobsView({ jobs, now, maxRows = 4 }: Props) {
  const shown = visibleJobs(jobs, now);
  if (shown.length === 0) return null;
  // Los que corren primero; si no caben todos, se quedan los más recientes.
  const ordered = [
    ...shown.filter((j) => j.status === 'running'),
    ...shown.filter((j) => j.status !== 'running'),
  ];
  const rows = ordered.slice(0, maxRows);
  const lines = formatJobRows(rows, now);
  const running = shown.filter((j) => j.status === 'running').length;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
      <Text color={theme.textFaint}>
        Jobs · {running} en curso
        {ordered.length > rows.length ? ` · ${ordered.length} en total` : ''}
      </Text>
      {rows.map((job, i) => (
        <Text key={job.id} color={STATUS_COLOR[job.status]}>
          {lines[i]}
        </Text>
      ))}
    </Box>
  );
}
