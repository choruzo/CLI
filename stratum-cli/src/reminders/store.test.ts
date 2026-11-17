/**
 * M21 — el almacén de recordatorios: validación, ventana de los terminados, y
 * que un fichero de un Stratum más nuevo o dañado se queda en solo lectura.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemorySink, resetLogging } from '../logging/index.js';
import { REMINDER_LIMITS } from '../protocol/index.js';
import {
  ReminderStore,
  ReminderStoreError,
  REMINDERS_SCHEMA_VERSION,
  remindersFile,
} from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

function tempStore(opts: { newId?: () => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stratum-reminders-'));
  dirs.push(dir);
  const file = remindersFile(dir);
  return { dir, file, store: new ReminderStore(file, opts) };
}

function stored(file: string): { schemaVersion?: unknown; reminders: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(file, 'utf-8')) as {
    schemaVersion?: unknown;
    reminders: Record<string, unknown>[];
  };
}

const errorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return err instanceof ReminderStoreError ? err.code : `threw ${String(err)}`;
  }
  return 'OK';
};

describe('M21 — ReminderStore', () => {
  it('sin fichero: vacío y escribible, y escribe con schemaVersion', () => {
    const { file, store } = tempStore();
    store.load();
    expect(store.readOnly).toBe(false);
    expect(store.list(T0)).toEqual([]);

    const reminder = store.add(
      { text: '  llama al médico ', dueAt: T0 + 60 * MIN, origin: 'agent' },
      T0,
    );
    expect(reminder.id).toMatch(/^rem_[0-9a-z]{10}$/);
    expect(reminder).toMatchObject({
      text: 'llama al médico',
      dueAt: T0 + 60 * MIN,
      createdAt: T0,
      origin: 'agent',
      status: 'pending',
    });
    expect('endedAt' in reminder).toBe(false);
    const onDisk = stored(file);
    expect(onDisk.schemaVersion).toBe(REMINDERS_SCHEMA_VERSION);
    expect(onDisk.reminders).toHaveLength(1);
  });

  it('valida el texto y la antelación, con un mensaje claro', () => {
    const { store } = tempStore();
    store.load();
    const add = (input: { text: string; dueAt: number }): string =>
      errorCode(() => store.add({ ...input, origin: 'person' }, T0));

    expect(add({ text: '   ', dueAt: T0 + MIN })).toBe('invalid');
    expect(add({ text: 'x'.repeat(REMINDER_LIMITS.textChars + 1), dueAt: T0 + MIN })).toBe(
      'invalid',
    );
    expect(add({ text: 'ok', dueAt: T0 + MIN - 1 })).toBe('invalid');
    expect(add({ text: 'ok', dueAt: T0 + REMINDER_LIMITS.maxLeadMs + 1 })).toBe('invalid');
    // Los bordes valen.
    expect(store.add({ text: 'ok', dueAt: T0 + MIN, origin: 'person' }, T0).status).toBe('pending');
    expect(
      store.add({ text: 'ok', dueAt: T0 + REMINDER_LIMITS.maxLeadMs, origin: 'person' }, T0).status,
    ).toBe('pending');

    try {
      store.add({ text: 'ok', dueAt: T0, origin: 'person' }, T0);
    } catch (err) {
      expect((err as Error).message).toContain('at least 1 minute');
    }
  });

  it(`no pasa de ${REMINDER_LIMITS.pending} pendientes`, () => {
    const { store } = tempStore();
    store.load();
    for (let i = 0; i < REMINDER_LIMITS.pending; i++) {
      store.add({ text: `aviso ${i}`, dueAt: T0 + (i + 1) * MIN, origin: 'agent' }, T0);
    }
    expect(
      errorCode(() => store.add({ text: 'uno más', dueAt: T0 + DAY, origin: 'agent' }, T0)),
    ).toBe('invalid');
    // Con uno cancelado, vuelve a haber sitio.
    store.cancel(store.pending()[0]!.id, T0);
    expect(store.add({ text: 'uno más', dueAt: T0 + DAY, origin: 'agent' }, T0).status).toBe(
      'pending',
    );
  });

  it('un id repetido no se repite', () => {
    let n = 0;
    const { store } = tempStore({ newId: () => `rem_fijo${n++}` });
    store.load();
    const a = store.add({ text: 'a', dueAt: T0 + MIN, origin: 'agent' }, T0);
    const b = store.add({ text: 'b', dueAt: T0 + MIN, origin: 'agent' }, T0);
    expect(a.id).toBe('rem_fijo0');
    expect(b.id).toBe('rem_fijo1');
  });

  it('list: pendientes y terminados de la ventana, por dueAt', () => {
    const { store } = tempStore();
    store.load();
    store.add({ text: 'tarde', dueAt: T0 + 4 * DAY, origin: 'agent' }, T0);
    store.add({ text: 'pronto', dueAt: T0 + DAY, origin: 'agent' }, T0);
    const done = store.add({ text: 'hecho', dueAt: T0 + 2 * DAY, origin: 'agent' }, T0);
    store.cancel(done.id, T0);

    expect(store.list(T0).map((r) => r.text)).toEqual(['pronto', 'hecho', 'tarde']);
    // Pasada la ventana, el terminado ya no se lista.
    expect(store.list(T0 + REMINDER_LIMITS.keepEndedMs + 1).map((r) => r.text)).toEqual([
      'pronto',
      'tarde',
    ]);
  });

  it('al escribir se purgan los terminados más antiguos que la ventana', () => {
    const { file, store } = tempStore();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: REMINDERS_SCHEMA_VERSION,
        reminders: [
          {
            id: 'rem_viejo',
            text: 'viejo',
            dueAt: T0 - 8 * DAY,
            createdAt: T0 - 9 * DAY,
            origin: 'person',
            status: 'delivered',
            endedAt: T0 - 8 * DAY,
          },
        ],
      }),
      'utf-8',
    );
    store.load();
    expect(store.list(T0)).toEqual([]);
    store.add({ text: 'nuevo', dueAt: T0 + MIN, origin: 'agent' }, T0);
    expect(stored(file).reminders.map((r) => r.id)).toEqual([expect.stringMatching(/^rem_/)]);
  });

  it('cancel: pending → cancelled; y no se puede cancelar dos veces', () => {
    const { store } = tempStore();
    store.load();
    const { id } = store.add({ text: 'a', dueAt: T0 + MIN, origin: 'person' }, T0);
    const cancelled = store.cancel(id, T0 + 1000);
    expect(cancelled).toMatchObject({ status: 'cancelled', endedAt: T0 + 1000 });
    expect(store.pending()).toEqual([]);
    expect(errorCode(() => store.cancel(id, T0 + 2000))).toBe('invalid');
    expect(errorCode(() => store.cancel('rem_nope', T0))).toBe('not-found');
  });

  it('markDelivered: delivered con endedAt, y `late` solo cuando toca', () => {
    const { store } = tempStore();
    store.load();
    const a = store.add({ text: 'a', dueAt: T0 + MIN, origin: 'agent' }, T0);
    const b = store.add({ text: 'b', dueAt: T0 + 2 * MIN, origin: 'agent' }, T0);
    const onTime = store.markDelivered(a.id, T0 + MIN, false);
    expect(onTime).toMatchObject({ status: 'delivered', endedAt: T0 + MIN });
    expect('late' in onTime).toBe(false);
    const late = store.markDelivered(b.id, T0 + 30 * MIN, true);
    expect(late).toMatchObject({ status: 'delivered', late: true });
    expect(store.pending()).toEqual([]);
    expect(errorCode(() => store.markDelivered(a.id, T0 + 40 * MIN, false))).toBe('invalid');
  });

  it('conserva campos desconocidos de una versión compatible al reescribir', () => {
    const { file, store } = tempStore();
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: REMINDERS_SCHEMA_VERSION,
        future: { x: 1 },
        reminders: [
          {
            id: 'rem_1',
            text: 'a',
            dueAt: T0 + MIN,
            createdAt: T0,
            origin: 'person',
            status: 'pending',
            colour: 'verde',
          },
        ],
      }),
      'utf-8',
    );
    store.load();
    store.add({ text: 'b', dueAt: T0 + 2 * MIN, origin: 'agent' }, T0);
    const onDisk = stored(file) as Record<string, unknown> & {
      reminders: Record<string, unknown>[];
    };
    expect(onDisk.future).toEqual({ x: 1 });
    expect(onDisk.reminders[0]!.colour).toBe('verde');
  });

  it('un fichero dañado no lleva el texto de un aviso al log', () => {
    const sink = new MemorySink('trace');
    resetLogging([sink], true);
    try {
      const { file, store } = tempStore();
      // Lo que el `JSON.parse` de Node mete en su mensaje: un trozo del fichero.
      writeFileSync(file, '{"reminders": [{"text": "llama al médico SECRETO-XYZ"', 'utf-8');
      store.load();
      expect(store.readOnly).toBe(true);
      const logged = JSON.stringify(sink.records);
      expect(logged).toContain('reminders file is unreadable');
      expect(logged).not.toContain('SECRETO-XYZ');
      expect(logged).not.toContain('llama al médico');
      // Se dice qué falló, por su nombre, y nada más del error.
      expect(logged).toContain('SyntaxError');
    } finally {
      resetLogging();
    }
  });

  it.each([
    ['de una versión más nueva', JSON.stringify({ schemaVersion: 2, reminders: [] }), 'newer'],
    [
      'con un schemaVersion inválido',
      JSON.stringify({ schemaVersion: 'x', reminders: [] }),
      'invalid',
    ],
    ['ilegible', '{ no es json', 'unreadable'],
    [
      'que no valida',
      JSON.stringify({ schemaVersion: 1, reminders: [{ id: 'rem_1', text: 'a' }] }),
      'invalid',
    ],
  ])('un fichero %s deja el almacén en solo lectura y no se toca', (_label, content, problem) => {
    const { file, store } = tempStore();
    writeFileSync(file, content, 'utf-8');
    store.load();
    expect(store.readOnly).toBe(true);
    expect(store.loadProblem).toBe(problem);
    expect(store.list(T0)).toEqual([]);
    expect(errorCode(() => store.add({ text: 'a', dueAt: T0 + MIN, origin: 'agent' }, T0))).toBe(
      'read-only',
    );
    expect(errorCode(() => store.cancel('rem_1', T0))).toBe('read-only');
    expect(errorCode(() => store.markDelivered('rem_1', T0, false))).toBe('read-only');
    // Ni una escritura: el fichero sigue byte a byte igual.
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });
});
