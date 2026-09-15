/**
 * Hito 16 — contrato de los backends de ejecución (§2.5 de
 * `CLI-DOC/Orientacion-Infraestructura.md`). Mismo patrón que `IProvider`: un
 * método, varias implementaciones, un router que elige (`router.ts`).
 *
 * Contrato común a todos los backends:
 *  - Precedencia de estados: `cancelled > timeout > truncated > exited`.
 *  - Cancelación estructurada: al abortar `signal`, el backend mata el proceso
 *    y RESUELVE con `cancelled` (nunca rechaza), en un tiempo acotado.
 *  - Sin `stdin`, la entrada se cierra de inmediato (también con PTY): un
 *    comando que lea stdin recibe EOF en vez de colgarse hasta el timeout.
 *  - `run` solo rechaza con `ExecSpawnError`/`ExecConnectError`/`HostKeyError`:
 *    fallos ANTES de que el comando llegase a ejecutarse.
 */
import type { StratumConfig } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';
import type { ExecutionTarget, TargetKind } from './target.js';

export interface ExecCapabilities {
  pty: boolean;
  stdin: boolean;
  cwd: boolean;
  maxBytes: boolean;
}

export type ExecStatus = 'exited' | 'truncated' | 'timeout' | 'cancelled';

export interface ExecRequest {
  command: string;
  cwd?: string;
  pty?: boolean;
  stdin?: string;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
}

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: ExecStatus;
  /** Directorio efectivo (local). */
  cwd?: string;
  /** Directorio solicitado (ssh): el `cd` remoto puede fallar, así que no se afirma efectivo. */
  requestedCwd?: string;
  /** Bytes que no se conservaron por `maxBytes`. */
  bytesDiscarded?: number;
  /** El backend mata el proceso al superar `maxBytes` (ssh) o lo deja terminar (local). */
  killedOnMaxBytes?: boolean;
}

export interface IExecBackend {
  kind: TargetKind;
  capabilities: ExecCapabilities;
  defaults(target: ExecutionTarget, config: StratumConfig): { timeoutMs: number; maxBytes: number };
  run(target: ExecutionTarget, req: ExecRequest, ctx: ToolContext): Promise<ExecOutcome>;
}

/** El proceso no llegó a arrancar (shell ausente, canal SSH rechazado…). */
export class ExecSpawnError extends Error {
  override readonly name = 'ExecSpawnError';
}

/** No se pudo establecer la conexión con el target. */
export class ExecConnectError extends Error {
  override readonly name = 'ExecConnectError';
}

/** Margen entre SIGTERM y SIGKILL (§12.12). */
export const KILL_GRACE_MS = 2000;
/** Margen extra tras SIGKILL antes de resolver aunque el proceso no haya cerrado. */
export const SETTLE_GRACE_MS = 1000;

export function resolveStatus(flags: {
  cancelled: boolean;
  timedOut: boolean;
  truncated: boolean;
}): ExecStatus {
  if (flags.cancelled) return 'cancelled';
  if (flags.timedOut) return 'timeout';
  if (flags.truncated) return 'truncated';
  return 'exited';
}
