import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import type { SubagentResult, SubagentStatus } from '../agent/types.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent.subagent');

/**
 * Fichero de subagente persistido (§12.16 / Hito 8B). Se escribe dos veces por
 * ejecución: una marca `running` justo antes de lanzar el hijo y el resultado
 * terminal al terminar. Si el proceso muere entre ambas, el registro queda con
 * `status: 'running'` y en `resume` se detecta como interrumpido — el padre debe
 * verificar el estado real antes de decidir (NO se reejecuta automáticamente).
 */
export interface SubagentFile {
  id: string;
  profile: string;
  task: string;
  /** `running` mientras se ejecuta; un `SubagentStatus` terminal al terminar. */
  status: SubagentStatus | 'running';
  /** Ausente mientras `running`; presente en estado terminal. */
  result: SubagentResult | null;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Almacén de resultados de subagentes en `<projectRoot>/.stratum/subagents/`.
 * Escritura atómica (tmp + rename), best-effort: nunca lanza. Mismo patrón que
 * `PlanStore` (§12.15).
 */
export class SubagentStore {
  private readonly dir: string;

  constructor(projectRoot: string) {
    this.dir = join(projectRoot, '.stratum', 'subagents');
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(id: string): string {
    const file = id.endsWith('.json') ? id : `${id}.json`;
    return join(this.dir, file);
  }

  private write(file: SubagentFile): void {
    try {
      this.ensureDir();
      const target = this.pathFor(file.id);
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', 'utf-8');
      renameSync(tmp, target);
    } catch (err) {
      log.warn('subagent write failed', { id: file.id, err });
      process.stderr.write(
        `[stratum] Advertencia: no se pudo guardar el subagente en .stratum/subagents/${file.id}.json — ${String(err)}\n`,
      );
    }
  }

  /** Marca `running` antes de ejecutar. Preserva `createdAt` si el fichero existe. */
  saveRunning(id: string, profile: string, task: string): void {
    const now = new Date().toISOString();
    const prev = this.read(id);
    this.write({
      id,
      profile,
      task,
      status: 'running',
      result: null,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  /** Persiste el resultado terminal, sobrescribiendo la marca `running`. */
  saveResult(id: string, profile: string, task: string, result: SubagentResult): void {
    const now = new Date().toISOString();
    const prev = this.read(id);
    this.write({
      id,
      profile,
      task,
      status: result.status,
      result,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }

  /**
   * Marca un registro `running` como `interrupted` (llamado en `resume` tras
   * inyectar el preámbulo, para que no se vuelva a detectar en el siguiente arranque).
   */
  markInterrupted(id: string): void {
    const prev = this.read(id);
    if (!prev || prev.status !== 'running') return;
    this.write({ ...prev, status: 'interrupted', updatedAt: new Date().toISOString() });
  }

  /** Lee un registro. Devuelve null si no existe o está corrupto. */
  read(id: string): SubagentFile | null {
    try {
      const target = this.pathFor(id);
      if (!existsSync(target)) return null;
      return JSON.parse(readFileSync(target, 'utf-8')) as SubagentFile;
    } catch (err) {
      log.warn('subagent read failed', { id, err });
      return null;
    }
  }

  /** Todos los registros persistidos (para inspección/limpieza). Best-effort. */
  list(): SubagentFile[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
        .map((f) => this.read(f))
        .filter((r): r is SubagentFile => r !== null);
    } catch (err) {
      log.warn('subagent list failed', { err });
      return [];
    }
  }

  /**
   * Registros cuya ejecución quedó a medias (`status: 'running'`): un cuelgue duro
   * dejó la marca sin resultado terminal. En `resume` se tratan como `interrupted`.
   */
  loadInterrupted(): SubagentFile[] {
    return this.list().filter((r) => r.status === 'running');
  }
}
