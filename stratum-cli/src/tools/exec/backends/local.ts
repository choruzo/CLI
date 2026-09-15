/**
 * Hito 16 — backend `local` de `exec` (sustituye a la antigua tool `bash`).
 *
 * Diferencias deliberadas con el backend SSH:
 *  - `maxBytes` NO mata el proceso: se deja de conservar salida y se drena
 *    hasta que termina. Matarlo abortaría un `npm test` o un build verboso;
 *    lo que protege el contexto y la memoria es no acumular.
 *  - No hay PTY (`capabilities.pty = false`): exigiría `node-pty`, una
 *    dependencia nativa. `exec` lo rechaza en preflight.
 */
import { resolve } from 'path';
import { execa } from 'execa';
import type { ToolContext } from '../../../agent/types.js';
import type { StratumConfig } from '../../../config/schema.js';
import { scrubGitEnv } from '../../../git/env.js';
import {
  ExecSpawnError,
  KILL_GRACE_MS,
  SETTLE_GRACE_MS,
  resolveStatus,
  type ExecOutcome,
  type ExecRequest,
  type IExecBackend,
} from '../backend.js';
import type { ExecutionTarget } from '../target.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Argumentos de `pwsh.exe` para un comando. `pwsh -Command` sale con 1 ante
 * CUALQUIER fallo del último comando: el exit code real (un `grep` con 2, un
 * `npm test` con 3) se perdía, y `exec` lo necesita para su `<exec_result>`.
 *
 * `$LASTEXITCODE` a secas no basta: en `cmd /c exit 7; Get-Item x` el último
 * fallo es el cmdlet, pero `$LASTEXITCODE` sigue valiendo 7. Hace falta el
 * ORDEN real de ejecución, también dentro de bloques (`if { Get-Item x; cmd /c
 * exit 7 }` → 7). Los nativos no dejan rastro en `$Error` y los cmdlets sí, así
 * que un gancho `PostCommandLookupAction` —que PowerShell invoca, en orden,
 * justo antes de ejecutar cada comando— apunta cuántos errores había al
 * arrancar el ÚLTIMO nativo. Si al terminar hay más, lo que falló después fue
 * un cmdlet (→ 1); si no, el último fallo fue ese nativo (→ `$LASTEXITCODE`).
 *
 * Sin tocar la salida: nada de preferencias que escriban en stderr ni de
 * filtrar texto.
 *
 * Si el último comando termina bien (`$?` verdadero) el resultado es 0 en todos
 * los modos, como en POSIX (`false; x=1` → 0): el respaldo solo decide ENTRE
 * fallos, no reinterpreta un éxito.
 *
 * Contrato best-effort (decisión documentada en §12.17): el orden es exacto con
 * el gancho instalado y sin reemplazar. Si la sesión ya arranca en
 * `ConstrainedLanguage` y no lo admite, o si el propio comando pone su
 * `PostCommandLookupAction`, se cae a una regla sin orden: un error de
 * PowerShell en la ejecución → 1; si no, `$LASTEXITCODE`. En tuberías el gancho
 * registra la resolución de comandos, que PowerShell hace antes de ejecutar la
 * tubería: `Get-Item x | cmd /c exit 7` → 1.
 *
 * Se sigue la semántica de `$?` de PowerShell: tras llamar a una función, `$?`
 * es `$true` aunque un nativo dentro fallase, igual que sin envoltorio.
 */
export function windowsCommandArgs(command: string): string[] {
  const prelude = [
    // Sin esto pwsh colorea los errores con secuencias ANSI que acaban en el contexto del modelo.
    "try { $PSStyle.OutputRendering = 'PlainText' } catch {}",
    '$global:__stratumErrAtNative = -1; $global:__stratumHook = $false',
    'try { $global:__stratumHookBlock = { param($n, $e) if ($e.Command -and $e.Command.CommandType -eq "Application") { $global:__stratumErrAtNative = $global:Error.Count } }; $ExecutionContext.InvokeCommand.PostCommandLookupAction = $global:__stratumHookBlock; $global:__stratumHook = $true } catch {}',
    // La línea base va DESPUÉS de los `try`: un error capturado igual queda en
    // `$Error`, y sin esto el respaldo leería el fallo del gancho como un cmdlet.
    '$__stratumErrors = $Error.Count',
  ];
  const epilogue = [
    // El recuento final se toma YA: la comprobación del gancho de abajo podría
    // añadir un error propio a `$Error`.
    '$__stratumOk = $?; $__stratumCode = $LASTEXITCODE; $__stratumErrEnd = $Error.Count',
    'if ($__stratumOk) { exit 0 }',
    // El orden solo vale si NUESTRO gancho siguió instalado toda la ejecución:
    // un comando que ponga el suyo lo deja con datos obsoletos.
    '$__stratumOrdered = $false',
    'if ($global:__stratumHook) { try { $__stratumOrdered = [bool]($ExecutionContext.InvokeCommand.PostCommandLookupAction -eq $global:__stratumHookBlock) } catch {} }',
    'if ($__stratumOrdered) {',
    '  if ($global:__stratumErrAtNative -ge 0 -and $__stratumErrEnd -le $global:__stratumErrAtNative -and $__stratumCode) { exit $__stratumCode }',
    '  exit 1',
    '}',
    'if ($__stratumErrEnd -le $__stratumErrors -and $__stratumCode) { exit $__stratumCode }',
    'exit 1',
  ];
  const script = [...prelude, command, ...epilogue].join('\n');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
}

/** Acumulador de salida con tope en bytes: conserva hasta el límite y cuenta el resto. */
export class ByteBudget {
  private captured = 0;
  discarded = 0;
  readonly stdout: Buffer[] = [];
  readonly stderr: Buffer[] = [];

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer | string, stream: 'stdout' | 'stderr'): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const room = Math.max(0, this.maxBytes - this.captured);
    const target = stream === 'stdout' ? this.stdout : this.stderr;
    if (buf.length <= room) {
      target.push(buf);
      this.captured += buf.length;
      return;
    }
    if (room > 0) {
      target.push(buf.subarray(0, room));
      this.captured += room;
    }
    this.discarded += buf.length - room;
  }

  get truncated(): boolean {
    return this.discarded > 0;
  }

  text(stream: 'stdout' | 'stderr'): string {
    return Buffer.concat(stream === 'stdout' ? this.stdout : this.stderr).toString('utf8');
  }
}

export const localBackend: IExecBackend = {
  kind: 'local',
  capabilities: { pty: false, stdin: true, cwd: true, maxBytes: true },

  defaults(_target: ExecutionTarget, config: StratumConfig) {
    return { timeoutMs: config.tools.bashTimeout, maxBytes: config.tools.execMaxBytes };
  },

  run(_target: ExecutionTarget, req: ExecRequest, ctx: ToolContext): Promise<ExecOutcome> {
    const cwd = req.cwd ? resolve(ctx.cwd, req.cwd) : ctx.cwd;

    let subprocess: ReturnType<typeof execa>;
    try {
      const options = {
        cwd,
        // Entorno heredado MENOS las variables de enrutado de git (git/env.ts).
        // `extendEnv: false` es obligatorio: con el merge por defecto de execa,
        // quitarlas de la copia no las quitaría del proceso hijo.
        env: scrubGitEnv(),
        extendEnv: false,
        // Sin buffer interno: execa acumula por defecto hasta `maxBuffer`
        // (100 MB) y falla después. La salida la consumen los listeners de abajo.
        buffer: false,
        reject: false,
        ...(req.stdin !== undefined ? { input: req.stdin } : { stdin: 'ignore' as const }),
        // En POSIX, grupo de procesos propio para matar shell + hijos de una vez.
        ...(!IS_WINDOWS && { detached: true }),
      } as const;
      subprocess = IS_WINDOWS
        ? execa('pwsh.exe', windowsCommandArgs(req.command), options)
        : execa(req.command, { ...options, shell: true });
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

      const signalTree = (sig: NodeJS.Signals): void => {
        const pid = subprocess.pid;
        if (pid !== undefined && !IS_WINDOWS) {
          try {
            process.kill(-pid, sig);
          } catch {
            /* el grupo ya no existe */
          }
        } else {
          try {
            subprocess.kill(sig);
          } catch {
            /* ya terminado */
          }
        }
      };

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
          cwd,
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

      // §12.12: SIGTERM, SIGKILL a los 2 s, y resolver en cualquier caso poco
      // después — un nieto huérfano puede mantener abiertos los pipes.
      const kill = (): void => {
        if (killing) return;
        killing = true;
        signalTree('SIGTERM');
        timers.push(setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS));
        timers.push(
          setTimeout(() => {
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
          // `failed` sin exit code ni señal nuestra: el proceso no llegó a arrancar.
          if (!killing && result.failed && result.exitCode === undefined && !result.signal) {
            fail(new ExecSpawnError(result.shortMessage ?? result.message ?? 'spawn failed'));
            return;
          }
          settle(result.exitCode ?? null);
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
  },
};
