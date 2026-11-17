/**
 * M21 — los recordatorios del `companion` sobre un daemon real: `reminders.list`
 * y `reminders.cancel` por el Stratum Protocol, la entrega de `reminder.due`
 * (fuera de cualquier run, en la suscripción `overview`) y el aviso que se
 * perdió con el daemon apagado, entregado al arrancar con `late`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { reminderSchema } from '../protocol/schemas.js';
import type { ProtocolEvent } from '../protocol/index.js';
import { ReminderStore, REMINDERS_SCHEMA_VERSION } from '../reminders/store.js';
import {
  gate,
  idleAgain,
  startTestDaemon,
  watch,
  type Round,
  type TestDaemon,
} from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

const MIN = 60_000;

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m21-')));
  bases.push(base);
  return base;
}

async function daemonAt(
  base: string,
  options: Parameters<typeof startTestDaemon>[0] = {},
): Promise<TestDaemon> {
  const t = await startTestDaemon({ base, ...options });
  daemons.push(t);
  return t;
}

const companionProject = (t: TestDaemon, rounds: Round[]): string =>
  t.project(join('companion', 'workspace'), rounds);

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) =>
      err instanceof ProtocolError
        ? `${err.code}${err.data?.reason ? `:${err.data.reason}` : ''}`
        : `threw ${String(err)}`,
  );

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/**
 * Se suscribe a `overview` y espera la primera foto: el servidor ya tiene la
 * suscripción, así que un evento publicado después no se pierde.
 */
async function watchOverview(client: {
  subscribeOverview(h: {
    onOverview: (o: unknown) => void;
    onEvent: (e: ProtocolEvent) => void;
  }): unknown;
}): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  await new Promise<void>((resolve) => {
    let first = true;
    client.subscribeOverview({
      onOverview: () => {
        if (!first) return;
        first = false;
        resolve();
      },
      onEvent: (e) => events.push(e),
    });
  });
  return events;
}

/** Un aviso en la suscripción `overview` que llega a cualquier sesión. */
function dueEvents(events: ProtocolEvent[]): ProtocolEvent[] {
  return events.filter((e) => e.type === 'reminder.due');
}

describe('M21 — reminders.* por el protocolo', () => {
  it('sin planificador (reminders: null) los dos métodos están desactivados', async () => {
    const t = await daemonAt(newBase(), { reminders: null });
    const op = await t.connect(['operator'], 'op');
    expect(await code(op.request('reminders.list', {}))).toBe('UNAVAILABLE:reminders-disabled');
    expect(
      await code(op.request('reminders.cancel', { reminderId: 'rem_x', operationId: 'o1' })),
    ).toBe('UNAVAILABLE:reminders-disabled');
  });

  it('el companion crea uno con su tool; list lo da y cancel lo quita', async () => {
    const base = newBase();
    const reminders = new ReminderStore(join(base, 'reminders.json'));
    const t = await daemonAt(base, { reminders });
    companionProject(t, [
      makeToolCallRound('c1', 'set_reminder', { text: 'llama al médico', inMinutes: 120 }),
      makeTextRound('de acuerdo'),
    ]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const empty = await dot.request('reminders.list', {});
    expect(empty).toEqual({ reminders: [], readOnly: false });

    await dot.request('runs.start', { sessionId: session.id, input: 'recuérdamelo en dos horas' });
    await until(() => t.daemon.reminders!.list(Date.now()).length > 0);

    const { reminders: listed, readOnly } = await dot.request('reminders.list', {});
    expect(readOnly).toBe(false);
    expect(listed).toHaveLength(1);
    const [reminder] = listed;
    expect(reminderSchema.parse(reminder)).toMatchObject({
      text: 'llama al médico',
      origin: 'agent',
      status: 'pending',
    });
    expect(reminder!.dueAt).toBeGreaterThan(Date.now());
    expect(reminder!.id).toMatch(/^rem_/);

    const cancelled = await dot.request('reminders.cancel', {
      reminderId: reminder!.id,
      operationId: 'op-cancel',
    });
    expect(cancelled.reminder).toMatchObject({ status: 'cancelled', id: reminder!.id });
    expect((await dot.request('reminders.list', {})).reminders[0]?.status).toBe('cancelled');

    // Ya no está pendiente: INVALID_PARAMS. Desconocido: NOT_FOUND.
    expect(
      await code(
        dot.request('reminders.cancel', { reminderId: reminder!.id, operationId: 'op-cancel-2' }),
      ),
    ).toBe('INVALID_PARAMS');
    expect(
      await code(
        dot.request('reminders.cancel', { reminderId: 'rem_nope', operationId: 'op-cancel-3' }),
      ),
    ).toBe('NOT_FOUND');
  }, 30_000);

  it('solo la sesión principal tiene las tools: la de una rutina, no', async () => {
    const base = newBase();
    const t = await daemonAt(base, { reminders: new ReminderStore(join(base, 'reminders.json')) });
    const cwd = companionProject(t, [makeTextRound('a'), makeTextRound('b')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'hola' });
    await live.until(idleAgain);
    expect(t.provider(cwd).toolNames.at(0)).toContain('set_reminder');

    const routine = t.daemon.routines!.add({ name: 'r', schedule: '1h', prompt: 'haz r' }).routine;
    expect((await t.daemon.routines!.runNow(routine.id)).outcome).toBe('started');
    await until(() => t.daemon.routines!.list()[0]?.lastResult !== null);
    const last = t.provider(cwd).toolNames.at(-1);
    expect(last).toBeDefined();
    expect(last).toContain('question');
    for (const name of ['set_reminder', 'list_reminders', 'cancel_reminder']) {
      expect(last).not.toContain(name);
    }
  }, 30_000);

  it('un vencimiento llega como reminder.due en la suscripción overview, fuera de un run', async () => {
    const base = newBase();
    const reminders = new ReminderStore(join(base, 'reminders.json'));
    let now = Date.now();
    const t = await daemonAt(base, { reminders, now: () => now });
    companionProject(t, [makeTextRound('aquí estoy')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const observer = await t.connect(['observer'], 'obs');
    const { session } = await dot.request('sessions.open', { agent: 'companion' });

    const events = await watchOverview(observer);

    // Creado en el pasado del reloj del test y rearmado con el reloj ya en su hora.
    const created = reminders.add(
      { text: 'saca la basura', dueAt: now + 60_000, origin: 'person' },
      now,
    );
    now += 60_000;
    t.daemon.reminders!.refresh();

    await until(() => dueEvents(events).length > 0);
    const due = dueEvents(events)[0] as unknown as {
      sessionId: string;
      runId?: string;
      data: { reminder: Record<string, unknown> };
    };
    expect(due.sessionId).toBe(session.id);
    // Fuera de un run: el aviso no abre turno ni lleva run detrás.
    expect(due.runId).toBeUndefined();
    expect(events.some((e) => e.type === 'run.started')).toBe(false);
    expect(due.data.reminder).toMatchObject({
      id: created.id,
      text: 'saca la basura',
      status: 'delivered',
      endedAt: now,
    });
    expect(due.data.reminder.late).toBeUndefined();
    // El aviso no lanza ningún run: la sesión sigue en reposo y sin mensajes nuevos.
    expect(t.daemon.liveSessions).toBe(1);
    expect((await dot.request('reminders.list', {})).reminders[0]?.status).toBe('delivered');
    expect(t.daemon.reminders!.hasPending).toBe(false);
  }, 30_000);

  it('sin sesión del companion, la abre para poder avisar (no se pierde el aviso)', async () => {
    const base = newBase();
    const reminders = new ReminderStore(join(base, 'reminders.json'));
    let now = Date.now();
    const t = await daemonAt(base, { reminders, now: () => now });
    companionProject(t, [makeTextRound('aquí estoy')]);
    const observer = await t.connect(['observer'], 'obs');
    const events = await watchOverview(observer);
    // No hay ninguna sesión del companion todavía.
    expect((await observer.request('sessions.list', {})).sessions).toEqual([]);

    const created = reminders.add(
      { text: 'riega las plantas', dueAt: now + 60_000, origin: 'person' },
      now,
    );
    now += 60_000;
    t.daemon.reminders!.refresh();

    await until(() => dueEvents(events).length > 0, 20_000);
    const due = dueEvents(events)[0] as unknown as {
      sessionId: string;
      data: { reminder: Record<string, unknown> };
    };
    expect(due.data.reminder).toMatchObject({ id: created.id, status: 'delivered' });
    // La sesión se abrió para publicarlo, con el agent del companion.
    const { sessions } = await observer.request('sessions.list', {});
    expect(sessions.map((x) => x.id)).toEqual([due.sessionId]);
    expect(sessions[0]?.agent).toBe('companion');
    expect((await observer.request('reminders.list', {})).reminders[0]?.status).toBe('delivered');
  }, 30_000);

  it('un aviso perdido con el daemon apagado se entrega al arrancar, con late', async () => {
    const base = newBase();
    const sessionsDir = join(base, 'sessions');
    const file = join(base, 'reminders.json');

    // 1) Una sesión del companion que queda guardada en disco.
    const first = await daemonAt(base, { reminders: new ReminderStore(file), sessionsDir });
    companionProject(first, [makeTextRound('hola')]);
    const dot = await first.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    // 2) El aviso venció mientras estaba apagado.
    const dueAt = Date.now() - 30 * MIN;
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: REMINDERS_SCHEMA_VERSION,
        reminders: [
          {
            id: 'rem_perdido',
            text: 'llama al médico',
            dueAt,
            createdAt: dueAt - 24 * 60 * MIN,
            origin: 'agent',
            status: 'pending',
          },
        ],
      }),
      'utf-8',
    );

    // La sesión guardada se despierta al entregar: el montaje espera a la puerta
    // para que la suscripción esté puesta antes de que salga el evento.
    const mount = gate();
    const workspace = join(base, 'companion', 'workspace');
    const second = await daemonAt(base, {
      reminders: new ReminderStore(file),
      sessionsDir,
      holdStartup: (cwd) => (cwd === workspace ? mount.wait : Promise.resolve()),
    });
    companionProject(second, [makeTextRound('hola')]);

    const observer = await second.connect(['observer'], 'obs');
    const events = await watchOverview(observer);
    mount.open();

    await until(() => dueEvents(events).length > 0, 20_000);
    const due = dueEvents(events)[0] as unknown as {
      sessionId: string;
      data: { reminder: Record<string, unknown> };
    };
    expect(due.sessionId).toBe(session.id);
    expect(due.data.reminder).toMatchObject({
      id: 'rem_perdido',
      status: 'delivered',
      late: true,
    });
    // Y el fichero ya no lo tiene pendiente: un reinicio no lo entrega otra vez.
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as {
      reminders: Array<{ id: string; status: string; late?: boolean }>;
    };
    expect(onDisk.reminders[0]).toMatchObject({ status: 'delivered', late: true });
    expect((await observer.request('reminders.list', {})).reminders[0]?.status).toBe('delivered');
  }, 40_000);
});
