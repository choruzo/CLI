/**
 * Jobs en segundo plano gestionados por el runtime (`exec` con `background:
 * true`). Tipos **sin imports**, como `agent/events.ts`: los lee la UI.
 *
 * Un job es un proceso local que Stratum lanza, vigila y cierra: nunca un
 * `comando &` suelto. Vive lo que vive la sesión — no se persiste ni se
 * reanuda — y pertenece al agente (o subagente) que lo creó.
 */

export const LIST_JOBS_TOOL = 'list_jobs';
export const GET_JOB_STATUS_TOOL = 'get_job_status';
export const GET_JOB_OUTPUT_TOOL = 'get_job_output';
export const CANCEL_JOB_TOOL = 'cancel_job';

/**
 * Las tools de inspección, en el orden en que se registran. No tienen sentido
 * sin `exec` (que es quien crea los jobs), así que su visibilidad sigue a la
 * suya en todos los filtros de toolset: ver `isToolVisibleForProfile`.
 */
export const JOB_TOOLS: readonly string[] = [
  LIST_JOBS_TOOL,
  GET_JOB_STATUS_TOOL,
  GET_JOB_OUTPUT_TOOL,
  CANCEL_JOB_TOOL,
];

export function isJobTool(name: string): boolean {
  return JOB_TOOLS.includes(name);
}

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Por qué terminó: `exit` (salió solo, con el código que sea), `timeout`
 * (superó su tiempo máximo), `cancelled` (lo pidió el agente o el usuario),
 * `scope-closed` (terminó el subagente dueño), `session-closed` (se cerró
 * Stratum) y `spawn-error` (no llegó a arrancar).
 */
export type JobEndReason =
  | 'exit'
  | 'timeout'
  | 'cancelled'
  | 'scope-closed'
  | 'session-closed'
  | 'spawn-error';

/** Scope del agente principal. El de un subagente es su id (`sub_…`). */
export const MAIN_JOB_SCOPE = 'main';

export interface JobOwner {
  sessionId?: string;
  /** Quién lo creó dentro de la sesión: `main` o el id del subagente. */
  scope: string;
}

export interface BackgroundJob {
  /** Secuencial dentro de la sesión: `"1"`, `"2"`… (se muestra como `#1`). */
  id: string;
  /** Comando, ya redactado: es lo que se enseña, se traza y se audita. */
  command: string;
  cwd: string;
  status: JobStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  endReason?: JobEndReason;
  owner: JobOwner;
  /** Bytes crudos que el proceso escribió (no lo que se conserva en memoria). */
  stdoutBytes: number;
  stderrBytes: number;
  /** Caracteres de salida disponibles para leer y los que el límite de buffer ya descartó. */
  outputChars: number;
  droppedChars: number;
  /** Algún agente leyó su salida con `get_job_output`. */
  outputRead: boolean;
}

export type JobEvent =
  | { type: 'created'; job: BackgroundJob }
  | { type: 'started'; job: BackgroundJob }
  | { type: 'ended'; job: BackgroundJob };

export type JobListener = (event: JobEvent) => void;

/** Un cambio de estado terminal pendiente de contar al agente dueño. */
export interface JobNotification {
  id: string;
  command: string;
  status: Exclude<JobStatus, 'running'>;
  exitCode: number | null;
  endReason: JobEndReason;
  durationMs: number;
  /** Queda salida que el agente no ha leído. */
  unreadChars: number;
}

/**
 * Un tramo de la salida de un job. `stdout` y `stderr` van separados: cada uno
 * en su orden, pero sin la información de cómo se intercalaron entre sí. Los
 * offsets son sobre el registro común de los dos (ver `jobs/output.ts`).
 */
export interface JobOutputSlice {
  stdout: string;
  stderr: string;
  /** Offset real desde el que se leyó (puede ser mayor que el pedido si el buffer descartó). */
  offset: number;
  nextOffset: number;
  /** Final de la salida disponible ahora mismo. */
  totalChars: number;
  /** Caracteres pedidos que el límite de buffer ya había descartado. */
  droppedChars: number;
  /** Hay más salida ya disponible a partir de `nextOffset`. */
  more: boolean;
}

const UNITS: Array<[number, string]> = [
  [3_600_000, 'h'],
  [60_000, 'm'],
];

/** `850ms`, `38.2s`, `4m12s`, `1h03m`. */
export function formatJobDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const [unitMs, unit] = ms >= UNITS[0]![0] ? UNITS[0]! : UNITS[1]!;
  const whole = Math.floor(ms / unitMs);
  const rest = Math.floor((ms - whole * unitMs) / (unit === 'h' ? 60_000 : 1000));
  return `${whole}${unit}${String(rest).padStart(2, '0')}${unit === 'h' ? 'm' : 's'}`;
}

/** Comando en una línea y recortado, para listados y avisos. */
export function shortJobCommand(command: string, max = 60): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `exit 1`, `timeout`, `cancelled`… el detalle que acompaña al estado. */
export function jobOutcomeLabel(job: {
  status: JobStatus;
  exitCode?: number | null;
  endReason?: JobEndReason;
}): string {
  if (job.status === 'running') return '';
  if (job.endReason === 'timeout') return 'timeout';
  if (job.endReason === 'spawn-error') return 'spawn error';
  if (job.status === 'cancelled') {
    return job.endReason === 'session-closed'
      ? 'session closed'
      : job.endReason === 'scope-closed'
        ? 'owner finished'
        : '';
  }
  return job.exitCode === null || job.exitCode === undefined
    ? 'exit unknown'
    : `exit ${job.exitCode}`;
}

/** `[background job #3 completed · exit 1 · 38.2s]` */
export function formatJobEndLine(job: {
  id: string;
  status: JobStatus;
  exitCode?: number | null;
  endReason?: JobEndReason;
  durationMs: number;
}): string {
  const parts = [`background job #${job.id} ${job.status}`];
  const outcome = jobOutcomeLabel(job);
  if (outcome) parts.push(outcome);
  parts.push(formatJobDuration(job.durationMs));
  return `[${parts.join(' · ')}]`;
}
