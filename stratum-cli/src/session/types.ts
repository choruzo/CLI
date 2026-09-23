import type { Message } from '../agent/types.js';

/**
 * Schema de sesión guardada — §12.6.
 * NUNCA incluye apiKey ni baseUrl del provider.
 */
export interface SessionContext {
  /**
   * Versión del formato (15.6, `config/schema-version.ts`). Ausente en sesiones
   * anteriores a Stratum Desktop, que equivalen a la versión 1.
   */
  schemaVersion?: number;
  id: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  provider: string; // nombre del provider (e.g. "local-ollama")
  model: string;
  project: string; // cwd absoluto al momento de crear la sesión
  messages: Message[];
  toolCallCount: number;
  summary: string; // resumen ≤100 chars (vacío si < 5 rondas)
  /**
   * Hito 7 — ref al fichero de plan asociado (relativo a `.stratum/plans/`).
   * Permite reanudar un plan interrumpido al hacer `stratum chat --resume` (§12.6).
   */
  planRef?: string;
  /**
   * Hito 15 — perfil activo como agente principal (`/agent <perfil>`) al
   * guardar. `chat --resume` y `/sessions resume` lo reaplican.
   */
  activeAgent?: string;
  /**
   * Hito 17 — la sesión estaba en modo read-only. `chat --resume` la reabre
   * read-only: reanudar no puede ser la forma de salir de él sin decirlo.
   */
  readOnly?: boolean;
  /** Hito 17 — perfil de sesión pedido (`auto`, `code`, `infra`…). */
  sessionProfile?: string;
}
