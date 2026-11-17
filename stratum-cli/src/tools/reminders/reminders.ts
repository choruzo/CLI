/**
 * M21 — los recordatorios del `companion` (`docs/protocol.md` §30): avisar a la
 * persona de algo a una hora. No es trabajo autónomo: el aviso solo informa, así
 * que crearlo **no** se confirma (lo pidió el usuario); lo que hay que *hacer* a
 * esa hora es una rutina (`propose_routine`, que sí se aprueba).
 *
 * Solo se registran si quien aloja la sesión da los recordatorios
 * (`ReminderBook`): en el daemon, solo la sesión principal del `companion`.
 * Los errores del almacén vuelven como resultado recuperable, como en
 * `propose_routine`.
 */
import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { REMINDER_LIMITS, type ProtocolReminder } from '../../protocol/index.js';
import { ReminderStoreError } from '../../reminders/store.js';
import { describeWhen, ReminderWhenError, resolveWhen } from '../../reminders/when.js';

export const SET_REMINDER_TOOL = 'set_reminder';
export const LIST_REMINDERS_TOOL = 'list_reminders';
export const CANCEL_REMINDER_TOOL = 'cancel_reminder';

export const REMINDER_TOOLS: readonly string[] = [
  SET_REMINDER_TOOL,
  LIST_REMINDERS_TOOL,
  CANCEL_REMINDER_TOOL,
];

/**
 * Lo que la sesión necesita de quien la aloja para los recordatorios. Todo lo
 * que mira el reloj recibe el `now` que ya resolvió la tool: la antelación se
 * valida una sola vez y con el mismo instante.
 */
export interface ReminderBook {
  /** Reloj local del proceso, para resolver «mañana a las 9». */
  now(): number;
  /** El fichero no se puede leer (de un Stratum más nuevo o dañado). */
  readOnly(): boolean;
  /** Crea uno de los del agente (`origin: 'agent'`). Lanza `ReminderStoreError`. */
  add(input: { text: string; dueAt: number; origin: 'agent' }, now: number): ProtocolReminder;
  /** Pendientes y terminados de la ventana, por `dueAt`. */
  list(now: number): ProtocolReminder[];
  /** Cancela uno pendiente. Lanza `ReminderStoreError`. */
  cancel(id: string, now: number): ProtocolReminder;
}

/** El fichero no se puede leer: se dice, en vez de fingir que no hay avisos. */
export const UNREADABLE_REMINDERS =
  "I can't read your reminders right now (the file is from a newer Stratum or is damaged).";

function recoverable(error: string): ToolResult {
  return { ok: false, error, recoverable: true, countsAsFailure: false };
}

/**
 * La hora en inglés, para quien lea el resultado: «today at 21:30»,
 * «tomorrow 18/11 at 09:00», «on 20/11 at 09:00».
 */
function englishWhen(when: ReturnType<typeof describeWhen>): string {
  if (when.day === 'today') return `today at ${when.clock}`;
  if (when.day === 'tomorrow') return `tomorrow ${when.dayLabel} at ${when.clock}`;
  return `on ${when.dayLabel} at ${when.clock}`;
}

const setSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(REMINDER_LIMITS.textChars)
    .describe('What to remind the user about, short and in their language'),
  inMinutes: z.number().optional().describe('How many minutes from now (integer), e.g. 25'),
  date: z
    .string()
    .optional()
    .describe('Local date YYYY-MM-DD; defaults to today (tomorrow if the time has passed)'),
  time: z.string().optional().describe('Local time HH:MM (24-hour), e.g. "09:00" or "21:30"'),
});

const cancelSchema = z.object({
  id: z.string().trim().min(1).describe('The reminder id, as returned by list_reminders'),
});

export function createReminderTools(book: ReminderBook): ToolDefinition[] {
  const setReminder: ToolDefinition = {
    name: SET_REMINDER_TOOL,
    description:
      'Remind the user of something at a time they name ("remind me tomorrow at 9 to call the ' +
      'doctor"). This only tells them: you do not wake up, run anything or come back to it. If ' +
      'something has to be DONE at that time (check the email, write a report), that is a routine ' +
      '(propose_routine), not a reminder. Use the local time of the user.',
    schema: setSchema,
    // Solo avisa a la persona: lo pidió el usuario, no hay nada que aprobar.
    destructive: false,
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const input = setSchema.parse(params);
      const now = book.now();
      let when: ReturnType<typeof describeWhen>;
      try {
        when = resolveWhen(input, now);
      } catch (err) {
        if (err instanceof ReminderWhenError) return recoverable(err.message);
        throw err;
      }
      try {
        const reminder = book.add({ text: input.text, dueAt: when.dueAt, origin: 'agent' }, now);
        return {
          ok: true,
          output: `Reminder set for ${englishWhen(when)} (${reminder.id}): ${reminder.text}`,
        };
      } catch (err) {
        if (err instanceof ReminderStoreError) {
          return recoverable(`The reminder was not set: ${err.message}`);
        }
        throw err;
      }
    },
  };

  const listReminders: ToolDefinition = {
    name: LIST_REMINDERS_TOOL,
    description:
      'The reminders still pending, with their id and their local time, soonest first. Use it ' +
      'before cancelling one or when the user asks what is coming up.',
    schema: z.object({}),
    destructive: false,
    async execute(): Promise<ToolResult> {
      const now = book.now();
      if (book.readOnly()) return recoverable(UNREADABLE_REMINDERS);
      const pending = book.list(now).filter((r) => r.status === 'pending');
      if (pending.length === 0) return { ok: true, output: 'There are no reminders pending.' };
      const lines = pending.map(
        (r) => `- ${r.id}: ${englishWhen(describeWhen(r.dueAt, now))} — ${r.text}`,
      );
      return {
        ok: true,
        output: `Pending reminders (${pending.length}):\n${lines.join('\n')}`,
      };
    },
  };

  const cancelReminder: ToolDefinition = {
    name: CANCEL_REMINDER_TOOL,
    description:
      'Cancel a pending reminder by its id. It does not come back: to move it, set a new one.',
    schema: cancelSchema,
    destructive: false,
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const input = cancelSchema.parse(params);
      const now = book.now();
      try {
        const reminder = book.cancel(input.id, now);
        return { ok: true, output: `Reminder cancelled (${reminder.id}): ${reminder.text}` };
      } catch (err) {
        if (err instanceof ReminderStoreError) {
          return recoverable(`The reminder was not cancelled: ${err.message}`);
        }
        throw err;
      }
    },
  };

  return [setReminder, listReminders, cancelReminder];
}
