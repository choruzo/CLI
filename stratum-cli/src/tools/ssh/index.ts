import type { StratumConfig } from '../../config/schema.js';
import type { ToolRegistry } from '../registry.js';
import { sshExecTool } from './exec.js';
import { sshUploadTool, sshDownloadTool } from './sftp.js';

export {
  getSshPool,
  getAuditLog,
  closeSshPool,
  resetSshRuntime,
  confirmFnFrom,
} from './runtime.js';
export { SSHConnectionPool } from './pool.js';
export { KnownHostsStore, verifyHostKey, fingerprintOf, HostKeyError } from './known-hosts.js';
export { resolveHost, resolveSecret, resolveAgentSocket, buildConnectConfig } from './inventory.js';

/** Nombres de las tools SSH, para el filtrado y el render de la UI. */
export const SSH_TOOL_NAMES = ['ssh_exec', 'ssh_upload', 'ssh_download'] as const;

/**
 * Registra las tools SSH (§12.14). Si no hay sección `ssh` en la config o el
 * inventario está vacío, **no se registra nada**: el LLM no debe ver tools que
 * no puede usar.
 */
export function registerSshTools(registry: ToolRegistry, config: StratumConfig): void {
  const hosts = config.ssh?.hosts;
  if (!hosts || Object.keys(hosts).length === 0) return;

  registry.register(sshExecTool);
  registry.register(sshUploadTool);
  registry.register(sshDownloadTool);
}
