import type { StratumConfig } from '../../config/schema.js';
import { closeSshPool } from '../ssh/runtime.js';
import { createExecAuditLog, type AuditLog } from './audit.js';

/**
 * Estado vivo de `exec` en el proceso (Hito 16): el log de auditoría, singleton
 * por objeto de config — mismo patrón que `getSshPool`. El pool SSH sigue
 * viviendo en `tools/ssh/runtime.ts`.
 */
let auditLog: AuditLog | null = null;
let auditConfig: StratumConfig | null = null;

export function getExecAuditLog(config: StratumConfig): AuditLog {
  if (auditLog && auditConfig === config) return auditLog;
  if (auditLog) void auditLog.flush();
  auditLog = createExecAuditLog(config);
  auditConfig = config;
  return auditLog;
}

/**
 * Teardown de `chat` y `run` (§12.12): cierra las conexiones SSH vivas (sin
 * esto el event loop no termina) y vacía la cola de auditoría.
 */
export async function closeExecRuntime(): Promise<void> {
  const audit = auditLog;
  auditLog = null;
  auditConfig = null;
  await closeSshPool();
  if (audit) await audit.flush();
}

/** Solo para tests: descarta el singleton sin tocar disco ni red. */
export function resetExecRuntime(): void {
  auditLog = null;
  auditConfig = null;
}
