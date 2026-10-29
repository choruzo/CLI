/**
 * M13 — backend `container:<box>` de `exec`: la caja de Stratum (`src/box/`),
 * con `<runtime> exec` (Podman o Docker) lanzado con execa y argumentos fijos.
 * El comando del modelo es **un argumento** del envoltorio, nunca parte de la
 * línea del runtime.
 *
 * Mismo contrato que los demás backends (`backend.ts`). Dos detalles propios:
 *
 *  - **Matar el cliente no mata el comando**: el proceso vive dentro de la caja
 *    y `docker exec` / `podman exec` no le reenvía la muerte de su cliente. Cada
 *    `exec` es líder de su grupo de procesos dentro de la caja, así que el
 *    envoltorio apunta su pid (`/tmp/.stratum-exec/<id>`) y cancelar o vencer el
 *    plazo manda la señal **al grupo** con otro `exec`: TERM, KILL a los 2 s y,
 *    al final, se suelta el cliente local.
 *  - `maxBytes`, como en local: se deja de conservar salida y el comando termina
 *    (matar un build verboso no protege nada que no proteja ya el tope).
 *
 * Falla cerrado: sin runtime, sin caja, con la caja parada o con un contenedor
 * de ese nombre que no lleve la etiqueta de Stratum, `run` rechaza con
 * `ExecConnectError` antes de ejecutar nada. Nunca cae a `local`.
 */
import { randomBytes } from 'crypto';
import { execa } from 'execa';
import type { ToolContext } from '../../../agent/types.js';
import type { StratumConfig } from '../../../config/schema.js';
import { cachedRuntime, defaultRunner, type ContainerRuntime } from '../../../box/runtime.js';
import { BOX_LABEL, boxContainerName, parseInspect } from '../../../box/spec.js';
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
import { ByteBudget } from './local.js';

const PID_DIR = '/tmp/.stratum-exec';

/**
 * `sh -c ENVOLTORIO stratum <id> <cwd> <comando>`. Apunta el pid del grupo,
 * entra en el directorio (el home sin `cwd`), ejecuta y limpia. Un `cd` que
 * falla sale con 1 sin ejecutar nada.
 */
export const CONTAINER_WRAPPER =
  `f="${PID_DIR}/$1"; ` +
  `{ mkdir -p ${PID_DIR} && echo $$ > "$f"; } || exit 125; ` +
  'cd "${2:-$HOME}" || { rm -f "$f"; exit 1; }; ' +
  'sh -c "$3"; s=$?; rm -f "$f"; exit $s';

/** `sh -c KILLER stratum <id> <TERM|KILL>`: la señal al grupo del comando (o a su pid). */
export const CONTAINER_KILLER =
  `f="${PID_DIR}/$1"; [ -f "$f" ] || exit 0; p=$(cat "$f"); ` +
  'kill -"$2" -"$p" 2>/dev/null || kill -"$2" "$p" 2>/dev/null; ' +
  '[ "$2" = KILL ] && rm -f "$f"; exit 0';

const CHECK_TIMEOUT_MS = 15_000;
const KILLER_TIMEOUT_MS = 10_000;

function nameOf(target: ExecutionTarget): string {
  if (target.kind !== 'container') {
    throw new Error(`container backend received target "${target.kind}"`);
  }
  return target.name;
}

function cancelledOutcome(req: ExecRequest): ExecOutcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    status: 'cancelled',
    ...(req.cwd ? { requestedCwd: req.cwd } : {}),
    killedOnMaxBytes: false,
  };
}

/** Runtime disponible y caja de Stratum en marcha; si no, `ExecConnectError`. */
async function requireRunningBox(name: string, config: StratumConfig): Promise<ContainerRuntime> {
  const detected = await cachedRuntime(config.box?.runtime ?? 'auto');
  if (!detected.ok)
    throw new ExecConnectError(`The box "${name}" is not available: ${detected.reason}`);
  const rt = detected.runtime;
  const r = await defaultRunner(rt.bin, ['container', 'inspect', boxContainerName(name)], {
    timeoutMs: CHECK_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw new ExecConnectError(
      `The box "${name}" does not exist. Ask the user to start it ("stratum box start").`,
    );
  }
  let running = false;
  let label: string | undefined;
  try {
    ({ running, label } = parseInspect(r.stdout));
  } catch {
    throw new ExecConnectError(`Could not read the state of the box "${name}".`);
  }
  if (label !== name) {
    throw new ExecConnectError(
      `The container for box "${name}" was not created by Stratum (no ${BOX_LABEL} label).`,
    );
  }
  if (!running) {
    throw new ExecConnectError(
      `The box "${name}" is stopped. Ask the user to start it ("stratum box start").`,
    );
  }
  return rt;
}

export const containerBackend: IExecBackend = {
  kind: 'container',
  capabilities: { pty: false, stdin: true, cwd: true, maxBytes: true },

  defaults(_target: ExecutionTarget, config: StratumConfig) {
    return { timeoutMs: config.tools.bashTimeout, maxBytes: config.tools.execMaxBytes };
  },

  async run(target: ExecutionTarget, req: ExecRequest, ctx: ToolContext): Promise<ExecOutcome> {
    const name = nameOf(target);
    if (req.signal.aborted) return cancelledOutcome(req);
    const rt = await requireRunningBox(name, ctx.config);
    if (req.signal.aborted) return cancelledOutcome(req);
    return runInBox(rt, boxContainerName(name), req);
  },
};

function runInBox(rt: ContainerRuntime, container: string, req: ExecRequest): Promise<ExecOutcome> {
  const execId = randomBytes(8).toString('hex');
  let subprocess: ReturnType<typeof execa>;
  try {
    subprocess = execa(
      rt.bin,
      [
        'exec',
        '-i',
        container,
        'sh',
        '-c',
        CONTAINER_WRAPPER,
        'stratum',
        execId,
        req.cwd ?? '',
        req.command,
      ],
      {
        buffer: false,
        reject: false,
        windowsHide: true,
        ...(req.stdin !== undefined ? { input: req.stdin } : { stdin: 'ignore' as const }),
      },
    );
  } catch (err) {
    return Promise.reject(new ExecSpawnError((err as Error).message));
  }

  const budget = new ByteBudget(req.maxBytes);
  subprocess.stdout?.on('data', (chunk: Buffer | string) => budget.push(chunk, 'stdout'));
  subprocess.stderr?.on('data', (chunk: Buffer | string) => budget.push(chunk, 'stderr'));

  return new Promise<ExecOutcome>((resolvePromise, rejectPromise) => {
    let cancelled = false;
    let timedOut = false;
    let killing = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const cleanup = (): void => {
      for (const t of timers) clearTimeout(t);
      req.signal.removeEventListener('abort', onAbort);
    };

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        stdout: budget.text('stdout'),
        stderr: budget.text('stderr'),
        exitCode,
        status: resolveStatus({ cancelled, timedOut, truncated: budget.truncated }),
        ...(req.cwd ? { requestedCwd: req.cwd } : {}),
        ...(budget.discarded > 0 ? { bytesDiscarded: budget.discarded } : {}),
        killedOnMaxBytes: false,
      });
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    /** La señal al grupo del comando, dentro de la caja. Nunca rechaza. */
    const signalInBox = (sig: 'TERM' | 'KILL'): void => {
      void execa(
        rt.bin,
        ['exec', container, 'sh', '-c', CONTAINER_KILLER, 'stratum', execId, sig],
        {
          reject: false,
          stdin: 'ignore',
          windowsHide: true,
          timeout: KILLER_TIMEOUT_MS,
        },
      ).catch(() => undefined);
    };

    // TERM, KILL a los 2 s (también cubre un comando que aún no había apuntado
    // su pid en el primer intento) y, si el cliente sigue sin cerrar, se suelta.
    const kill = (): void => {
      if (killing) return;
      killing = true;
      signalInBox('TERM');
      timers.push(setTimeout(() => signalInBox('KILL'), KILL_GRACE_MS));
      timers.push(
        setTimeout(() => {
          try {
            subprocess.kill('SIGKILL');
          } catch {
            /* ya terminado */
          }
          subprocess.stdout?.destroy();
          subprocess.stderr?.destroy();
          settle(null);
        }, KILL_GRACE_MS + SETTLE_GRACE_MS),
      );
    };

    function onAbort(): void {
      cancelled = true;
      kill();
    }

    if (req.signal.aborted) onAbort();
    else req.signal.addEventListener('abort', onAbort, { once: true });

    timers.push(
      setTimeout(() => {
        timedOut = true;
        kill();
      }, req.timeoutMs),
    );

    subprocess.then(
      (result) => {
        if (!killing && result.failed && result.exitCode === undefined && !result.signal) {
          fail(new ExecSpawnError(result.shortMessage ?? result.message ?? 'spawn failed'));
          return;
        }
        // Si lo matamos nosotros, su exit code es un artefacto de la muerte.
        settle(killing ? null : (result.exitCode ?? null));
      },
      (err: unknown) => {
        if (killing) {
          settle(null);
          return;
        }
        fail(new ExecSpawnError((err as Error).message));
      },
    );
  });
}
