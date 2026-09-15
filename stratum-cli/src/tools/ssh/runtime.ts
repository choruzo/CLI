import type { StratumConfig } from '../../config/schema.js';
import type { ToolContext, DestructiveDecision } from '../../agent/types.js';
import { SSHConnectionPool, type ConfirmFn } from './pool.js';

/**
 * Estado SSH vivo del proceso. Singleton por config, mismo patrón que
 * `getDecisionMemory` en `src/memory/decision-memory.ts`: las tools no reciben
 * el pool por parámetro, lo piden aquí. La auditoría de comandos vive desde el
 * Hito 16 en `tools/exec/runtime.ts`, común a todos los targets.
 */
let pool: SSHConnectionPool | null = null;
let poolConfig: StratumConfig | null = null;

export function getSshPool(config: StratumConfig): SSHConnectionPool {
  if (pool && poolConfig === config) return pool;

  // Sustituir el pool sin cerrar el anterior filtraría sus sockets, que
  // mantienen vivo el event loop. En producción la config es un único objeto y
  // esta rama no se toma más de una vez.
  if (pool) void pool.closeAll();

  pool = new SSHConnectionPool(config);
  poolConfig = config;
  return pool;
}

/**
 * Cierra las conexiones vivas. Lo llama `closeExecRuntime()` en el teardown de
 * `chat` y `run` (§12.12): sin esto los sockets abiertos mantienen vivo el
 * event loop y el proceso no termina.
 */
export async function closeSshPool(): Promise<void> {
  const current = pool;
  pool = null;
  poolConfig = null;
  if (current) await current.closeAll();
}

/** Solo para tests: descarta el singleton sin tocar la red. */
export function resetSshRuntime(): void {
  pool = null;
  poolConfig = null;
}

/**
 * Adapta el canal de confirmación destructiva del `ToolContext` al gate TOFU
 * del pool. Reutilizarlo da gratis el comportamiento correcto en cada contexto:
 * `<DestructiveConfirm>` en el chat Ink, readline en `stratum run`, y deny
 * automático sin TTY (CI, salida a pipe).
 */
export function confirmFnFrom(ctx: ToolContext): ConfirmFn | undefined {
  const confirm = ctx.confirmDestructive;
  if (!confirm) return undefined;
  if (ctx.destructivePolicy === 'deny') return undefined;
  return async (description: string): Promise<DestructiveDecision> =>
    confirm({ callId: `ssh-hostkey-${Date.now()}`, toolName: 'exec', description });
}
