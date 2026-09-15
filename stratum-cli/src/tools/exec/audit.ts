import { appendFile, mkdir, rename, stat, unlink } from 'fs/promises';
import { dirname } from 'path';
import type { StratumConfig } from '../../config/schema.js';
import { expandHome } from '../../config/paths.js';
import { getLogger } from '../../logging/index.js';
import type { ExecStatus } from './backend.js';

const log = getLogger('tools').child('exec');

const DEFAULT_AUDIT_PATH = '~/.stratum/logs/exec-audit.jsonl';
/** Rotación por tamaño a 10 MB (§12.14). */
const MAX_BYTES = 10 * 1024 * 1024;

export type ExecAuditStatus = ExecStatus | 'spawn_error' | 'connect_error';

/**
 * Registro de auditoría de un intento real de ejecución (Hito 16). Conserva los
 * campos de §12.14 (`host` sigue presente para targets SSH) y añade `target`,
 * `status` y el directorio. `command` llega ya redactado; `stdin` nunca se registra.
 */
export interface ExecAuditRecord {
  timestamp: string;
  sessionId?: string;
  target: string;
  host?: string;
  command: string;
  cwd?: string;
  requestedCwd?: string;
  status: ExecAuditStatus;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

/**
 * Log de auditoría de comandos en JSON Lines, para cualquier target.
 *
 * No se reutiliza el `FileSink` de `src/logging/sinks.ts` porque impone la
 * forma `LogRecord`; sí se replica su patrón: cola de escritura serializada,
 * rotación por tamaño y fire-and-forget que nunca lanza (un fallo de auditoría
 * no puede tumbar una tool call).
 */
export class ExecAuditLog {
  private queue: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(readonly path: string) {}

  write(record: ExecAuditRecord): void {
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
        log.warn('exec audit write failed', { path: this.path, err });
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

/** No-op cuando `tools.auditLog` es `false`. */
class DisabledAuditLog {
  write(): void {}
  async flush(): Promise<void> {}
}

export type AuditLog = ExecAuditLog | DisabledAuditLog;

/**
 * Destino según `tools.auditLog`. El alias obsoleto `ssh.auditLog` lo migra el
 * loader a esta clave dentro de cada capa de config (`migrateLegacyKeys`).
 */
export function createExecAuditLog(config: StratumConfig): AuditLog {
  const setting = config.tools.auditLog;
  if (setting === false) return new DisabledAuditLog();
  const path = typeof setting === 'string' ? setting : DEFAULT_AUDIT_PATH;
  return new ExecAuditLog(expandHome(path));
}
