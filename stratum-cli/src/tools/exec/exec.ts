/**
 * Hito 16 — tool `exec`: una sola superficie de ejecución para todos los
 * targets (§2 y §2.5 de `CLI-DOC/Orientacion-Infraestructura.md`). Absorbe a
 * `bash` (target `local`) y a `ssh_exec` (target `ssh:<alias>`).
 *
 * El esquema es el de `ssh_exec` con `host` generalizado a `target`, porque
 * ninguno de sus parámetros era específico de SSH.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import type { StratumConfig } from '../../config/schema.js';
import {
  commandIsDestructive,
  commandPathVerdict,
  commandVeto,
  guardedConfirmLabel,
} from '../guards.js';
import { HostKeyError } from '../ssh/known-hosts.js';
import { redactText } from '../../security/redact-output.js';
import { getLogger } from '../../logging/index.js';
import { ExecConnectError, type ExecCapabilities, type ExecOutcome } from './backend.js';
import { getExecBackend } from './router.js';
import {
  escapeXmlAttr,
  escapeXmlText,
  formatTarget,
  parseTarget,
  resolveTarget,
  type ExecutionTarget,
} from './target.js';
import { getExecAuditLog } from './runtime.js';

const log = getLogger('tools').child('exec');

export const EXEC_TOOL = 'exec';

const schema = z.object({
  target: z
    .string()
    .optional()
    .describe('Where to run the command: "local" (default) or "ssh:<alias>".'),
  command: z.string().describe('Shell command to execute'),
  cwd: z
    .string()
    .optional()
    .describe(
      'Working directory. On local, relative paths resolve against the project directory. ' +
        'On ssh, the command runs as `cd <cwd> && <command>`.',
    ),
  pty: z
    .boolean()
    .optional()
    .describe(
      'Allocate a pseudo-terminal (ssh targets only). Needed for commands that require a TTY. ' +
        'stdout and stderr are merged and the exit code may be unreliable. Cannot be combined with stdin.',
    ),
  stdin: z
    .string()
    .optional()
    .describe(
      'Text sent to the command stdin, then EOF (e.g. the password for "sudo -S"). ' +
        'Without it, stdin is closed immediately.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Timeout in milliseconds. When it expires the process is killed.'),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum bytes of stdout+stderr kept in the result.'),
});

type ExecInput = z.infer<typeof schema>;

const CAPABILITY_LABEL: Record<keyof ExecCapabilities, string> = {
  pty: 'pty',
  stdin: 'stdin',
  cwd: 'cwd',
  maxBytes: 'maxBytes',
};

/** Targets de la config que soportan una capacidad, para el mensaje de rechazo. */
function targetsWith(capability: keyof ExecCapabilities, config: StratumConfig): string {
  const out: string[] = [];
  if (getExecBackend('local').capabilities[capability]) out.push('local');
  if (getExecBackend('ssh').capabilities[capability]) {
    const aliases = Object.keys(config.ssh?.hosts ?? {});
    if (aliases.length > 0) out.push(...aliases.map((a) => `ssh:${a}`));
    else out.push('ssh:<alias> (no hosts configured in .stratumrc.json)');
  }
  return out.length > 0 ? out.join(', ') : 'none';
}

function recoverableError(error: string): ToolResult {
  return { ok: false, error, recoverable: true };
}

function parseAndResolve(
  input: ExecInput,
  config: StratumConfig,
): { ok: true; target: ExecutionTarget } | { ok: false; error: string } {
  const parsed = parseTarget(input.target);
  if (!parsed.ok) return parsed;
  const resolved = resolveTarget(parsed.target, config);
  if (!resolved.ok) return resolved;
  return parsed;
}

/** Descripción generada con los targets de ESTA config (Hito 16, §2.5). */
export function describeExecTool(config: StratumConfig): string {
  const hosts = Object.entries(config.ssh?.hosts ?? {});
  const targetLines = [
    '- local — this machine' +
      (process.platform === 'win32' ? ' (PowerShell 7, pwsh.exe)' : ' (/bin/sh)') +
      '. No pty. When output exceeds maxBytes the rest is discarded but the command runs to completion.',
    ...hosts.map(([alias, host]) => {
      const flags: string[] = [];
      if (host.jumpHost) flags.push(`via ${host.jumpHost}`);
      if (host.confirmAll) flags.push('confirmAll: every command asks the user');
      const suffix = flags.length > 0 ? ` (${flags.join('; ')})` : '';
      return `- ssh:${alias}${suffix}. Supports pty. When output exceeds maxBytes the remote process is killed.`;
    }),
  ];

  return [
    'Execute a shell command on a target and return its exit code, stdout and stderr.',
    '',
    'Targets:',
    ...targetLines,
    '',
    'A command that runs but exits non-zero, times out or is truncated is reported as an error that ' +
      'includes its output; that is information about the command, not a broken tool.',
    'Commands matching destructive patterns (rm, dd, mkfs, DROP, ...) require user confirmation. ' +
      'A few catastrophic commands (rm -rf on / or ~, git clean -fd, mkfs, chmod -R 777, dd onto a ' +
      'block device) are rejected outright on every target and no approval can enable them.',
    'Avoid commands that never terminate (tail -f, watch, top): they are killed at the timeout.',
    ...(hosts.length > 0
      ? [
          'On ssh targets, sudo needs NOPASSWD on the host or "sudo -S" with the password in stdin; ' +
            'refer to hosts only by their alias, never by IP.',
        ]
      : []),
  ].join('\n');
}

function formatExecResult(
  label: string,
  outcome: ExecOutcome,
  durationMs: number,
  maxBytes: number,
  timeoutMs: number,
): string {
  const dirAttr =
    outcome.cwd !== undefined
      ? ` cwd="${escapeXmlAttr(outcome.cwd)}"`
      : outcome.requestedCwd !== undefined
        ? ` requestedCwd="${escapeXmlAttr(outcome.requestedCwd)}"`
        : '';
  const head =
    `<exec_result target="${escapeXmlAttr(label)}" status="${outcome.status}" ` +
    `exitCode="${outcome.exitCode ?? 'unknown'}" duration="${durationMs}ms"${dirAttr} ` +
    `maxBytes="${maxBytes}">`;

  const notices: string[] = [];
  if (outcome.status === 'cancelled') {
    notices.push('[COMMAND CANCELLED by the user. The process was killed.]');
  } else if (outcome.status === 'timeout') {
    notices.push(
      `[COMMAND KILLED after ${timeoutMs}ms timeout. Avoid non-terminating commands, or raise the timeout.]`,
    );
  }
  if (outcome.bytesDiscarded && outcome.bytesDiscarded > 0) {
    notices.push(
      outcome.killedOnMaxBytes
        ? `[OUTPUT TRUNCATED at ${maxBytes} bytes; the remote process was killed. ` +
            'Narrow the output with head/grep/tail, or raise maxBytes.]'
        : `[OUTPUT TRUNCATED at ${maxBytes} bytes; ${outcome.bytesDiscarded} more bytes were discarded ` +
            'while the command ran to completion. Narrow the output with head/grep/tail, or raise maxBytes.]',
    );
  }
  const notice = notices.length > 0 ? `\n${notices.join('\n')}` : '';

  const lines = [head, `  <stdout>${escapeXmlText(outcome.stdout)}${notice}</stdout>`];
  if (outcome.stderr) lines.push(`  <stderr>${escapeXmlText(outcome.stderr)}</stderr>`);
  lines.push('</exec_result>');
  return lines.join('\n');
}

export function createExecTool(config: StratumConfig): ToolDefinition {
  return {
    name: EXEC_TOOL,
    description: describeExecTool(config),
    schema,
    destructive: false,
    // Red de seguridad del dispatcher: el timeout real lo gestiona el backend.
    timeout: 600000,
    structuredCancellation: true,

    /**
     * Punto único sobre `(command, target)`: sintaxis y existencia del target,
     * capacidades del backend, y el veto de las guardas. Todo ANTES de la fase
     * de confirmación — al usuario no se le pregunta por algo imposible.
     */
    preflight(params: unknown, ctx: ToolContext): ToolResult | null {
      const parsed = schema.safeParse(params);
      if (!parsed.success) return null;
      const input = parsed.data;

      const resolved = parseAndResolve(input, ctx.config);
      if (!resolved.ok) return recoverableError(resolved.error);
      const label = formatTarget(resolved.target);
      const caps = getExecBackend(resolved.target.kind).capabilities;

      const requested: (keyof ExecCapabilities)[] = [];
      if (input.pty === true) requested.push('pty');
      if (input.stdin !== undefined) requested.push('stdin');
      if (input.cwd !== undefined) requested.push('cwd');
      if (input.maxBytes !== undefined) requested.push('maxBytes');
      for (const capability of requested) {
        if (!caps[capability]) {
          return recoverableError(
            `${CAPABILITY_LABEL[capability]} is not supported on target "${label}". ` +
              `Targets that support it: ${targetsWith(capability, ctx.config)}.`,
          );
        }
      }
      if (input.pty === true && input.stdin !== undefined) {
        return recoverableError(
          'pty and stdin cannot be combined: with a pty the input would be echoed and mixed into the output. ' +
            'Use stdin without pty (e.g. "sudo -S"), or pty without stdin.',
        );
      }

      const veto = commandVeto(input.command, ctx.config.tools.guardedCommands, label);
      return veto ? { ok: false, error: `[${label}] ${veto}`, recoverable: false } : null;
    },

    isDestructive(params: unknown, ctx: ToolContext): boolean {
      const parsed = schema.safeParse(params);
      if (!parsed.success) return false;
      const { command } = parsed.data;
      const target = parseTarget(parsed.data.target);
      if (target.ok && target.target.kind === 'ssh') {
        if (ctx.config.ssh?.hosts[target.target.alias]?.confirmAll) return true;
      }
      if (guardedConfirmLabel(command, ctx.config.tools.guardedCommands)) return true;
      if (
        commandPathVerdict(command, ctx.config.tools.sensitivePathAllowlist)?.tier === 'confirm'
      ) {
        return true;
      }
      return commandIsDestructive(command, ctx.config.tools.destructivePatterns);
    },

    /** Local serializa (cwd, índice de git); hosts remotos van en paralelo. */
    isSerialized(params: unknown): boolean {
      const parsed = schema.safeParse(params);
      if (!parsed.success) return true;
      const target = parseTarget(parsed.data.target);
      return !target.ok || target.target.kind === 'local';
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const input = schema.parse(params);
      const resolved = parseAndResolve(input, ctx.config);
      if (!resolved.ok) return recoverableError(resolved.error);

      const target = resolved.target;
      const label = formatTarget(target);
      const backend = getExecBackend(target.kind);
      const audit = getExecAuditLog(ctx.config);

      let defaults: { timeoutMs: number; maxBytes: number };
      try {
        defaults = backend.defaults(target, ctx.config);
      } catch (err) {
        return recoverableError((err as Error).message);
      }
      const timeoutMs = input.timeout ?? defaults.timeoutMs;
      const maxBytes = input.maxBytes ?? defaults.maxBytes;

      const started = Date.now();
      const base = {
        timestamp: new Date(started).toISOString(),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        target: label,
        ...(target.kind === 'ssh' ? { host: target.alias } : {}),
        command: redactText(input.command, ctx.config),
      };

      let outcome: ExecOutcome;
      try {
        outcome = await backend.run(
          target,
          {
            command: input.command,
            cwd: input.cwd,
            pty: input.pty,
            stdin: input.stdin,
            timeoutMs,
            maxBytes,
            signal: ctx.signal,
          },
          ctx,
        );
      } catch (err) {
        const connect = err instanceof ExecConnectError || err instanceof HostKeyError;
        audit.write({
          ...base,
          ...(input.cwd !== undefined ? { requestedCwd: input.cwd } : {}),
          status: connect ? 'connect_error' : 'spawn_error',
          exitCode: null,
          durationMs: Date.now() - started,
          truncated: false,
        });
        const recoverable = err instanceof HostKeyError ? err.recoverable : true;
        return { ok: false, error: `[${label}] ${(err as Error).message}`, recoverable };
      }

      const durationMs = Date.now() - started;
      const truncated = (outcome.bytesDiscarded ?? 0) > 0;
      log.debug('exec done', { target: label, status: outcome.status, durationMs, truncated });
      audit.write({
        ...base,
        ...(outcome.cwd !== undefined ? { cwd: outcome.cwd } : {}),
        ...(outcome.requestedCwd !== undefined ? { requestedCwd: outcome.requestedCwd } : {}),
        status: outcome.status,
        exitCode: outcome.exitCode,
        durationMs,
        truncated,
      });

      const xml = formatExecResult(label, outcome, durationMs, maxBytes, timeoutMs);
      if (outcome.status === 'exited' && outcome.exitCode === 0) return { ok: true, output: xml };
      // §12.3: el comando falló, así que es un tool_error recuperable; pero se
      // EJECUTÓ, así que no consume reintento ni desaparece del write-log.
      return {
        ok: false,
        error: xml,
        recoverable: true,
        countsAsFailure: false,
        executed: true,
      };
    },
  };
}
