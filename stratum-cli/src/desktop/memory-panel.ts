import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { StratumConfig } from '../config/schema.js';
import { resolveMemoryPaths } from '../config/paths.js';
import { DecisionStore } from '../memory/decisions.js';
import { getDecisionMemory } from '../memory/decision-memory.js';
import { getLogger } from '../logging/index.js';
import type { DecisionSummary, MemoryStateFrame } from './protocol.js';

const log = getLogger('desktop.memory');

/** Tope del contenido de una decisión en el listado del sidebar. */
const DECISION_CONTENT_CHARS = 2_000;

export type MemorySaveResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: true; content: string; mtimeMs: number | null };

/**
 * Memoria global del asistente vista desde el sidebar (D4, §7.3): el
 * `STRATUM.md` global —compartido con la CLI— y las decisiones del asistente
 * (`~/.stratum/desktop/memory/`, separadas de las de cualquier proyecto).
 *
 * Editar el `STRATUM.md` es concurrencia optimista: la UI devuelve el `mtime`
 * sobre el que editó y, si el fichero cambió en disco entretanto (la CLI con
 * `stratum init`, otro editor), no se pisa.
 */
export class MemoryPanel {
  constructor(private config: StratumConfig) {}

  /** La config cambió desde Ajustes (D5): la ruta del `STRATUM.md` global puede ser otra. */
  setConfig(config: StratumConfig): void {
    this.config = config;
  }

  get globalPath(): string {
    return resolveMemoryPaths(this.config).globalFile;
  }

  private readGlobal(): MemoryStateFrame['global'] {
    const path = this.globalPath;
    if (!existsSync(path)) return { path, exists: false, content: '', mtimeMs: null };
    return {
      path,
      exists: true,
      content: readFileSync(path, 'utf-8'),
      mtimeMs: statSync(path).mtimeMs,
    };
  }

  state(): MemoryStateFrame {
    return { type: 'memory_state', global: this.readGlobal(), decisions: this.decisions() };
  }

  private decisions(): DecisionSummary[] {
    const file = resolveMemoryPaths(this.config).decisionsFile;
    return new DecisionStore(file)
      .all()
      .map((d) => ({
        id: d.id,
        title: d.title,
        content:
          d.content.length > DECISION_CONTENT_CHARS
            ? `${d.content.slice(0, DECISION_CONTENT_CHARS)}…`
            : d.content,
        type: d.type,
        tags: d.tags,
        importance: d.importance,
        timestamp: d.timestamp,
      }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  save(content: string, baseMtimeMs: number | null): MemorySaveResult {
    const current = this.readGlobal();
    if (current.mtimeMs !== baseMtimeMs) {
      return { ok: false, conflict: true, content: current.content, mtimeMs: current.mtimeMs };
    }
    const path = this.globalPath;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path);
    return { ok: true, mtimeMs: statSync(path).mtimeMs };
  }

  /** Borra una decisión y su vector. Si el índice no carga, al menos del store (fuente de verdad). */
  async forget(id: string): Promise<boolean> {
    try {
      return await getDecisionMemory(this.config).remove(id);
    } catch (err) {
      log.warn('semantic index unavailable; removing from the store only', { id, err });
      return new DecisionStore(resolveMemoryPaths(this.config).decisionsFile).remove(id);
    }
  }
}
