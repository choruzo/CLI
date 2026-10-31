/**
 * M16 — las rutinas en el daemon (`docs/PRD_STRATUM_DOT.md` §23.5, A4), sobre un
 * daemon real con clientes reales; solo el modelo y el reloj del vencimiento
 * (`runNow`) son de guion. El horario en sí, con reloj falso, en
 * `routine-scheduler.test.ts`.
 *
 *  - cada rutina tiene su propia sesión del `companion`, que no es «la» del
 *    companion (`sessions.open { agent: 'companion' }` nunca la devuelve);
 *  - nunca dos runs a la vez de una rutina;
 *  - la sesión de una rutina sobrevive a un reinicio y se reutiliza;
 *  - lo que pide aprobación caduca a `deny` sin frenar al daemon ni a otras rutinas;
 *  - `routines: null` las desactiva y una habilitada mantiene vivo al daemon.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { RoutineStore } from '../routines/store.js';
import { gate, startTestDaemon, type Round, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m16-')));
  bases.push(base);
  return base;
}

async function daemonAt(
  base: string,
  opts: { persist?: boolean; approvalTimeoutMs?: number; idleExitMs?: number } = {},
): Promise<TestDaemon> {
  const t = await startTestDaemon({
    base,
    routines: new RoutineStore(join(base, 'routines.json')),
    ...(opts.persist ? { sessionsDir: join(base, 'daemon', 'sessions') } : {}),
    ...(opts.approvalTimeoutMs ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
    ...(opts.idleExitMs !== undefined ? { idleExitMs: opts.idleExitMs } : {}),
  });
  daemons.push(t);
  return t;
}

/** El directorio del companion (y de sus rutinas) en el arnés, con el guion de su modelo. */
function companionProject(t: TestDaemon, rounds: Round[]): string {
  return t.project(join('companion', 'workspace'), rounds);
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const idleRoutine = (t: TestDaemon, id: string) => async (): Promise<boolean> =>
  t.daemon.routines!.list().find((s) => s.routine.id === id)?.running === false;

const addRoutine = (t: TestDaemon, name: string, prompt = `haz ${name}`) =>
  t.daemon.routines!.add({ name, schedule: '1h', prompt }).routine;

describe('M16 — rutinas en el daemon', () => {
  it('runNow abre una sesión companion propia, distinta de la del companion (abierto antes o después)', async () => {
    const t = await daemonAt(newBase());
    companionProject(t, [makeTextRound('hecho')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const routine = addRoutine(t, 'a');

    // El companion principal, antes de que exista la sesión de la rutina.
    const main = (await dot.request('sessions.open', { agent: 'companion' })).session;
    const fire = await t.daemon.routines!.runNow(routine.id);
    expect(fire).toMatchObject({ outcome: 'started', manual: true, routineId: routine.id });
    expect(fire.sessionId).toBeDefined();
    expect(fire.sessionId).not.toBe(main.id);
    await until(idleRoutine(t, routine.id));

    const listed = (await dot.request('sessions.list', {})).sessions;
    expect(listed.filter((s) => s.agent === 'companion').map((s) => s.id)).toEqual(
      expect.arrayContaining([main.id, fire.sessionId!]),
    );
    expect((await dot.request('sessions.open', { agent: 'companion' })).session.id).toBe(main.id);
    expect(t.daemon.routines!.list()[0]).toMatchObject({
      sessionId: fire.sessionId,
      running: false,
      lastFire: { outcome: 'started' },
    });
  });

  it('si la rutina corre primero, abrir el companion no devuelve la suya', async () => {
    const t = await daemonAt(newBase());
    companionProject(t, [makeTextRound('hecho')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const routine = addRoutine(t, 'a');

    const fire = await t.daemon.routines!.runNow(routine.id);
    await until(idleRoutine(t, routine.id));
    const main = (await dot.request('sessions.open', { agent: 'companion' })).session;
    expect(main.id).not.toBe(fire.sessionId);
    expect((await dot.request('sessions.open', { agent: 'companion' })).session.id).toBe(main.id);

    // Y otro disparo de la rutina reutiliza su sesión, no la del companion.
    const again = await t.daemon.routines!.runNow(routine.id);
    expect(again).toMatchObject({ outcome: 'started', sessionId: fire.sessionId });
  });

  it('dos runNow seguidos: el segundo se salta mientras el primero sigue', async () => {
    const t = await daemonAt(newBase());
    const hold = gate();
    companionProject(t, [{ wait: hold.wait, then: makeTextRound('listo') }]);
    const routine = addRoutine(t, 'a');

    const first = await t.daemon.routines!.runNow(routine.id);
    const second = await t.daemon.routines!.runNow(routine.id);
    expect(first.outcome).toBe('started');
    expect(second).toMatchObject({ outcome: 'skipped-busy', sessionId: first.sessionId });
    expect(t.daemon.routines!.list()[0]!.running).toBe(true);

    hold.open();
    await until(idleRoutine(t, routine.id));
    expect((await t.daemon.routines!.runNow(routine.id)).outcome).toBe('started');
  });

  it('dos disparos a la vez de una rutina nueva abren una sola sesión', async () => {
    const t = await daemonAt(newBase());
    const hold = gate();
    companionProject(t, [{ wait: hold.wait, then: makeTextRound('listo') }]);
    const routine = addRoutine(t, 'a');

    const [a, b] = await Promise.all([
      t.daemon.routines!.runNow(routine.id),
      t.daemon.routines!.runNow(routine.id),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['skipped-busy', 'started']);
    expect(t.daemon.liveSessions).toBe(1);
    hold.open();
    await until(idleRoutine(t, routine.id));
  });

  it('la sesión de la rutina sobrevive a un reinicio con su routineId y el siguiente disparo la reutiliza', async () => {
    const base = newBase();
    const first = await daemonAt(base, { persist: true });
    companionProject(first, [makeTextRound('Apuntado.')]);
    const routine = addRoutine(first, 'diaria', 'recuerda kiwi');
    const fired = await first.daemon.routines!.runNow(routine.id);
    await until(idleRoutine(first, routine.id));
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemonAt(base, { persist: true });
    const cwd = companionProject(second, [makeTextRound('Dijiste kiwi.')]);
    const status = second.daemon.routines!.list()[0]!;
    expect(status.routine.id).toBe(routine.id);
    // Guardada sin montar: la reconoce por su routineId.
    expect(status).toMatchObject({ sessionId: fired.sessionId, running: false });
    expect(second.daemon.liveSessions).toBe(0);

    // El companion principal no es la de la rutina, aunque esté en disco.
    const dot = await second.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const main = (await dot.request('sessions.open', { agent: 'companion' })).session;
    expect(main.id).not.toBe(fired.sessionId);

    const again = await second.daemon.routines!.runNow(routine.id);
    expect(again).toMatchObject({ outcome: 'started', sessionId: fired.sessionId });
    await until(idleRoutine(second, routine.id));
    // Misma conversación: el modelo vio el run anterior.
    const seen = second.provider(cwd).userInputs;
    expect(seen.some((inputs) => inputs.includes('recuerda kiwi'))).toBe(true);
  });

  it('remove cierra la sesión de la rutina y la borra del disco', async () => {
    const base = newBase();
    const t = await daemonAt(base, { persist: true });
    companionProject(t, [makeTextRound('hecho')]);
    const routine = addRoutine(t, 'a');
    const fire = await t.daemon.routines!.runNow(routine.id);
    await until(idleRoutine(t, routine.id));
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    expect((await dot.request('sessions.list', {})).sessions.map((s) => s.id)).toContain(
      fire.sessionId,
    );

    await t.daemon.routines!.remove(routine.id);
    expect((await dot.request('sessions.list', {})).sessions.map((s) => s.id)).not.toContain(
      fire.sessionId,
    );
    expect(t.daemon.liveSessions).toBe(0);
    expect(t.daemon.routines!.list()).toEqual([]);
  });

  it('una pregunta sin contestar caduca a deny; mientras, otra rutina dispara y el daemon atiende', async () => {
    const t = await daemonAt(newBase(), { approvalTimeoutMs: 1_500 });
    companionProject(t, [
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Sigo?' }] }),
      makeTextRound('sin respuesta, paro'),
    ]);
    const approver = await t.connect(['approver'], 'appr');
    const a = addRoutine(t, 'a');
    const b = addRoutine(t, 'b');

    const fireA = await t.daemon.routines!.runNow(a.id);
    expect(fireA.outcome).toBe('started');
    await until(async () => (await approver.request('approvals.list', {})).questions.length >= 1);
    expect(t.daemon.routines!.list().find((s) => s.routine.id === a.id)!.running).toBe(true);

    // A espera una respuesta que nadie da: B dispara igual y el daemon contesta.
    const fireB = await t.daemon.routines!.runNow(b.id);
    expect(fireB.outcome).toBe('started');
    expect(fireB.sessionId).not.toBe(fireA.sessionId);
    const status = await approver.request('core.status', {});
    expect(status.liveSessions).toBe(2);

    // Caducan a deny y los dos runs terminan solos.
    await until(idleRoutine(t, a.id), 15_000);
    await until(idleRoutine(t, b.id), 15_000);
    expect((await approver.request('approvals.list', {})).questions).toEqual([]);
  }, 40_000);

  it('routines: null no monta planificador', async () => {
    const t = await startTestDaemon({ routines: null });
    daemons.push(t);
    expect(t.daemon.routines).toBeNull();
  });

  it('shutdown cierra la sesión de una rutina en marcha como cualquier otra, sin esperar a nada más', async () => {
    const t = await daemonAt(newBase());
    const hold = gate();
    companionProject(t, [{ wait: hold.wait, then: makeTextRound('nunca') }]);
    const routine = addRoutine(t, 'a');
    await t.daemon.routines!.runNow(routine.id);
    expect(t.daemon.liveSessions).toBe(1);

    await t.daemon.shutdown();
    expect(t.daemon.liveSessions).toBe(0);
    expect(t.teardowns()).toBe(1);
    // Parado el planificador, nada más vence.
    expect(t.daemon.routines!.hasEnabled).toBe(false);
  });

  it('una rutina habilitada mantiene vivo al daemon; sin ninguna, se apaga por inactividad', async () => {
    const without = await daemonAt(newBase(), { idleExitMs: 200 });
    expect(await withTimeout(without.daemon.closed, 5_000)).toBe('idle');

    const t = await daemonAt(newBase(), { idleExitMs: 200 });
    addRoutine(t, 'a');
    expect(await withTimeout(t.daemon.closed, 1_000)).toBe('timeout');
    // Deshabilitarla lo deja apagarse.
    const [only] = t.daemon.routines!.list();
    t.daemon.routines!.update(only!.routine.id, { enabled: false });
    expect(await withTimeout(t.daemon.closed, 5_000)).toBe('idle');
  });
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([
    p,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);
}
