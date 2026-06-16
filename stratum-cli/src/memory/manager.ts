import type { StratumConfig } from '../config/schema.js';
import { loadProjectMemory, type ProjectMemory } from './project.js';
import { getDecisionMemory, type DecisionMemory } from './decision-memory.js';
import type { DecisionInput, DecisionRecord } from './decisions.js';

/**
 * Orquesta las 3 capas de memoria de Stratum.
 *
 * Capa 1 — STRATUM.md proyecto + global (Hito 2).
 * Capas 2 (decisions.json) y 3 (vectores semánticos) — Hito 5, vía
 * `DecisionMemory`.
 */
export class MemoryManager {
  private memory: ProjectMemory;
  private decisions: DecisionMemory | null = null;

  constructor(private readonly config: StratumConfig) {
    this.memory = loadProjectMemory(config);
  }

  /** Acceso perezoso a las Capas 2/3 (carga el modelo de embeddings al usarse). */
  getDecisionMemory(): DecisionMemory {
    if (!this.decisions) this.decisions = getDecisionMemory(this.config);
    return this.decisions;
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

  // --- Capas 2 y 3 (Hito 5) ---

  /** Persiste una decisión en decisions.json + índice vectorial (con dedup). */
  async storeDecision(params: DecisionInput): Promise<DecisionRecord> {
    const result = await this.getDecisionMemory().save(params);
    return result.record;
  }

  /** Búsqueda semántica KNN de decisiones. */
  async searchDecisions(query: string, k?: number): Promise<DecisionRecord[]> {
    const results = await this.getDecisionMemory().search(query, k);
    return results.map((r) => r.record);
  }
}
