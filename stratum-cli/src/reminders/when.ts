/**
 * M21 — la hora que pide el agente para un recordatorio (`docs/protocol.md` §30).
 *
 * El `companion` no calcula fechas: dice «en 25 minutos» o «el 18/11 a las
 * 09:00», y esto lo resuelve. Siempre en la **hora local del equipo**, la del
 * proceso del daemon: no se inventa una zona fija, que un «mañana a las 9»
 * caería a otra hora. Módulo puro: el reloj entra por parámetro.
 */
import { REMINDER_LIMITS } from '../protocol/index.js';

/** Una entrada que no se puede resolver (hora imposible, fecha inexistente, nada…). */
export class ReminderWhenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReminderWhenError';
  }
}

export interface ReminderWhenInput {
  /** Entero: minutos desde ahora. */
  inMinutes?: number;
  /** `YYYY-MM-DD` en hora local. Por defecto hoy (mañana si la hora ya pasó). */
  date?: string;
  /** `HH:MM` en hora local. */
  time?: string;
}

/** La hora resuelta, con el texto que lee la persona. */
export interface ReminderWhen {
  /** Cuándo vence (ms). */
  dueAt: number;
  /** «hoy a las 21:30 (en 25 min)», «mañana 18/11 a las 09:00», «el 20/11 a las 09:00». */
  text: string;
  /** Qué día es, en hora local (para quien lo pinte en otro idioma). */
  day: 'today' | 'tomorrow' | 'later';
  /** `DD/MM` en local. */
  dayLabel: string;
  /** `HH:MM` en local. */
  clock: string;
}

const MINUTES_HINT = `"inMinutes" (how many minutes from now) or "time" ("HH:MM" in local time), with an optional "date" ("YYYY-MM-DD")`;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Medianoche local de ese instante: los días se cuentan por calendario, no por horas. */
function localDayKey(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clockOf(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Cómo se cuenta una hora ya resuelta: en hora local, con el día dicho y, si
 * cae en la próxima hora, cuánto falta.
 */
export function describeWhen(dueAt: number, now: number): ReminderWhen {
  const due = new Date(dueAt);
  const days = Math.round((localDayKey(dueAt) - localDayKey(now)) / 86_400_000);
  const day: ReminderWhen['day'] = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : 'later';
  const dayLabel = `${pad2(due.getDate())}/${pad2(due.getMonth() + 1)}`;
  const clock = clockOf(due);
  const minutes = Math.round((dueAt - now) / 60_000);
  const soon = day === 'today' && minutes >= 1 && minutes <= 60 ? ` (en ${minutes} min)` : '';
  const text =
    day === 'today'
      ? `hoy a las ${clock}${soon}`
      : day === 'tomorrow'
        ? `mañana ${dayLabel} a las ${clock}`
        : `el ${dayLabel} a las ${clock}`;
  return { dueAt, text, day, dayLabel, clock };
}

/**
 * Resuelve lo que pidió el agente a un instante concreto, en hora local.
 *
 * @throws ReminderWhenError con un mensaje que se puede dar tal cual al agente.
 */
export function resolveWhen(input: ReminderWhenInput, now: number): ReminderWhen {
  const hasMinutes = input.inMinutes !== undefined;
  const hasTime = input.time !== undefined;
  const hasDate = input.date !== undefined;

  if (!hasMinutes && !hasTime) {
    throw new ReminderWhenError(`Say when the reminder has to fire: ${MINUTES_HINT}.`);
  }
  if (hasMinutes && (hasTime || hasDate)) {
    throw new ReminderWhenError(
      `Give either "inMinutes" or "date"/"time", not both: the reminder has one time.`,
    );
  }

  const dueAt = hasMinutes ? fromMinutes(input.inMinutes as number, now) : fromClock(input, now);
  assertLead(dueAt, now);
  return describeWhen(dueAt, now);
}

function fromMinutes(minutes: number, now: number): number {
  if (!Number.isInteger(minutes)) {
    throw new ReminderWhenError(
      `"inMinutes" has to be a whole number of minutes (got ${minutes}).`,
    );
  }
  if (minutes * 60_000 < REMINDER_LIMITS.minLeadMs) {
    throw new ReminderWhenError(`"inMinutes" has to be at least 1 minute.`);
  }
  if (minutes * 60_000 > REMINDER_LIMITS.maxLeadMs) {
    throw new ReminderWhenError(`"inMinutes" cannot be more than a year ahead.`);
  }
  return now + minutes * 60_000;
}

function fromClock(input: ReminderWhenInput, now: number): number {
  const { hour, minute, clock } = parseClock(input.time as string);
  // Sin fecha y con ella, el mismo camino: el día se construye en hora local y
  // el cambio de hora se resuelve ahí (`localInstants`).
  if (input.date !== undefined) {
    const { year, month, day } = parseDate(input.date);
    const dueAt = localInstants(year, month - 1, day, hour, minute, input.date).find(
      (ts) => ts > now,
    );
    if (dueAt === undefined) {
      throw new ReminderWhenError(
        `That time is in the past: ${input.date} ${clock} — pick a time still to come.`,
      );
    }
    return dueAt;
  }
  // Sin fecha: hoy a esa hora y, si ya pasó, mañana.
  const today = new Date(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  for (const day of [today, tomorrow]) {
    const label = `${pad2(day.getDate())}/${pad2(day.getMonth() + 1)}`;
    const future = localInstants(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      hour,
      minute,
      label,
    ).find((ts) => ts > now);
    if (future !== undefined) return future;
  }
  throw new ReminderWhenError(`That time is in the past — pick a time still to come.`);
}

/**
 * El instante local que pide `hour:minute` en ese día, teniendo en cuenta el
 * cambio de hora:
 *  - una hora que **no existe** (salto de marzo) es un error, no otra hora;
 *  - una hora que existe **dos veces** (retroceso de octubre) da sus dos
 *    instantes, del primero al segundo: quien llama se queda con el primero que
 *    sea futuro.
 */
function localInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  label: string,
): number[] {
  const sameWallClock = (ts: number): boolean => {
    const d = new Date(ts);
    return d.getHours() === hour && d.getMinutes() === minute;
  };
  const first = new Date(year, month, day, hour, minute, 0, 0).getTime();
  if (!sameWallClock(first)) {
    throw new ReminderWhenError(
      `That time does not exist on ${label}: it is the hour the clocks change that day.`,
    );
  }
  const instants = [first];
  // `Date` da la primera de las dos; la segunda es una hora después, si el reloj
  // vuelve a marcar lo mismo.
  const second = first + 3_600_000;
  if (sameWallClock(second)) instants.push(second);
  return instants;
}

function parseClock(text: string): { hour: number; minute: number; clock: string } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  const bad = (why: string): ReminderWhenError =>
    new ReminderWhenError(`Invalid time "${text}": ${why}. Use HH:MM in 24-hour local time.`);
  if (!match) throw bad('it is not HH:MM');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23) throw bad('hours go from 00 to 23');
  if (minute > 59) throw bad('minutes go from 00 to 59');
  return { hour, minute, clock: `${pad2(hour)}:${pad2(minute)}` };
}

function parseDate(text: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) {
    throw new ReminderWhenError(`Invalid date "${text}": use YYYY-MM-DD, e.g. "2026-11-18".`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // `Date` normaliza el 30 de febrero al 2 de marzo: si no vuelve igual, ese día no existe.
  const at = new Date(year, month - 1, day);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) {
    throw new ReminderWhenError(`Invalid date "${text}": there is no such day.`);
  }
  return { year, month, day };
}

function assertLead(dueAt: number, now: number): void {
  const lead = dueAt - now;
  if (lead < REMINDER_LIMITS.minLeadMs) {
    throw new ReminderWhenError(
      `That time is less than a minute away: a reminder has to be at least 1 minute ahead.`,
    );
  }
  if (lead > REMINDER_LIMITS.maxLeadMs) {
    throw new ReminderWhenError(`That time is more than a year away: pick something sooner.`);
  }
}
