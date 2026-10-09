/**
 * Tools de inspección de jobs en segundo plano: `list_jobs`, `get_job_status`,
 * `get_job_output` y `cancel_job`. Los jobs los crea `exec` con `background:
 * true`; aquí solo se miran y se paran.
 *
 * Son tools normales (pasan por el `ToolDispatcher`: redacción, truncado,
 * traza), y todas comprueban el scope: un agente solo ve y toca los jobs a los
 * que `JobManager.canAccess` le da acceso. Un job ajeno responde igual que uno
 * que no existe, para no revelar qué hay en otro scope.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../agent/types.js';
import type { StratumConfig } from '../config/schema.js';
import { JobNotFoundError, normalizeJobId, type JobAccess } from '../jobs/manager.js';
import {
  CANCEL_JOB_TOOL,
  GET_JOB_OUTPUT_TOOL,
  GET_JOB_STATUS_TOOL,
  LIST_JOBS_TOOL,
  MAIN_JOB_SCOPE,
  formatJobDuration,
  jobOutcomeLabel,
  shortJobCommand,
  type BackgroundJob,
  type JobNotification,
} from '../jobs/types.js';
import { escapeXmlAttr, escapeXmlText } from './exec/target.js';

const jobId = z
  .union([z.string(), z.number()])
  .describe('Job id as returned by exec with background:true (e.g. "3").');

const waitMs = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe('Wait up to this many milliseconds instead of returning at once.');

function unavailable(): ToolResult {
  return {
    ok: false,
    error: 'Background jobs are not available in this session.',
    recoverable: false,
  };
}

function notFound(id: string | number): ToolResult {
  return {
    ok: false,
    error:
      `No background job with id "${normalizeJobId(id)}" that you can access. ` +
      'Use list_jobs to see your jobs.',
    recoverable: true,
    countsAsFailure: false,
  };
}

function scopeOf(ctx: ToolContext): string {
  return ctx.jobScope ?? MAIN_JOB_SCOPE;
}

/** El job, si existe y el scope puede hacer `action`; si no, `null`. */
function accessible(
  ctx: ToolContext,
  id: string | number,
  action: JobAccess,
): BackgroundJob | null {
  const job = ctx.jobs?.get(String(id));
  if (!job || !ctx.jobs!.canAccess(scopeOf(ctx), job, action)) return null;
  return job;
}

function durationOf(job: BackgroundJob, now = Date.now()): number {
  return (job.endedAt ?? now) - job.startedAt;
}

/** Atributos comunes de un job en las respuestas XML. */
export function jobAttrs(job: BackgroundJob): string {
  const attrs = [
    `id="${escapeXmlAttr(job.id)}"`,
    `status="${job.status}"`,
    ...(job.status !== 'running' ? [`exitCode="${job.exitCode ?? 'unknown'}"`] : []),
    ...(job.endReason && job.endReason !== 'exit' ? [`reason="${job.endReason}"`] : []),
    `duration="${formatJobDuration(durationOf(job))}"`,
    ...(job.pid !== undefined ? [`pid="${job.pid}"`] : []),
  ];
  return attrs.join(' ');
}

function jobLine(job: BackgroundJob, scope: string): string {
  const owner = job.owner.scope === scope ? '' : ` owner="${escapeXmlAttr(job.owner.scope)}"`;
  return (
    `  <job ${jobAttrs(job)}${owner} outputChars="${job.outputChars}" ` +
    `outputRead="${job.outputRead}">${escapeXmlText(shortJobCommand(job.command, 200))}</job>`
  );
}

/**
 * Texto que el loop inyecta en el contexto del modelo cuando jobs suyos
 * cambiaron de estado (ver `ReactLoop`). Una línea por job, con lo justo para
 * decidir si hace falta leer su salida.
 */
export function formatJobNotifications(items: readonly JobNotification[]): string {
  const lines = items.map((n) => {
    const outcome = jobOutcomeLabel(n);
    const detail = [
      n.status === 'completed'
        ? `completed with exit code ${n.exitCode ?? 'unknown'}`
        : n.status === 'failed'
          ? `failed${outcome ? ` (${outcome})` : ''}`
          : `was cancelled${outcome ? ` (${outcome})` : ''}`,
      `after ${formatJobDuration(n.durationMs)}`,
    ].join(' ');
    const unread =
      n.unreadChars > 0
        ? ` ${n.unreadChars} chars of output unread: get_job_output(jobId="${n.id}").`
        : '';
    return `Background job #${n.id} (${shortJobCommand(n.command, 80)}) ${detail}.${unread}`;
  });
  return `<background_jobs>\n${lines.join('\n')}\n</background_jobs>`;
}

export function createJobTools(config: StratumConfig): ToolDefinition[] {
  const limits = config.tools.jobs;

  const listJobs: ToolDefinition = {
    name: LIST_JOBS_TOOL,
    description:
      'List the background jobs of this session (started with exec background:true): id, status, ' +
      'exit code, duration and output size. Finished jobs stay listed.',
    schema: z.object({
      status: z
        .enum(['running', 'completed', 'failed', 'cancelled'])
        .optional()
        .describe('Only jobs in this state.'),
    }),
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.jobs) return unavailable();
      const input = params as { status?: BackgroundJob['status'] };
      const scope = scopeOf(ctx);
      const jobs = ctx.jobs
        .list(scope)
        .filter((job) => input.status === undefined || job.status === input.status);
      // Verlo en la lista ya es saber cómo terminó: no hace falta avisar después.
      for (const job of jobs) ctx.jobs.markSeen(job.id, scope);
      if (jobs.length === 0) return { ok: true, output: '<jobs count="0"></jobs>' };
      return {
        ok: true,
        output: [
          `<jobs count="${jobs.length}">`,
          ...jobs.map((j) => jobLine(j, scope)),
          '</jobs>',
        ].join('\n'),
      };
    },
  };

  const getJobStatus: ToolDefinition = {
    name: GET_JOB_STATUS_TOOL,
    description:
      'Status, exit code and duration of a background job. With waitMs it waits (up to that ' +
      'long) for the job to finish: use that instead of polling.',
    schema: z.object({ jobId, waitMs }),
    timeout: limits.maxWaitMs + 10_000,
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.jobs) return unavailable();
      const input = params as { jobId: string | number; waitMs?: number };
      if (!accessible(ctx, input.jobId, 'read')) return notFound(input.jobId);
      const id = normalizeJobId(input.jobId);
      await ctx.jobs.waitFor(id, {
        until: 'end',
        timeoutMs: Math.min(input.waitMs ?? 0, limits.maxWaitMs),
        signal: ctx.signal,
      });
      const job = ctx.jobs.get(id);
      if (!job) return notFound(input.jobId);
      const scope = scopeOf(ctx);
      const unread = Math.max(0, job.outputChars - ctx.jobs.cursor(id, scope));
      ctx.jobs.markSeen(id, scope);
      return {
        ok: true,
        output:
          `<job ${jobAttrs(job)} outputChars="${job.outputChars}" unreadChars="${unread}" ` +
          `cwd="${escapeXmlAttr(job.cwd)}">${escapeXmlText(shortJobCommand(job.command, 200))}</job>`,
      };
    },
  };

  const getJobOutput: ToolDefinition = {
    name: GET_JOB_OUTPUT_TOOL,
    description:
      'Read the output (stdout and stderr) of a background job in pieces. Without offset it ' +
      'continues where your last read ended, so each call returns only what is new. tail:true ' +
      `reads the end instead (test summaries, errors). maxChars defaults to ${limits.readChars}. ` +
      'waitMs waits for new output or for the job to end. The result gives nextOffset and ' +
      'whether the job has finished.',
    schema: z.object({
      jobId,
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Character offset to read from. Omit to continue from your last read.'),
      maxChars: z.number().int().positive().optional().describe('Maximum characters to return.'),
      tail: z
        .boolean()
        .optional()
        .describe('Read the last maxChars of the output. Cannot be combined with offset.'),
      waitMs,
    }),
    timeout: limits.maxWaitMs + 10_000,
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.jobs) return unavailable();
      const input = params as {
        jobId: string | number;
        offset?: number;
        maxChars?: number;
        tail?: boolean;
        waitMs?: number;
      };
      if (input.tail && input.offset !== undefined) {
        return {
          ok: false,
          error: 'tail and offset cannot be combined: use one or the other.',
          recoverable: true,
          countsAsFailure: false,
        };
      }
      if (!accessible(ctx, input.jobId, 'read')) return notFound(input.jobId);
      const id = normalizeJobId(input.jobId);
      const scope = scopeOf(ctx);
      const maxChars = Math.min(input.maxChars ?? limits.readChars, limits.maxReadChars);

      if (!input.tail) {
        await ctx.jobs.waitFor(id, {
          until: 'output',
          offset: input.offset ?? ctx.jobs.cursor(id, scope),
          timeoutMs: Math.min(input.waitMs ?? 0, limits.maxWaitMs),
          signal: ctx.signal,
        });
      }

      let read;
      try {
        read = ctx.jobs.readOutput(id, scope, { offset: input.offset, maxChars, tail: input.tail });
      } catch (err) {
        if (err instanceof JobNotFoundError) return notFound(input.jobId);
        throw err;
      }
      const { job, slice } = read;
      const finished = job.status !== 'running';

      const notes: string[] = [];
      if (slice.droppedChars > 0) {
        notes.push(
          `[${slice.droppedChars} earlier chars are gone: the job's output buffer keeps only ` +
            `the most recent ${limits.maxOutputChars} chars.]`,
        );
      }
      if (slice.more) {
        notes.push(
          `[More output is available: call get_job_output again (offset=${slice.nextOffset}) ` +
            'or use tail:true for the end.]',
        );
      } else if (!finished) {
        notes.push(
          '[No more output yet; the job is still running. You will be told when it ends.]',
        );
      }

      const lines = [
        `<job_output ${jobAttrs(job)} finished="${finished}" offset="${slice.offset}" ` +
          `nextOffset="${slice.nextOffset}" totalChars="${slice.totalChars}">`,
        `  <stdout>${escapeXmlText(slice.stdout)}</stdout>`,
      ];
      if (slice.stderr) lines.push(`  <stderr>${escapeXmlText(slice.stderr)}</stderr>`);
      lines.push(...notes, '</job_output>');
      return { ok: true, output: lines.join('\n') };
    },
  };

  const cancelJob: ToolDefinition = {
    name: CANCEL_JOB_TOOL,
    description:
      'Stop a running background job, terminating its whole process tree. The output captured ' +
      'so far stays readable.',
    schema: z.object({ jobId }),
    timeout: 30_000,
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.jobs) return unavailable();
      const input = params as { jobId: string | number };
      const before = accessible(ctx, input.jobId, 'cancel');
      if (!before) return notFound(input.jobId);
      const scope = scopeOf(ctx);
      const job = await ctx.jobs.cancel(before.id, scope);
      ctx.jobs.markSeen(job.id, scope);
      const note =
        before.status === 'running'
          ? `[background job #${job.id} cancelled: its process tree was terminated.]`
          : `[background job #${job.id} had already finished (${before.status}); nothing to cancel.]`;
      return { ok: true, output: `<job ${jobAttrs(job)}>${note}</job>` };
    },
  };

  return [listJobs, getJobStatus, getJobOutput, cancelJob];
}
