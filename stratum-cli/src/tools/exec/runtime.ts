import type { StratumConfig } from '../../config/schema.js';
import { closeSshPool } from '../ssh/runtime.js';
import { shutdownAllJobs } from '../../jobs/registry.js';
import { createExecAuditLog, type AuditLog } from './audit.js';

/**
 * Estado vivo de `exec` en el proceso (Hito 16): el log de auditoría, uno **por
 * objeto de config** — mismo patrón que `getSshPool`. El pool SSH sigue
 * viviendo en `tools/ssh/runtime.ts`.
 *
 * Dos niveles de cierre:
 *  - `closeSessionExecRuntime(config, jobs)` — el de **una sesión**: sus jobs,
 *    sus conexiones SSH y su cola de auditoría. No toca nada de otra sesión del
 *    mismo proceso.
 *  - `closeExecRuntime()` — el del **proceso**: todo lo que quede.
 */
const auditLogs = new Map<StratumConfig, AuditLog>();

export function getExecAuditLog(config: StratumConfig): AuditLog {
  let log = auditLogs.get(config);
  if (!log) {
    log = createExecAuditLog(config);
    auditLogs.set(config, log);
  }
  return log;
}

/** Lo que una sesión tiene que apagar de sus jobs (`JobManager`). */
export interface SessionJobs {
  shutdown(): Promise<void>;
}

/**
 * Cierre de una sesión. El orden es el de `closeExecRuntime()`: primero los
 * jobs (cancelar uno escribe su cierre en la auditoría), luego SSH y al final
 * se vacía la cola de auditoría. Nunca lanza.
 */
export async function closeSessionExecRuntime(
  config: StratumConfig,
  jobs?: SessionJobs,
): Promise<void> {
  if (jobs) await jobs.shutdown().catch(() => undefined);
  const audit = auditLogs.get(config);
  auditLogs.delete(config);
  await closeSshPool(config).catch(() => undefined);
  if (audit) await audit.flush();
}

/**
 * Teardown de `chat` y `run` (§12.12): cancela los jobs en segundo plano que
 * sigan vivos (con su árbol de procesos), cierra las conexiones SSH (sin esto
 * el event loop no termina) y vacía la cola de auditoría. Es el cierre del
 * proceso entero: con varias sesiones vivas, cada una se cierra con
 * `closeSessionExecRuntime`.
 */
export async function closeExecRuntime(): Promise<void> {
  // Antes que nada: cancelar un job escribe su cierre en la auditoría.
  await shutdownAllJobs();
  const audits = [...auditLogs.values()];
  auditLogs.clear();
  await closeSshPool();
  await Promise.allSettled(audits.map((a) => a.flush()));
}

/** Solo para tests: descarta los logs sin tocar disco ni red. */
export function resetExecRuntime(): void {
  auditLogs.clear();
}
