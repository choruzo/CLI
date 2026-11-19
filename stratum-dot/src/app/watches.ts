/**
 * M22 — los vigilantes del asistente (`docs/protocol.md` §31): refrescar la
 * lista, pausar, reanudar, quitar y avisar cuando uno habla. Todo por el
 * protocolo (vía el lado nativo), sin estado supuesto: lo que se enseña es lo
 * que contestó `watches.list`. **Nada de sondeo**: se refresca al abrir la
 * vista, tras cada acción y cuando llega un `watch.notice` por `overview`.
 * Crear vigilantes no está en Dot (exige `approve`).
 */
import type { NativeBridge } from '../bridge/native';
import { toCommandError, type CommandError } from '../bridge/native';
import type { ProtocolWatch } from '../protocol';
import { parseWatchResult, parseWatches } from '../protocol/results';
import { NoticeLedger } from '../protocol/routine-notices';
import { buildWatchNotice, watchNoticeEvents } from '../protocol/watch-notices';
import { useWatches } from '../stores/watchStore';
import { describeCommandError } from './actions';

let sequence = 0;

/** Los avisos ya enviados (memoria): uno se avisa una sola vez. */
const ledger = new NoticeLedger();
/** Los avisos en camino: una segunda copia del mismo `watch.notice` no lo duplica. */
const underway = new Set<string>();

/** Para los tests: olvida lo avisado. */
export function resetWatchWatch(): void {
  ledger.clear();
  underway.clear();
  sequence = 0;
}

/**
 * Pide `watches.list` y la guarda. Devuelve la lista, o `null` si falló (y
 * entonces el store conserva la última conocida con el error al lado). Una
 * respuesta tardía de un refresco anterior no pisa a la de uno posterior.
 */
export async function refreshWatches(native: NativeBridge): Promise<ProtocolWatch[] | null> {
  const mine = ++sequence;
  useWatches.getState().setLoading(true);
  try {
    const list = parseWatches(await native.watchesList());
    if (mine !== sequence) return useWatches.getState().watches;
    if (!list) {
      useWatches.getState().setFailure('The daemon answered in a way this version of Dot cannot read.', false);
      return null;
    }
    useWatches.getState().setList(list.watches, list.readOnly);
    return list.watches;
  } catch (err) {
    if (mine === sequence) {
      const error = toCommandError(err);
      useWatches.getState().setFailure(describeWatchError(error), error.reason === 'watches-disabled');
    }
    return null;
  } finally {
    if (mine === sequence) useWatches.getState().setLoading(false);
  }
}

/** El texto de un error de vigilantes: lo del daemon, con sus casos conocidos explicados. */
export function describeWatchError(error: CommandError): string {
  if (error.reason === 'watches-disabled') {
    return 'Watches are not enabled in this daemon: it has no scheduler.';
  }
  if (error.reason === 'read-only') {
    return 'The watches file was written by a newer Stratum or is damaged: watches can be seen but not changed.';
  }
  if (error.code === 'NOT_FOUND') return 'That watch no longer exists.';
  if (error.kind === 'unknown') {
    return 'Result unknown: the daemon did not answer in time. Check the list before trying again.';
  }
  return describeCommandError(error);
}

export type WatchAction = 'pause' | 'resume' | 'remove';

/**
 * Pausa, reanuda o quita un vigilante. Devuelve un texto si algo falló (nada si
 * fue bien) y, en cualquier caso, vuelve a pedir la lista: sin optimismo. Un
 * resultado desconocido se dice y no se reintenta.
 */
export async function changeWatch(
  native: NativeBridge,
  action: WatchAction,
  watchId: string,
): Promise<string | null> {
  let failure: string | null = null;
  try {
    const raw =
      action === 'pause'
        ? await native.watchesPause(watchId)
        : action === 'resume'
          ? await native.watchesResume(watchId)
          : await native.watchesRemove(watchId);
    if (!parseWatchResult(raw)) failure = 'The daemon answered in a way this version of Dot cannot read.';
  } catch (err) {
    failure = describeWatchError(toCommandError(err));
  }
  await refreshWatches(native);
  return failure;
}

export const pauseWatch = (native: NativeBridge, watchId: string) => changeWatch(native, 'pause', watchId);
export const resumeWatch = (native: NativeBridge, watchId: string) => changeWatch(native, 'resume', watchId);
export const removeWatch = (native: NativeBridge, watchId: string) => changeWatch(native, 'remove', watchId);

/**
 * Llega un lote de eventos (de la suscripción `overview` o de una sesión). Si
 * trae un `watch.notice` que valida, se refresca la lista y se avisa al
 * sistema, una sola vez por aviso. Nunca se resuelve nada.
 */
export function watchWatchNotices(native: NativeBridge, raws: readonly unknown[]): void {
  const notices = watchNoticeEvents(raws);
  if (notices.length === 0) return;
  // Sin sondeo: la lista se refresca porque algo cambió (firing, health), no cada poco.
  void refreshWatches(native);
  for (const raw of notices) {
    const notice = buildWatchNotice(raw);
    if (underway.has(notice.key)) continue;
    underway.add(notice.key);
    try {
      if (!ledger.take(notice.key)) continue;
      void native
        .notifyWatch(notice.title, notice.body)
        .catch(() => undefined)
        .finally(() => underway.delete(notice.key));
    } catch {
      underway.delete(notice.key);
    }
  }
}
