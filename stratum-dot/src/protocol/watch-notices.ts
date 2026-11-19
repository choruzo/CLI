/**
 * M22 — qué avisar al sistema cuando un vigilante salta, se resuelve, no puede
 * mirar o queda suspendido (`docs/protocol.md` §31). Todo puro: de los eventos
 * sin validar de la suscripción `overview` salen los `watch.notice` que valen, y
 * de ahí el aviso. Quién lo muestra es el lado nativo (`notify.rs`), por el
 * mismo camino que el de un recordatorio. Un aviso **solo informa**: sin
 * acciones, no aprueba nada y no entra en la conversación. El texto lo compuso
 * el daemon con una plantilla (ya neutralizado y acotado).
 */
import { watchNoticeSchema } from '../../../stratum-cli/src/protocol/schemas';
import type { ProtocolWatchNotice } from './index';

export interface WatchNotice {
  /** Identifica el aviso para no repetirlo: vigilante, clase y momento. */
  key: string;
  title: string;
  body: string;
}

/**
 * Los `watch.notice` que valen, de un lote de eventos sin validar. Lo que no
 * trae el aviso o no valida con `watchNoticeSchema` se ignora.
 */
export function watchNoticeEvents(raws: readonly unknown[]): ProtocolWatchNotice[] {
  const out: ProtocolWatchNotice[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as { type?: unknown; data?: unknown };
    if (event.type !== 'watch.notice') continue;
    const parsed = watchNoticeSchema.safeParse((event.data as { notice?: unknown } | null)?.notice);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** El título según la clase del aviso. */
function titleOf(notice: ProtocolWatchNotice): string {
  switch (notice.kind) {
    case 'resolved':
      return `Watch resolved · ${notice.name}`;
    case 'failing':
      return `Watch cannot check · ${notice.name}`;
    case 'suspended':
      return `Watch paused by Stratum · ${notice.name}`;
    default:
      return `Watch · ${notice.name}`;
  }
}

export function buildWatchNotice(notice: ProtocolWatchNotice): WatchNotice {
  return {
    key: `${notice.watchId}:${notice.kind}:${notice.at}`,
    title: titleOf(notice),
    body: notice.text,
  };
}
