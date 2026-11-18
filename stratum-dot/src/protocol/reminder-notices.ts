/**
 * M21 — qué avisar al sistema cuando llega la hora de un recordatorio
 * (`docs/protocol.md` §30). Todo puro: de los eventos sin validar de la
 * suscripción `overview` salen los `reminder.due` que valen, y de ahí el aviso.
 * Quién lo muestra es el lado nativo (`notify.rs`), por el mismo camino que el
 * de una rutina. Un aviso **solo informa**: no lleva acciones, no aprueba nada
 * y no entra en la conversación.
 */
import { reminderSchema } from '../../../stratum-cli/src/protocol/schemas';
import type { ProtocolReminder } from './index';

/** El título del aviso, siempre el mismo: lo que cambia es el cuerpo. */
export const REMINDER_NOTICE_TITLE = 'Reminder';

export interface ReminderNotice {
  reminderId: string;
  title: string;
  body: string;
}

/**
 * Los `reminder.due` que valen, de un lote de eventos sin validar. Lo que no
 * trae el recordatorio o no valida con `reminderSchema` se ignora: un aviso que
 * no se puede leer no se muestra.
 */
export function reminderDueEvents(raws: readonly unknown[]): ProtocolReminder[] {
  const out: ProtocolReminder[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as { type?: unknown; data?: unknown };
    if (event.type !== 'reminder.due') continue;
    const parsed = reminderSchema.safeParse((event.data as { reminder?: unknown } | null)?.reminder);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** `HH:MM` en hora local, siempre de 24 h: `toLocaleTimeString` daría «09:30 PM» en un sistema en inglés. */
function clock(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * El aviso de un recordatorio entregado: título «Reminder», el texto del aviso
 * y, si se entregó tarde (el daemon estaba apagado), cuándo tocaba.
 */
export function buildReminderNotice(reminder: ProtocolReminder): ReminderNotice {
  const late = reminder.late === true ? ` (late: was due ${clock(reminder.dueAt)})` : '';
  return {
    reminderId: reminder.id,
    title: REMINDER_NOTICE_TITLE,
    body: `${reminder.text}${late}`,
  };
}
