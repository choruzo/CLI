import { z } from 'zod';
import type { ClientChannel } from 'ssh2';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { commandIsDestructive, commandVeto } from '../shell/bash.js';
import { guardedConfirmLabel } from '../guards.js';
import { getSshPool, getAuditLog, confirmFnFrom } from './runtime.js';
import { HostKeyError } from './known-hosts.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('ssh');

const DEFAULT_MAX_BYTES = 256 * 1024;

const schema = z.object({
  host: z.string().describe('Alias del host en el inventario SSH'),
  command: z.string().describe('Comando a ejecutar en el host remoto'),
  cwd: z.string().optional().describe('Directorio de trabajo remoto'),
  pty: z
    .boolean()
    .optional()
    .describe(
      'Allocate pseudo-terminal. Necesario para sudo con password, apt/dnf interactivo, ' +
        'cualquier comando que requiera TTY. Default: false. ' +
        'Con PTY activo, stdout y stderr se mezclan y el exit code puede no ser fiable.',
    ),
  stdin: z
    .string()
    .optional()
    .describe(
      'Texto a enviar al stdin del comando (sin PTY). Útil para "sudo -S", ' +
        'respuestas a prompts predecibles. No usar para interacción real — usar pty: true.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Timeout del comando en ms (default: 30000). Al expirar, el proceso remoto recibe SIGKILL.',
    ),
  maxBytes: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Límite de stdout+stderr en bytes (default: 262144 = 256 KB). El output se trunca si supera este límite.',
    ),
});

type ExecParams = z.infer<typeof schema>;

/**
 * Elimina secuencias de escape ANSI (CSI) y retornos de carro sueltos, que
 * ensucian el output cuando se pide `pty: true` — el servidor cree estar
 * hablando con un terminal real. Se construye desde una cadena con escapes
 * Unicode para no meter caracteres de control literales en el fuente.
 */
const ANSI_RE = new RegExp('\\u001B[[(][0-9;?]*[ -/]*[@-~]|\\r', 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Quoting POSIX de una ruta para el prefijo `cd <cwd> && `. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * `ssh_exec` (§12.14) — ejecución remota sin depender del binario `ssh`.
 *
 * Sobre la confirmación destructiva: §12.14 escribe `destructive: true` pero
 * describe "confirmar **si** detecta patrones peligrosos". En este registry,
 * `destructive: true` significa confirmar SIEMPRE, así que la traducción fiel
 * es `isDestructive()`: confirma cuando el host lleva `confirmAll` (la defensa
 * real en producción) o cuando el comando encaja con `tools.destructivePatterns`
 * (una red blanda para errores del LLM, trivialmente evasible por diseño).
 */
export const sshExecTool: ToolDefinition = {
  name: 'ssh_exec',
  description:
    'Ejecuta un comando en un host remoto del inventario SSH.\n' +
    'Usa el alias definido en .stratumrc.json → ssh.hosts.<alias>.\n' +
    'AVISO: la detección de patrones destructivos es orientativa, no un control de seguridad real.\n' +
    'Los comandos catastróficos (rm -rf sobre / o ~, git clean -fd, mkfs, chmod -R 777) se rechazan\n' +
    'sin posibilidad de aprobación, igual que en local.\n' +
    'Evita comandos que no terminan (tail -f, watch): se matan al expirar el timeout.\n' +
    'sudo requiere NOPASSWD en el host, o "sudo -S" con la contraseña en stdin; ' +
    'con pty: true stdout y stderr se mezclan y el exit code puede no ser fiable.',
  schema,
  destructive: false,
  // Ejecución paralela permitida: hosts distintos no se estorban, y el pool
  // comparte un único socket por alias vía su mapa `inflight`.
  serialized: false,
  // El timeout real lo gestiona la tool (parámetro o commandTimeout del host).
  // El del dispatcher queda alto como red de seguridad, igual que en `bash`.
  timeout: 600000,

  // Hito 11: las capas 1 y 2 de las guardas valen igual para un host remoto.
  // Un `rm -rf /` no es menos catastrófico por estar al otro lado de un socket.
  preflight(params: unknown, ctx: ToolContext): ToolResult | null {
    const parsed = schema.safeParse(params);
    if (!parsed.success) return null;
    const veto = commandVeto(parsed.data.command, ctx.config.tools.guardedCommands);
    return veto ? { ok: false, error: `[${parsed.data.host}] ${veto}`, recoverable: false } : null;
  },

  isDestructive(params: unknown, ctx: ToolContext): boolean {
    const parsed = schema.safeParse(params);
    if (!parsed.success) return false;
    const host = ctx.config.ssh?.hosts[parsed.data.host];
    if (host?.confirmAll) return true;
    if (guardedConfirmLabel(parsed.data.command, ctx.config.tools.guardedCommands)) return true;
    return commandIsDestructive(parsed.data.command, ctx.config.tools.destructivePatterns);
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = schema.parse(params);
    const started = Date.now();
    const pool = getSshPool(ctx.config);

    let host;
    try {
      host = pool.host(input.host);
    } catch (err) {
      return { ok: false, error: (err as Error).message, recoverable: true };
    }

    const timeoutMs = input.timeout ?? host.commandTimeout;
    const maxBytes = input.maxBytes ?? host.maxBytes ?? DEFAULT_MAX_BYTES;

    let outcome: ExecOutcome;
    try {
      const client = await pool.getConnection(input.host, confirmFnFrom(ctx));
      const command = input.cwd ? `cd ${shellQuote(input.cwd)} && ${input.command}` : input.command;
      outcome = await runCommand(client, command, input, { timeoutMs, maxBytes, ctx });
    } catch (err) {
      const durationMs = Date.now() - started;
      getAuditLog(ctx.config).write({
        timestamp: new Date().toISOString(),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        host: input.host,
        command: input.command,
        exitCode: null,
        durationMs,
        truncated: false,
      });
      // Un mismatch de host key no es recuperable: el agente no debe reintentar.
      const recoverable = err instanceof HostKeyError ? err.recoverable : true;
      return { ok: false, error: (err as Error).message, recoverable };
    }

    const durationMs = Date.now() - started;
    log.debug('ssh exec done', {
      alias: input.host,
      exitCode: outcome.exitCode,
      durationMs,
      truncated: outcome.truncated,
    });

    getAuditLog(ctx.config).write({
      timestamp: new Date().toISOString(),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      host: input.host,
      command: input.command,
      exitCode: outcome.exitCode,
      durationMs,
      truncated: outcome.truncated,
    });

    return {
      ok: true,
      output: formatResult(input.host, outcome, durationMs, maxBytes, timeoutMs),
    };
  },
};

function runCommand(
  client: import('ssh2').Client,
  command: string,
  input: ExecParams,
  opts: { timeoutMs: number; maxBytes: number; ctx: ToolContext },
): Promise<ExecOutcome> {
  const { timeoutMs, maxBytes, ctx } = opts;

  return new Promise<ExecOutcome>((resolve, reject) => {
    client.exec(command, { pty: input.pty === true }, (err, stream: ClientChannel) => {
      if (err) {
        reject(new Error(`No se pudo ejecutar el comando en "${input.host}": ${err.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let totalBytes = 0;
      let truncated = false;
      let timedOut = false;
      let exitCode: number | null = null;
      let settled = false;

      /** Mata el proceso remoto y cierra el stream. */
      const kill = (): void => {
        try {
          stream.signal('KILL');
        } catch {
          /* el canal puede estar ya cerrado */
        }
        stream.close();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        truncated = true;
        kill();
      }, timeoutMs);

      const onAbort = (): void => {
        kill();
        finish();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({
          stdout: input.pty ? stripAnsi(stdout) : stdout,
          stderr: input.pty ? stripAnsi(stderr) : stderr,
          exitCode,
          truncated,
          timedOut,
        });
      };

      // Límite de salida (§12.14): al superar maxBytes se mata el proceso
      // remoto en vez de seguir volcando megabytes al contexto del modelo.
      const accumulate = (chunk: Buffer, isStderr: boolean): void => {
        if (truncated) return;
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          truncated = true;
          kill();
          return;
        }
        if (isStderr) stderr += chunk.toString();
        else stdout += chunk.toString();
      };

      stream.on('data', (chunk: Buffer) => accumulate(chunk, false));
      stream.stderr.on('data', (chunk: Buffer) => accumulate(chunk, true));
      stream.on('exit', (code: number | null) => {
        exitCode = code;
      });
      stream.on('close', finish);
      stream.on('error', (streamErr: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        reject(streamErr);
      });

      if (input.stdin !== undefined && input.pty !== true) {
        stream.end(input.stdin);
      }
    });
  });
}

function formatResult(
  alias: string,
  outcome: ExecOutcome,
  durationMs: number,
  maxBytes: number,
  timeoutMs: number,
): string {
  const exitAttr = outcome.truncated ? 'truncated' : String(outcome.exitCode ?? 'unknown');
  const lines = [
    `<ssh_result host="${alias}" exitCode="${exitAttr}" duration="${durationMs}ms" ` +
      `truncated="${outcome.truncated}" maxBytes="${maxBytes}">`,
  ];

  const notice = outcome.timedOut
    ? `\n[COMMAND KILLED after ${timeoutMs}ms timeout. The remote process received SIGKILL. ` +
      'Avoid non-terminating commands, or raise the timeout in the tool call.]'
    : outcome.truncated
      ? `\n[OUTPUT TRUNCATED at ${maxBytes} bytes. Use head/grep/tail to limit output, ` +
        'or increase maxBytes in the tool call.]'
      : '';

  lines.push(`  <stdout>${escapeXml(outcome.stdout)}${notice}</stdout>`);
  if (outcome.stderr) lines.push(`  <stderr>${escapeXml(outcome.stderr)}</stderr>`);
  lines.push('</ssh_result>');
  return lines.join('\n');
}
