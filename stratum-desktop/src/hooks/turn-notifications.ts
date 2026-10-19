/**
 * Qué merece una notificación del sistema (D6, M12). Puro: compara dos fotos
 * de conjunto y devuelve lo que habría que notificar; si procede según la
 * ventana (foco, minimizada…) lo decide Rust (`os_notify`).
 *
 * Solo de las sesiones que se iniciaron desde Desktop (`origin`): las de la
 * terminal o de Dot avisan donde viven.
 *
 * - Un run que tarda al menos `minSeconds` desde que Desktop lo vio empezar.
 *   Uno que se canceló no se notifica (lo sabe quien lo canceló).
 * - La sesión espera a una persona (aprobación, preguntas, plan): siempre.
 */
import type { ProtocolOverviewSnapshot, ProtocolSession } from '../protocol';

export type NotificationRequest =
  | { kind: 'turn'; sessionId: string; elapsedMs: number }
  | { kind: 'attention'; sessionId: string };

export class TurnWatch {
  /** sessionId → (runId, instante en que se vio empezar). */
  private readonly started = new Map<string, { runId: string; at: number }>();
  private waiting = new Map<string, number>();

  onOverview(
    next: ProtocolOverviewSnapshot,
    now: number,
    minSeconds: number,
  ): NotificationRequest[] {
    const out: NotificationRequest[] = [];
    const counts = new Map<string, number>();
    for (const req of [...next.approvals, ...next.questions, ...next.plans]) {
      counts.set(req.sessionId, (counts.get(req.sessionId) ?? 0) + 1);
    }
    const mine = (s: ProtocolSession) => s.origin === 'desktop';
    for (const session of next.sessions) {
      if (!mine(session)) continue;
      const seen = this.started.get(session.id);
      if (session.currentRunId) {
        if (seen?.runId !== session.currentRunId) {
          this.started.set(session.id, { runId: session.currentRunId, at: now });
        }
      } else if (seen) {
        this.started.delete(session.id);
        const elapsedMs = now - seen.at;
        // Un run que acabó cancelado no se notifica: lo canceló alguien a propósito.
        if (session.state !== 'closed' && elapsedMs >= minSeconds * 1000) {
          out.push({ kind: 'turn', sessionId: session.id, elapsedMs });
        }
      }
      const count = counts.get(session.id) ?? 0;
      if (count > (this.waiting.get(session.id) ?? 0)) out.push({ kind: 'attention', sessionId: session.id });
    }
    this.waiting = counts;
    for (const id of [...this.started.keys()]) {
      if (!next.sessions.some((s) => s.id === id)) this.started.delete(id);
    }
    return out;
  }

  /** Conexión perdida: lo que estaba en vuelo no se puede medir. */
  reset(): void {
    this.started.clear();
    this.waiting.clear();
  }
}
