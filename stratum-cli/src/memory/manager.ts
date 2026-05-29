import type { StratumConfig } from '../config/schema.js';
import { loadProjectMemory, type ProjectMemory } from './project.js';

/**
 * Orquesta las 3 capas de memoria de Stratum.
 *
 * Hito 2 — solo la Capa 1 está activa (STRATUM.md proyecto + global).
 * Capas 2 (decisions.json) y 3 (sqlite-vec) se implementan en Hito 5.
 */
export class MemoryManager {
  private memory: ProjectMemory;

  constructor(private readonly config: StratumConfig) {
    this.memory = loadProjectMemory(config);
  }

  /** Recarga la memoria desde disco (útil tras `/init` o edición manual). */
  reload(): void {
    this.memory = loadProjectMemory(this.config);
  }

  /** Devuelve el contenido bruto de la memoria de proyecto. */
  getProjectMemory(): ProjectMemory {
    return this.memory;
  }

  /**
   * Devuelve el bloque de memoria listo para inyectar en el system prompt.
   * El orden es: global primero, proyecto al final (mayor prioridad).
   * Devuelve string vacío si no hay ninguna capa activa.
   */
  getInjectableMemory(): string {
    const { globalContent, projectContent } = this.memory;
    const parts: string[] = [];

    if (globalContent) parts.push(globalContent);
    if (projectContent) parts.push(projectContent);

    return parts.join('\n\n---\n\n');
  }

  hasMemory(): boolean {
    return !!(this.memory.globalContent || this.memory.projectContent);
  }

  // --- Hito 5: stubs para Capas 2 y 3 ---

  /** (Hito 5) Persiste una decisión en decisions.json + sqlite-vec. */
  async storeDecision(_params: unknown): Promise<void> {
    throw new Error('storeDecision no está implementado hasta Hito 5.');
  }

  /** (Hito 5) Búsqueda semántica KNN en sqlite-vec. */
  async searchDecisions(_query: string): Promise<unknown[]> {
    throw new Error('searchDecisions no está implementado hasta Hito 5.');
  }
}
