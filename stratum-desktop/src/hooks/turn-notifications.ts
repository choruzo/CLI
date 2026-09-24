/**
 * Qué merece una notificación del sistema (D6). Puro: recibe tramas del
 * sidecar con su instante y devuelve lo que habría que notificar; si procede
 * según la ventana (foco, minimizada…) lo decide Rust (`os_notify`).
 *
 * - Una respuesta que tarda al menos `minSeconds` desde que el usuario la pidió
 *   (incluida la espera en cola: es tiempo que el usuario ha esperado). Una
 *   cancelada no se notifica: la canceló el propio usuario.
 * - El agente espera al usuario (confirmación o preguntas): se notifica siempre,
 *   porque el turno queda parado y la confirmación caduca sola a los 5 min.
 */

export type NotificationRequest =
  | { kind: 'turn'; conversationId: string; elapsedMs: number; stopReason: string }
  | { kind: 'attention'; conversationId: string; what: 'confirm' | 'questions' };

export class TurnWatch {
  /** turnId → instante en que se vio por primera vez (cola o inicio). */
  private readonly started = new Map<string, number>();

  onFrame(
    frame: Record<string, unknown>,
    now: number,
    minSeconds: number,
  ): NotificationRequest | null {
    const conversationId = typeof frame.conversationId === 'string' ? frame.conversationId : null;
    if (!conversationId) return null;
    const turnId = typeof frame.turnId === 'string' ? frame.turnId : null;
    switch (frame.type) {
      case 'turn_queued':
      case 'turn_started':
        if (turnId && !this.started.has(turnId)) this.started.set(turnId, now);
        return null;
      case 'turn_ended': {
        if (!turnId) return null;
        const since = this.started.get(turnId);
        this.started.delete(turnId);
        // Un turno que empezó antes de que el webview lo viera (recarga): sin
        // medida fiable, no se notifica.
        if (since === undefined) return null;
        const stopReason = typeof frame.stopReason === 'string' ? frame.stopReason : 'stop';
        if (stopReason === 'cancelled') return null;
        const elapsedMs = now - since;
        if (elapsedMs < minSeconds * 1000) return null;
        return { kind: 'turn', conversationId, elapsedMs, stopReason };
      }
      case 'confirm_request':
        return { kind: 'attention', conversationId, what: 'confirm' };
      case 'questions_request':
        return { kind: 'attention', conversationId, what: 'questions' };
      default:
        return null;
    }
  }

  /** Conexión perdida: los turnos en vuelo no van a terminar. */
  reset(): void {
    this.started.clear();
  }
}

export function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${m} min` : `${m} min ${rest} s`;
}

/** Título y cuerpo de la notificación. */
export function notificationText(
  req: NotificationRequest,
  conversationTitle: string | null,
): { title: string; body: string } {
  const title = conversationTitle?.trim() ? `Stratum · ${conversationTitle.trim()}` : 'Stratum';
  if (req.kind === 'attention') {
    return {
      title,
      body:
        req.what === 'confirm'
          ? 'El agente espera tu confirmación para continuar.'
          : 'El agente tiene preguntas para ti.',
    };
  }
  const elapsed = formatElapsed(req.elapsedMs);
  switch (req.stopReason) {
    case 'error':
      return { title, body: `La respuesta terminó con un error (${elapsed}).` };
    case 'max_iterations':
    case 'budget_tokens':
      return { title, body: `La respuesta se detuvo al llegar al límite (${elapsed}).` };
    default:
      return { title, body: `Respuesta lista (${elapsed}).` };
  }
}
