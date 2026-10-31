/**
 * M16 (3/7) — `routines.*` por el Stratum Protocol sobre un daemon real:
 * capacidades, ciclo add/list/update/run/remove, el último resultado, la
 * procedencia `ProtocolSession.routineId` y los errores traducidos.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import { routineSchema } from '../protocol/schemas.js';
import { RoutineStore } from '../routines/store.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m16p-')));
  bases.push(base);
  return base;
}

async function daemonAt(base: string, routines?: RoutineStore | null): Promise<TestDaemon> {
  const t = await startTestDaemon({
    base,
    routines: routines === undefined ? new RoutineStore(join(base, 'routines.json')) : routines,
  });
  daemons.push(t);
  return t;
}

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

describe('routines.* (M16)', () => {
  it('add -> list -> update -> remove, con el contrato del schema', async () => {
    const t = await daemonAt(newBase());
    const op = await t.connect(['operator'], 'op');

    const added = await op.request('routines.add', {
      name: 'Resumen',
      schedule: '1h',
      prompt: 'resume el día',
      model: 'm1',
      limits: { maxIterations: 5 },
    });
    expect(routineSchema.parse(added.routine)).toMatchObject({
      name: 'Resumen',
      enabled: true,
      model: 'm1',
      limits: { maxIterations: 5 },
      sessionId: null,
      running: false,
      lastFire: null,
      lastResult: null,
      scheduleError: null,
    });
    expect(added.routine.nextFireAt).toBeGreaterThan(Date.now());
    expect(added.routine.createdAt).toBeGreaterThan(0);

    const list = await op.request('routines.list', {});
    expect(list.readOnly).toBe(false);
    expect(list.routines.map((r) => r.id)).toEqual([added.routine.id]);

    const updated = await op.request('routines.update', {
      routineId: added.routine.id,
      patch: { schedule: '2h', model: null, limits: null, enabled: false },
    });
    expect(updated.routine.model).toBeUndefined();
    expect(updated.routine.limits).toBeUndefined();
    expect(updated.routine).toMatchObject({ schedule: '2h', enabled: false, nextFireAt: null });

    const again = await op.request('routines.update', {
      routineId: added.routine.id,
      patch: { enabled: true },
    });
    expect(again.routine.nextFireAt).not.toBeNull();

    const removed = await op.request('routines.remove', { routineId: added.routine.id });
    expect(removed.routine.id).toBe(added.routine.id);
    expect((await op.request('routines.list', {})).routines).toEqual([]);
  });

  it('run arranca el run en la sesión de la rutina, que lleva routineId; luego hay lastResult', async () => {
    const t = await daemonAt(newBase());
    t.project(join('companion', 'workspace'), [makeTextRound('informe listo')]);
    const op = await t.connect(['operator'], 'op');
    const { routine } = await op.request('routines.add', {
      name: 'a',
      schedule: '1h',
      prompt: 'haz el informe',
    });

    const ran = await op.request('routines.run', { routineId: routine.id });
    expect(ran.fire).toMatchObject({ outcome: 'started', manual: true });
    expect(ran.fire.sessionId).toBeDefined();
    expect(ran.routine.sessionId).toBe(ran.fire.sessionId);

    const sessionId = ran.fire.sessionId!;
    const listed = (await op.request('sessions.list', {})).sessions.find((s) => s.id === sessionId);
    expect(listed?.routineId).toBe(routine.id);

    await until(async () => {
      const r = (await op.request('routines.list', {})).routines[0]!;
      return r.lastResult !== null;
    });
    const done = (await op.request('routines.list', {})).routines[0]!;
    expect(done).toMatchObject({
      running: false,
      lastResult: {
        runId: ran.fire.runId,
        sessionId,
        status: 'completed',
        summary: 'informe listo',
      },
    });

    // Borrar la rutina borra también su sesión.
    await op.request('routines.remove', { routineId: routine.id });
    const after = (await op.request('sessions.list', {})).sessions;
    expect(after.some((s) => s.id === sessionId)).toBe(false);
  });

  it('observe lista pero no muta', async () => {
    const t = await daemonAt(newBase());
    const observer = await t.connect(['observer'], 'obs');
    expect((await observer.request('routines.list', {})).routines).toEqual([]);
    const params = { name: 'a', schedule: '1h', prompt: 'p' };
    expect(await code(observer.request('routines.add', params))).toBe('FORBIDDEN');
    expect(await code(observer.request('routines.update', { routineId: 'x', patch: {} }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(observer.request('routines.remove', { routineId: 'x' }))).toBe('FORBIDDEN');
    expect(await code(observer.request('routines.run', { routineId: 'x' }))).toBe('FORBIDDEN');
  });

  it('traduce los errores del almacén', async () => {
    const t = await daemonAt(newBase());
    const op = await t.connect(['operator'], 'op');
    const base = { name: 'a', schedule: '1h', prompt: 'p' };
    await op.request('routines.add', base);

    const dup = await op.request('routines.add', { ...base, name: 'A' }).catch((e: unknown) => e);
    expect(dup).toBeInstanceOf(ProtocolError);
    expect((dup as ProtocolError).code).toBe('INVALID_PARAMS');
    expect((dup as ProtocolError).data?.issues).toMatchObject([{ path: 'name' }]);

    const badSchedule = await op
      .request('routines.add', { ...base, name: 'b', schedule: 'cuando quieras' })
      .catch((e: unknown) => e);
    expect((badSchedule as ProtocolError).code).toBe('INVALID_PARAMS');
    expect((badSchedule as ProtocolError).data?.issues).toMatchObject([{ path: 'schedule' }]);

    expect(await code(op.request('routines.update', { routineId: 'nope', patch: {} }))).toBe(
      'NOT_FOUND',
    );
    expect(await code(op.request('routines.remove', { routineId: 'nope' }))).toBe('NOT_FOUND');
    expect(await code(op.request('routines.run', { routineId: 'nope' }))).toBe('NOT_FOUND');

    // Fuera de los topes: lo rechaza el schema, antes del handler.
    expect(await code(op.request('routines.add', { ...base, name: 'c', prompt: '' }))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('un almacén de una versión más nueva es de solo lectura', async () => {
    const base = newBase();
    const file = join(base, 'routines.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 2, routines: [] }));
    const t = await daemonAt(base, new RoutineStore(file));
    const op = await t.connect(['operator'], 'op');

    expect(await op.request('routines.list', {})).toMatchObject({ routines: [], readOnly: true });
    expect(await code(op.request('routines.add', { name: 'a', schedule: '1h', prompt: 'p' }))).toBe(
      'UNAVAILABLE:read-only',
    );
  });

  it('con routines: null, todo es UNAVAILABLE routines-disabled', async () => {
    const t = await daemonAt(newBase(), null);
    const op = await t.connect(['operator'], 'op');
    expect(await code(op.request('routines.list', {}))).toBe('UNAVAILABLE:routines-disabled');
    expect(await code(op.request('routines.add', { name: 'a', schedule: '1h', prompt: 'p' }))).toBe(
      'UNAVAILABLE:routines-disabled',
    );
    expect(await code(op.request('routines.run', { routineId: 'x' }))).toBe(
      'UNAVAILABLE:routines-disabled',
    );
  });
});
