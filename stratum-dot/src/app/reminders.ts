/**
 * M21 — los recordatorios del asistente (`docs/protocol.md` §30): refrescar la
 * lista y avisar cuando llega uno. Todo por el protocolo (vía el lado nativo),
 * sin estado supuesto: lo que se enseña es lo que contestó `reminders.list` o la
 * cancelación. **Nada de sondeo**: se refresca al abrir la vista, tras cancelar
 * y cuando llega un `reminder.due` por `overview`.
 */
import type { NativeBridge } from '../bridge/native';
import { toCommandError, type CommandError } from '../bridge/native';
import type { ProtocolReminder } from '../protocol';
import { buildReminderNotice, reminderDueEvents } from '../protocol/reminder-notices';
import { parseReminders } from '../protocol/results';
import { NoticeLedger } from '../protocol/routine-notices';
import { useReminders } from '../stores/reminderStore';
import { describeCommandError } from './actions';

let sequence = 0;

/** Los recordatorios ya avisados (memoria): uno se avisa una sola vez. */
const ledger = new NoticeLedger();
/** Los avisos en camino: una segunda copia del `reminder.due` no lo duplica. */
const underway = new Set<string>();

/** Para los tests: olvida lo avisado. */
export function resetReminderWatch(): void {
  ledger.clear();
  underway.clear();
  sequence = 0;
}

/**
 * Pide `reminders.list` y la guarda. Devuelve la lista, o `null` si falló (y
 * entonces el store conserva la última conocida con el error al lado). Una
 * respuesta tardía de un refresco anterior no pisa a la de uno posterior.
 */
export async function refreshReminders(native: NativeBridge): Promise<ProtocolReminder[] | null> {
  const mine = ++sequence;
  const store = useReminders.getState();
  store.setLoading(true);
  try {
    const list = parseReminders(await native.remindersList());
    if (mine !== sequence) return useReminders.getState().reminders;
    if (!list) {
      useReminders.getState().setFailure('The daemon answered in a way this version of Dot cannot read.', false);
      return null;
    }
    useReminders.getState().setList(list.reminders, list.readOnly);
    return list.reminders;
  } catch (err) {
    if (mine === sequence) {
      const error = toCommandError(err);
      useReminders.getState().setFailure(describeReminderError(error), error.reason === 'reminders-disabled');
    }
    return null;
  } finally {
    if (mine === sequence) useReminders.getState().setLoading(false);
  }
}

/** El texto de un error de recordatorios: lo del daemon, con sus casos conocidos explicados. */
export function describeReminderError(error: CommandError): string {
  if (error.reason === 'reminders-disabled') {
    return 'Reminders are not enabled in this daemon: it has no scheduler.';
  }
  if (error.reason === 'read-only') {
    return 'The reminders file was written by a newer Stratum or is damaged: reminders can be seen but not cancelled.';
  }
  if (error.code === 'NOT_FOUND') return 'That reminder no longer exists.';
  if (error.code === 'INVALID_PARAMS') return 'That reminder was already delivered or cancelled.';
  if (error.kind === 'unknown') {
    return 'Result unknown: the daemon did not answer in time. Check the list before trying again.';
  }
  return describeCommandError(error);
}

/**
 * Llega un lote de eventos (de la suscripción `overview` o de una sesión). Si
 * trae un `reminder.due` que valida, se refresca la lista y se avisa al
 * sistema, una sola vez por recordatorio. Nunca se resuelve nada.
 */
export function watchReminderDue(native: NativeBridge, raws: readonly unknown[]): void {
  const due = reminderDueEvents(raws);
  if (due.length === 0) return;
  // Sin sondeo: la lista se refresca porque algo cambió, no cada poco.
  void refreshReminders(native);
  // Siempre se avisa, aunque la pestaña esté delante: un aviso que solo pasa de
  // «pendiente» a «Recent» en la lista se pierde (a diferencia del fin de una rutina).
  for (const reminder of due) {
    if (underway.has(reminder.id)) continue;
    underway.add(reminder.id);
    try {
      if (!ledger.take(reminder.id)) continue;
      const notice = buildReminderNotice(reminder);
      void native
        .notifyReminder(notice.title, notice.body)
        .catch(() => undefined)
        .finally(() => underway.delete(reminder.id));
    } catch {
      underway.delete(reminder.id);
    }
  }
}
