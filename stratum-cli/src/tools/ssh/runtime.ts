import type { StratumConfig } from '../../config/schema.js';
import type { ToolContext, DestructiveDecision } from '../../agent/types.js';
import { SSHConnectionPool, type ConfirmFn } from './pool.js';

/**
 * Estado SSH vivo del proceso: un pool **por objeto de config**. Las tools no
 * reciben el pool por parámetro, lo piden aquí con la config de su contexto. La
 * auditoría de comandos vive desde el Hito 16 en `tools/exec/runtime.ts`, común
 * a todos los targets.
 *
 * Una sesión es dueña de su config, así que también lo es de su pool: varias
 * sesiones en un mismo proceso no comparten conexiones ni se las cierran entre
 * sí (antes había un único pool, y pedirlo con otra config cerraba el anterior).
 * Los subagentes usan la config del padre y, por tanto, sus conexiones.
 */
const pools = new Map<StratumConfig, SSHConnectionPool>();

export function getSshPool(config: StratumConfig): SSHConnectionPool {
  let pool = pools.get(config);
  if (!pool) {
    pool = new SSHConnectionPool(config);
    pools.set(config, pool);
  }
  return pool;
}

/**
 * Cierra las conexiones vivas: las de `config` (el cierre de una sesión) o,
 * sin argumento, todas (el apagado del proceso, vía `closeExecRuntime()`). Sin
 * esto los sockets abiertos mantienen vivo el event loop y el proceso no
 * termina (§12.12).
 */
export async function closeSshPool(config?: StratumConfig): Promise<void> {
  if (config) {
    const pool = pools.get(config);
    pools.delete(config);
    if (pool) await pool.closeAll();
    return;
  }
  const all = [...pools.values()];
  pools.clear();
  await Promise.allSettled(all.map((p) => p.closeAll()));
}

/** Solo para tests: descarta los pools sin tocar la red. */
export function resetSshRuntime(): void {
  pools.clear();
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
