/**
 * M16 — `propose_routine` en el daemon: el `companion` propone, una persona
 * aprueba (o no) por el centro de aprobaciones, y solo entonces existe la
 * rutina, con `origin: 'agent'`. Solo la sesión principal tiene la tool.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { RoutineStore } from '../routines/store.js';
import {
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

async function daemonAt(opts: { approvalTimeoutMs?: number } = {}): Promise<TestDaemon> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m16p-')));
  bases.push(base);
  const t = await startTestDaemon({
    base,
    routines: new RoutineStore(join(base, 'routines.json')),
    ...(opts.approvalTimeoutMs ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
  });
  daemons.push(t);
  return t;
}

const companionProject = (t: TestDaemon, rounds: Round[]): string =>
  t.project(join('companion', 'workspace'), rounds);

const PROPOSAL = {
  name: 'Resumen diario',
  schedule: '0 9 * * *',
  prompt: 'Busca las noticias de Stratum y resúmelas en tres frases.',
};

async function proposeAndDecide(
  t: TestDaemon,
  decision: 'approve' | 'allow-all' | 'deny' | null,
): Promise<{ description: string; forced: unknown }> {
  companionProject(t, [
    makeToolCallRound('p1', 'propose_routine', PROPOSAL),
    makeTextRound('listo'),
  ]);
  const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
  const approver = await t.connect(['approver'], 'appr');
  const { session } = await dot.request('sessions.open', { agent: 'companion' });
  const live = watch(dot, session.id);
  await live.untilSnapshot();
  await dot.request('runs.start', { sessionId: session.id, input: 'cada mañana, las noticias' });
  const requested = await live.until((e) => e.type === 'approval.requested');
  const approval = (requested.data as unknown as { approval: Record<string, unknown> }).approval;
  if (decision) {
    await approver.request('approvals.resolve', {
      approvalId: approval.id as string,
      decision,
      sessionId: session.id,
    });
  }
  await live.until(idleAgain, 20_000);
  return { description: approval.description as string, forced: approval.forced };
}

describe('M16 — propose_routine en el daemon', () => {
  it('aprobada: la rutina existe, con origin agent, y quien aprobó vio el prompt entero', async () => {
    const t = await daemonAt();
    const { description } = await proposeAndDecide(t, 'approve');
    expect(description).toContain(PROPOSAL.prompt);
    const [status, ...rest] = t.daemon.routines!.list();
    expect(rest).toHaveLength(0);
    expect(status!.routine).toMatchObject({ ...PROPOSAL, origin: 'agent', enabled: true });
    expect(status!.nextFireAt).not.toBeNull();
  }, 30_000);

  it('denegada: no hay rutina', async () => {
    const t = await daemonAt();
    await proposeAndDecide(t, 'deny');
    expect(t.daemon.routines!.list()).toHaveLength(0);
  }, 30_000);

  it('sin nadie que conteste, caduca a deny y no hay rutina', async () => {
    const t = await daemonAt({ approvalTimeoutMs: 800 });
    await proposeAndDecide(t, null);
    expect(t.daemon.routines!.list()).toHaveLength(0);
  }, 30_000);

  it('es forzada: allow-all no vale', async () => {
    const t = await daemonAt();
    companionProject(t, [makeToolCallRound('p1', 'propose_routine', PROPOSAL), makeTextRound('x')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const approver = await t.connect(['approver'], 'appr');
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'programa algo' });
    const requested = await live.until((e) => e.type === 'approval.requested');
    const approval = (requested.data as { approval: { id: string; forced?: boolean } }).approval;
    expect(approval.forced).toBe(true);
    await expect(
      approver.request('approvals.resolve', {
        approvalId: approval.id,
        decision: 'allow-all',
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await approver.request('approvals.resolve', {
      approvalId: approval.id,
      decision: 'deny',
      sessionId: session.id,
    });
    await live.until(idleAgain, 20_000);
    expect(t.daemon.routines!.list()).toHaveLength(0);
  }, 30_000);

  it('solo la sesión principal la ofrece: la de una rutina no propone rutinas', async () => {
    const t = await daemonAt();
    const cwd = companionProject(t, [makeTextRound('a'), makeTextRound('b')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'hola' });
    await live.until(idleAgain);
    expect(t.provider(cwd).toolNames.at(0)).toContain('propose_routine');

    const routine = t.daemon.routines!.add({ name: 'r', schedule: '1h', prompt: 'haz r' }).routine;
    const fire = await t.daemon.routines!.runNow(routine.id);
    expect(fire.outcome).toBe('started');
    // Cada sesión monta su proveedor: el del arnés es el de la última que arrancó.
    const deadline = Date.now() + 10_000;
    while (!t.daemon.routines!.list()[0]?.lastResult && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    const last = t.provider(cwd).toolNames.at(-1);
    expect(last).toBeDefined();
    expect(last).toContain('question');
    expect(last).not.toContain('propose_routine');
  }, 30_000);

  it('sin planificador (routines: null) no existe la tool', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m16p-')));
    bases.push(base);
    const t = await startTestDaemon({ base, routines: null });
    daemons.push(t);
    const cwd = companionProject(t, [makeTextRound('a')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'hola' });
    await live.until(idleAgain);
    expect(t.provider(cwd).toolNames.at(0)).not.toContain('propose_routine');
  }, 30_000);
});
