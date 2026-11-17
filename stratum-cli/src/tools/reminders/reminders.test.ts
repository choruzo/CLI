/**
 * M21 — las tools de los recordatorios del `companion`: crear (sin
 * confirmación), listar y cancelar, con los errores del almacén como resultado
 * recuperable, y su registro solo con `reminders`.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext, ToolDefinition, ToolResult } from '../../agent/types.js';
import { COMPANION_TOOLS } from '../../agent/presets.js';
import { StratumConfigSchema } from '../../config/schema.js';
import { REMINDER_LIMITS, type ProtocolReminder } from '../../protocol/index.js';
import { ReminderStore, ReminderStoreError } from '../../reminders/store.js';
import { buildCompanionRegistry } from '../../host/companion.js';
import {
  CANCEL_REMINDER_TOOL,
  createReminderTools,
  LIST_REMINDERS_TOOL,
  REMINDER_TOOLS,
  SET_REMINDER_TOOL,
  type ReminderBook,
} from './reminders.js';

const ctx = {} as ToolContext;
// 17/11/2026 a las 21:05, hora local: las horas de los tests son las del equipo.
const NOW = new Date(2026, 10, 17, 21, 5, 0, 0).getTime();
const MIN = 60_000;

function book(
  now = NOW,
  readonly = false,
): ReminderBook & { added: ProtocolReminder[]; setReadOnly: (v: boolean) => void } {
  const added: ProtocolReminder[] = [];
  const state = { readOnly: readonly };
  let n = 0;
  return {
    added,
    now: () => now,
    readOnly: () => state.readOnly,
    setReadOnly: (v: boolean) => {
      state.readOnly = v;
    },
    add: (input) => {
      const reminder: ProtocolReminder = {
        id: `rem_${++n}`,
        text: input.text,
        dueAt: input.dueAt,
        createdAt: now,
        origin: input.origin,
        status: 'pending',
      };
      added.push(reminder);
      return reminder;
    },
    list: () => [...added],
    cancel: (id) => {
      const i = added.findIndex((r) => r.id === id);
      if (i === -1) throw new ReminderStoreError('not-found', `Reminder "${id}" not found.`);
      const [current] = added.splice(i, 1);
      return { ...current!, status: 'cancelled' };
    },
  };
}

/** El texto de un resultado que salió bien (y falla el test si no). */
function output(result: ToolResult): string {
  if (!result.ok) throw new Error(`the tool failed: ${result.error}`);
  return result.output;
}

/** El resultado que falló, ya estrechado. */
function failure(result: ToolResult): {
  error: string;
  recoverable?: boolean;
  countsAsFailure?: boolean;
} {
  if (result.ok) throw new Error(`expected a failure, got: ${result.output}`);
  return result;
}

function toolOf(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

describe('M21 — set_reminder', () => {
  it('crea con origin agent, sin confirmación, y contesta con la hora resuelta', async () => {
    const b = book();
    const tool = toolOf(createReminderTools(b), SET_REMINDER_TOOL);
    // Solo avisa a la persona: nada que aprobar.
    expect(tool.destructive).toBe(false);
    expect(tool.confirmAlways).toBeUndefined();
    expect(tool.isDestructive).toBeUndefined();

    const result = await tool.execute({ text: 'llama al médico', time: '09:00' }, ctx);
    expect(output(result)).toBe(
      'Reminder set for tomorrow 18/11 at 09:00 (rem_1): llama al médico',
    );
    expect(b.added[0]).toMatchObject({
      origin: 'agent',
      dueAt: new Date(2026, 10, 18, 9, 0, 0, 0).getTime(),
    });
  });

  it('inMinutes y una fecha concreta', async () => {
    const b = book();
    const tool = toolOf(createReminderTools(b), SET_REMINDER_TOOL);
    expect(output(await tool.execute({ text: 'agua', inMinutes: 25 }, ctx))).toContain(
      'today at 21:30',
    );
    expect(
      output(await tool.execute({ text: 'informe', date: '2026-11-20', time: '09:00' }, ctx)),
    ).toContain('on 20/11 at 09:00');
  });

  it('la descripción dice que solo avisa, y que lo que hay que hacer es una rutina', () => {
    const tool = toolOf(createReminderTools(book()), SET_REMINDER_TOOL);
    expect(tool.description).toContain('Remind the user');
    expect(tool.description).toContain('propose_routine');
  });

  it.each([
    [{ text: 'x' }, 'Say when'],
    [{ text: 'x', time: '25:00' }, 'hours go from 00 to 23'],
    [{ text: 'x', date: '2026-02-30', time: '09:00' }, 'no such day'],
    [{ text: 'x', inMinutes: 3, time: '09:00' }, 'not both'],
  ])('una hora imposible %j vuelve como error recuperable', async (input, message) => {
    const b = book();
    const tool = toolOf(createReminderTools(b), SET_REMINDER_TOOL);
    const result = failure(await tool.execute(input, ctx));
    expect(result).toMatchObject({ recoverable: true, countsAsFailure: false });
    expect(result.error).toContain(message);
    expect(b.added).toEqual([]);
  });

  it('un fallo del almacén (solo lectura) también es recuperable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-reminders-tools-'));
    try {
      const store = new ReminderStore(join(dir, 'reminders.json'));
      store.load();
      const tool = toolOf(
        createReminderTools({
          now: () => NOW,
          readOnly: () => store.readOnly,
          add: (input, now) => store.add(input, now),
          list: (now) => store.list(now),
          cancel: (id, now) => store.cancel(id, now),
        }),
        SET_REMINDER_TOOL,
      );
      // El mínimo son 1 minuto: 0 no vale.
      const result = failure(await tool.execute({ text: 'x', inMinutes: 0 }, ctx));
      expect(result.recoverable).toBe(true);
      expect(result.error).toContain('at least 1 minute');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el texto vacío lo corta el schema', async () => {
    const tool = toolOf(createReminderTools(book()), SET_REMINDER_TOOL);
    await expect(tool.execute({ text: '   ', inMinutes: 5 }, ctx)).rejects.toThrow();
  });
});

describe('M21 — list_reminders y cancel_reminder', () => {
  it('lista los pendientes con id, hora local y texto', async () => {
    const b = book();
    const tools = createReminderTools(b);
    expect(output(await toolOf(tools, LIST_REMINDERS_TOOL).execute({}, ctx))).toBe(
      'There are no reminders pending.',
    );
    await toolOf(tools, SET_REMINDER_TOOL).execute({ text: 'agua', inMinutes: 25 }, ctx);
    await toolOf(tools, SET_REMINDER_TOOL).execute({ text: 'médico', time: '09:00' }, ctx);
    const listed = output(await toolOf(tools, LIST_REMINDERS_TOOL).execute({}, ctx));
    expect(listed).toContain('rem_1: today at 21:30 — agua');
    expect(listed).toContain('rem_2: tomorrow 18/11 at 09:00 — médico');
    // Cancelado: ya no se lista.
    await toolOf(tools, CANCEL_REMINDER_TOOL).execute({ id: 'rem_1' }, ctx);
    expect(output(await toolOf(tools, LIST_REMINDERS_TOOL).execute({}, ctx))).not.toContain(
      'rem_1',
    );
  });

  it('cancelar un id que no existe es recuperable', async () => {
    const tool = toolOf(createReminderTools(book()), CANCEL_REMINDER_TOOL);
    const result = failure(await tool.execute({ id: 'rem_nope' }, ctx));
    expect(result.recoverable).toBe(true);
    expect(result.error).toContain('not found');
  });
});

describe('M21 — el almacén en solo lectura', () => {
  it('list_reminders lo dice en vez de fingir que no hay ninguno', async () => {
    const b = book();
    await toolOf(createReminderTools(b), SET_REMINDER_TOOL).execute(
      { text: 'agua', inMinutes: 25 },
      ctx,
    );
    b.setReadOnly(true);
    const result = failure(
      await toolOf(createReminderTools(b), LIST_REMINDERS_TOOL).execute({}, ctx),
    );
    expect(result.recoverable).toBe(true);
    expect(result.error).toContain("can't read your reminders right now");
  });
});

describe('M21 — el registro del companion', () => {
  const config = StratumConfigSchema.parse({
    provider: {
      default: 'test',
      providers: {
        test: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' },
      },
    },
    memory: { autoExtract: false },
    tools: { auditLog: false },
    trace: { enabled: false },
  });

  it('las tres tools existen solo con reminders, y están en COMPANION_TOOLS', () => {
    const withBook = buildCompanionRegistry(config, { reminders: book() });
    for (const name of REMINDER_TOOLS) {
      expect(withBook.get(name), name).toBeDefined();
      expect(COMPANION_TOOLS).toContain(name);
    }
    const without = buildCompanionRegistry(config);
    for (const name of REMINDER_TOOLS) expect(without.get(name)).toBeUndefined();
    // Las de siempre siguen igual.
    expect(without.get('web_search')).toBeDefined();
  });

  it('el recordatorio se crea con la hora que resuelve el reloj de quien lo aloja', async () => {
    const b = book();
    const registry = buildCompanionRegistry(config, { reminders: b });
    const result = await registry
      .get(SET_REMINDER_TOOL)!
      .execute({ text: 'saca la basura', date: '2026-11-18', time: '21:00' }, ctx);
    expect(output(result)).toContain('tomorrow 18/11 at 21:00');
    expect(b.added[0]?.dueAt).toBe(new Date(2026, 10, 18, 21, 0, 0, 0).getTime());
    expect(b.added[0]?.text.length).toBeLessThanOrEqual(REMINDER_LIMITS.textChars);
    expect(MIN).toBe(60_000);
  });
});
