import { appendFile, mkdir, rename, stat, unlink } from 'fs/promises';
import { dirname } from 'path';
import type { StratumConfig } from '../../config/schema.js';
import { expandHome } from '../../config/paths.js';
import { getLogger } from '../../logging/index.js';

const log = getLogger('ssh');

const DEFAULT_AUDIT_PATH = '~/.stratum/logs/ssh-audit.jsonl';
/** Rotación por tamaño a 10 MB (§12.14). */
const MAX_BYTES = 10 * 1024 * 1024;

/** Registro de auditoría de un comando remoto (§12.14). */
export interface SSHAuditRecord {
  timestamp: string;
  sessionId?: string;
  host: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

/**
 * Log de auditoría de comandos remotos en JSON Lines.
 *
 * No se reutiliza el `FileSink` de `src/logging/sinks.ts` porque impone la
 * forma `LogRecord` y §12.14 fija este schema; sí se replica su patrón: cola de
 * escritura serializada, rotación por tamaño y fire-and-forget que nunca lanza
 * (un fallo de auditoría no puede tumbar una tool call).
 */
export class SSHAuditLog {
  private queue: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(private readonly path: string) {}

  write(record: SSHAuditRecord): void {
    const line = JSON.stringify(record) + '\n';
    this.queue = this.queue
      .then(async () => {
        if (!this.dirEnsured) {
          await mkdir(dirname(this.path), { recursive: true });
          this.dirEnsured = true;
        }
        await this.rotateIfNeeded();
        await appendFile(this.path, line, 'utf8');
      })
      .catch((err: unknown) => {
        log.warn('ssh audit write failed', { path: this.path, err });
      });
  }

  /** Espera a que se vacíe la cola (cierre del proceso y tests). */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.path);
      if (info.size < MAX_BYTES) return;
    } catch {
      return; // aún no existe
    }
    const rotated = `${this.path}.1`;
    try {
      await unlink(rotated);
    } catch {
      /* no había rotado previo */
    }
    await rename(this.path, rotated);
  }
}

/** No-op cuando `ssh.auditLog` es `false`. */
class DisabledAuditLog {
  write(): void {}
  async flush(): Promise<void> {}
}

export type AuditLog = SSHAuditLog | DisabledAuditLog;

/** Resuelve el destino del log según `ssh.auditLog` (§12.14). */
export function createAuditLog(config: StratumConfig): AuditLog {
  const setting = config.ssh?.auditLog ?? true;
  if (setting === false) return new DisabledAuditLog();
  const path = typeof setting === 'string' ? setting : DEFAULT_AUDIT_PATH;
  return new SSHAuditLog(expandHome(path));
}
