/**
 * M23 — qué avisar al sistema cuando el asistente se degrada (la credencial de
 * un conector rechazada, un conector que no responde, la caja con una imagen
 * anterior) o vuelve a funcionar (`health.notice`, `docs/protocol.md`). Todo
 * puro: de los eventos sin validar de la suscripción `overview` salen los
 * `health.notice` que valen, y de ahí el aviso. Quién lo muestra es el lado
 * nativo (`notify.rs`), por el mismo camino que el de un vigilante. Un aviso
 * **solo informa**: sin acciones y sin entrar en la conversación. El texto lo
 * compuso el daemon con una plantilla (ya neutralizado y acotado).
 */
import { healthNoticeSchema } from '../../../stratum-cli/src/protocol/schemas';
import type { ProtocolHealthNotice } from './index';

export interface HealthNotice {
  /** Identifica el aviso para no repetirlo: causa, clase y momento. */
  key: string;
  title: string;
  body: string;
}

/**
 * Los `health.notice` que valen, de un lote de eventos sin validar. Lo que no
 * trae el aviso o no valida con `healthNoticeSchema` se ignora.
 */
export function healthNoticeEvents(raws: readonly unknown[]): ProtocolHealthNotice[] {
  const out: ProtocolHealthNotice[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as { type?: unknown; data?: unknown };
    if (event.type !== 'health.notice') continue;
    const parsed = healthNoticeSchema.safeParse((event.data as { notice?: unknown } | null)?.notice);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** El título según la clase y el área del aviso. */
function titleOf(notice: ProtocolHealthNotice): string {
  if (notice.kind === 'recovered') return 'Assistant · working again';
  return notice.area === 'box' ? 'Assistant · the box needs attention' : 'Assistant · a connector needs attention';
}

export function buildHealthNotice(notice: ProtocolHealthNotice): HealthNotice {
  return {
    key: `${notice.cause}:${notice.kind}:${notice.at}`,
    title: titleOf(notice),
    body: notice.text,
  };
}
