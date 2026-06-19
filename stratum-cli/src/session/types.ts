import type { Message } from '../agent/types.js';

/**
 * Schema de sesión guardada — §12.6.
 * NUNCA incluye apiKey ni baseUrl del provider.
 */
export interface SessionContext {
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
}
