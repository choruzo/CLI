/**
 * Hito 16 — backend `ssh:<alias>` de `exec` (sustituye a la antigua tool
 * `ssh_exec`, §12.14). El protocolo corre dentro del proceso con `ssh2`: el
 * binario `ssh` del sistema nunca se invoca. Pool, verificación de host key y
 * teardown siguen en `tools/ssh/`.
 *
 * Al superar `maxBytes`, en timeout o al cancelar: `stream.signal('KILL')` al
 * proceso remoto (§12.14), en vez de seguir volcando megabytes.
 *
 * Cancelación estructurada en las tres fases: conexión, apertura del canal y
 * ejecución. SSH no permite retirar una petición `exec` ya enviada, así que si
 * el canal llega después de haber resuelto `cancelled`/`timeout` se mata en el
 * acto: es lo máximo que el protocolo permite.
 */
import type { Client, ClientChannel } from 'ssh2';
import type { ToolContext } from '../../../agent/types.js';
import type { StratumConfig } from '../../../config/schema.js';
import { getSshPool, confirmFnFrom } from '../../ssh/runtime.js';
import { HostKeyError } from '../../ssh/known-hosts.js';
import {
  ExecConnectError,
  ExecSpawnError,
  KILL_GRACE_MS,
  SETTLE_GRACE_MS,
  resolveStatus,
  type ExecOutcome,
  type ExecRequest,
  type IExecBackend,
} from '../backend.js';
import type { ExecutionTarget } from '../target.js';

const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Elimina secuencias de escape ANSI (CSI) y retornos de carro sueltos, que
 * ensucian la salida con `pty: true`. Se construye desde una cadena con escapes
 * Unicode para no meter caracteres de control literales en el fuente.
 */
const ANSI_RE = new RegExp('\\u001B[[(][0-9;?]*[ -/]*[@-~]|\\r', 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Quoting POSIX de una ruta para el prefijo `cd <cwd> && `. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function aliasOf(target: ExecutionTarget): string {
  if (target.kind !== 'ssh') throw new Error(`ssh backend received target "${target.kind}"`);
  return target.alias;
}

function cancelledOutcome(req: ExecRequest): ExecOutcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    status: 'cancelled',
    ...(req.cwd ? { requestedCwd: req.cwd } : {}),
    killedOnMaxBytes: true,
  };
}

export const sshBackend: IExecBackend = {
  kind: 'ssh',
  capabilities: { pty: true, stdin: true, cwd: true, maxBytes: true },

  defaults(target: ExecutionTarget, config: StratumConfig) {
    const host = getSshPool(config).host(aliasOf(target));
    return { timeoutMs: host.commandTimeout, maxBytes: host.maxBytes ?? DEFAULT_MAX_BYTES };
  },

  async run(target: ExecutionTarget, req: ExecRequest, ctx: ToolContext): Promise<ExecOutcome> {
    const alias = aliasOf(target);
    const pool = getSshPool(ctx.config);
    if (req.signal.aborted) return cancelledOutcome(req);

    // Fase 1 — conexión (y un gate TOFU pendiente): compite con el abort. Si la
    // conexión termina después, queda en el pool para la siguiente llamada.
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<'aborted'>((resolveAbort) => {
      onAbort = () => resolveAbort('aborted');
      req.signal.addEventListener('abort', onAbort, { once: true });
    });

    let client: Client | 'aborted';
    try {
      client = await Promise.race([pool.getConnection(alias, confirmFnFrom(ctx)), aborted]);
    } catch (err) {
      // Un mismatch de host key conserva su tipo: no es recuperable (§12.14).
      if (err instanceof HostKeyError) throw err;
      throw new ExecConnectError((err as Error).message);
    } finally {
      if (onAbort) req.signal.removeEventListener('abort', onAbort);
    }
    if (client === 'aborted' || req.signal.aborted) return cancelledOutcome(req);

    const command = req.cwd ? `cd ${shellQuote(req.cwd)} && ${req.command}` : req.command;
    return runRemote(client, alias, command, req);
  },
};

/** Fases 2 y 3 — apertura del canal y ejecución, con abort y timeout armados antes de pedir el canal. */
function runRemote(
  client: Client,
  alias: string,
  command: string,
  req: ExecRequest,
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolvePromise, rejectPromise) => {
    let stream: ClientChannel | undefined;
    let stdout = '';
    let stderr = '';
    let captured = 0;
    let discarded = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let exitCode: number | null = null;
    let settled = false;
    let killing = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
      req.signal.removeEventListener('abort', onAbort);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        stdout: req.pty ? stripAnsi(stdout) : stdout,
        stderr: req.pty ? stripAnsi(stderr) : stderr,
        exitCode,
        status: resolveStatus({ cancelled, timedOut, truncated }),
        ...(req.cwd ? { requestedCwd: req.cwd } : {}),
        ...(discarded > 0 ? { bytesDiscarded: discarded } : {}),
        killedOnMaxBytes: true,
      });
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const killChannel = (channel: ClientChannel): void => {
      try {
        channel.signal('KILL');
      } catch {
        /* el canal puede estar ya cerrado */
      }
      try {
        channel.close();
      } catch {
        /* idem */
      }
    };

    /** Mata el proceso remoto y resuelve en un tiempo acotado. */
    const kill = (): void => {
      if (killing) return;
      killing = true;
      if (!stream) {
        // Canal aún sin abrir: se resuelve ya; se matará en cuanto llegue.
        finish();
        return;
      }
      killChannel(stream);
      timers.push(setTimeout(finish, KILL_GRACE_MS + SETTLE_GRACE_MS));
    };

    function onAbort(): void {
      cancelled = true;
      kill();
    }

    if (req.signal.aborted) {
      onAbort();
      return;
    }
    req.signal.addEventListener('abort', onAbort, { once: true });
    timers.push(
      setTimeout(() => {
        timedOut = true;
        kill();
      }, req.timeoutMs),
    );

    client.exec(command, { pty: req.pty === true }, (err, channel: ClientChannel) => {
      if (settled) {
        // Llegó tarde: ya se resolvió cancelled/timeout. La petición no se puede
        // retirar, así que el proceso remoto se mata en el acto.
        if (channel) killChannel(channel);
        return;
      }
      if (err) {
        fail(new ExecSpawnError(`Could not run the command on "${alias}": ${err.message}`));
        return;
      }
      stream = channel;

      // Límite de salida (§12.14): se conserva hasta el byte límite y se mata
      // el proceso remoto en vez de seguir volcando megabytes al contexto.
      const accumulate = (chunk: Buffer, isStderr: boolean): void => {
        if (truncated) {
          discarded += chunk.length;
          return;
        }
        const room = req.maxBytes - captured;
        let keep = chunk;
        if (chunk.length > room) {
          keep = chunk.subarray(0, Math.max(0, room));
          discarded += chunk.length - keep.length;
          truncated = true;
        }
        captured += keep.length;
        if (isStderr) stderr += keep.toString();
        else stdout += keep.toString();
        if (truncated) kill();
      };

      channel.on('data', (chunk: Buffer) => accumulate(chunk, false));
      channel.stderr.on('data', (chunk: Buffer) => accumulate(chunk, true));
      channel.on('exit', (code: number | null) => {
        exitCode = code;
      });
      channel.on('close', finish);
      channel.on('error', (streamErr: Error) => {
        if (killing) {
          finish();
          return;
        }
        fail(new ExecSpawnError(streamErr.message));
      });

      // EOF inmediato también sin stdin y con PTY: un lector de stdin no debe
      // colgarse hasta el timeout. `pty + stdin` lo rechaza `exec` en preflight.
      if (req.stdin !== undefined) channel.end(req.stdin);
      else channel.end();
    });
  });
}
