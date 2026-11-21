/**
 * M23 — los avisos de degradación del asistente (`health.notice`): cuando llega
 * uno que valida, se avisa al sistema, una sola vez por aviso. Solo informa:
 * pulsarlo abre la pestaña *Health* de la vista *Asistente*, que pide su propio
 * diagnóstico al abrirse (`doctor.run`). Nada de sondeo ni de resolver nada.
 */
import type { NativeBridge } from '../bridge/native';
import { buildHealthNotice, healthNoticeEvents } from '../protocol/health-notices';
import { NoticeLedger } from '../protocol/routine-notices';

/** Los avisos ya enviados (memoria): uno se avisa una sola vez. */
const ledger = new NoticeLedger();
/** Los avisos en camino: una segunda copia del mismo `health.notice` no lo duplica. */
const underway = new Set<string>();

/** Para los tests: olvida lo avisado. */
export function resetHealthWatch(): void {
  ledger.clear();
  underway.clear();
}

/**
 * Llega un lote de eventos (de la suscripción `overview` o de una sesión). Si
 * trae un `health.notice` que valida, se avisa al sistema, una sola vez por
 * aviso.
 */
export function watchHealthNotices(native: NativeBridge, raws: readonly unknown[]): void {
  for (const raw of healthNoticeEvents(raws)) {
    const notice = buildHealthNotice(raw);
    if (underway.has(notice.key)) continue;
    underway.add(notice.key);
    try {
      if (!ledger.take(notice.key)) continue;
      void native
        .notifyHealth(notice.title, notice.body)
        .catch(() => undefined)
        .finally(() => underway.delete(notice.key));
    } catch {
      underway.delete(notice.key);
    }
  }
}
