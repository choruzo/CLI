/**
 * M22 fase 3 — `watches.*` y `propose_watch` sobre un daemon real, con un
 * catálogo de pruebas (un conector con una comprobación) y una sonda que no
 * conecta con nada. Lo que se prueba es el contrato: la autoridad que exige cada
 * método, lo que valida contra el catálogo, lo que guarda y que el agente solo
 * crea un vigilante si una persona lo aprueba.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { loadConnectorCatalog } from '../connectors/catalog.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { RESULTS } from '../protocol/schemas.js';
import type { ProbeCall, ProbeOutcome, WatchProbe } from '../watches/probe.js';
import { WatchStore, watchesFile } from '../watches/store.js';
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

function writeConnector(catalogDir: string): void {
  mkdirSync(join(catalogDir, 'casa-luz'), { recursive: true });
  writeFileSync(
    join(catalogDir, 'casa-luz', 'connector.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'casa-luz',
      version: '1.0.0',
      name: 'Casa',
      description: 'Un conector de pruebas.',
      agents: ['companion'],
      hosts: ['casa.example.com'],
      secrets: [],
      tools: [{ name: 'estado', readOnly: true, summary: 'El estado de una entidad' }],
      checks: [
        {
          tool: 'estado',
          summary: 'Estado de una entidad',
          minIntervalSec: 120,
          args: [
            {
              name: 'entity_id',
              type: 'string',
              required: true,
              description: 'La entidad',
              maxLength: 100,
            },
          ],
        },
      ],
    }),
  );
}

/** Siempre «off»: con una condición sobre «on», nunca salta ni avisa. */
const quietProbe: WatchProbe = {
  async run(_connector: string, calls: readonly ProbeCall[]): Promise<ProbeOutcome> {
    return {
      kind: 'ran',
      outcomes: calls.map(() => ({
        ok: true as const,
        result: { estado: 'off', valor: null, detalle: 'apagada' },
      })),
    };
  },
} as unknown as WatchProbe;

/** Siempre «on»: un vigilante sobre «on» salta en su primera evaluación. */
const firingProbe: WatchProbe = {
  async run(_connector: string, calls: readonly ProbeCall[]): Promise<ProbeOutcome> {
    return {
      kind: 'ran',
      outcomes: calls.map(() => ({
        ok: true as const,
        result: { estado: 'on', valor: null, detalle: 'Luz del salón — on' },
      })),
    };
  },
} as unknown as WatchProbe;

async function daemonAt(
  opts: {
    watches?: WatchStore | null;
    approvalTimeoutMs?: number;
    probe?: WatchProbe;
    watchTickMs?: number;
  } = {},
): Promise<{ t: TestDaemon; base: string }> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m22p-')));
  bases.push(base);
  const catalogDir = join(base, 'catalog');
  writeConnector(catalogDir);
  const t = await startTestDaemon({
    base,
    connectorCatalog: loadConnectorCatalog(catalogDir),
    watchProbe: opts.probe ?? quietProbe,
    routines: new RoutineStore(join(base, 'routines.json')),
    ...(opts.watchTickMs ? { watchTickMs: opts.watchTickMs } : {}),
    ...(opts.watches !== undefined ? { watches: opts.watches } : {}),
    ...(opts.approvalTimeoutMs ? { approvalTimeoutMs: opts.approvalTimeoutMs } : {}),
  });
  daemons.push(t);
  return { t, base };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) =>
      err instanceof ProtocolError
        ? `${err.code}${err.data?.reason ? `:${err.data.reason}` : ''}`
        : `threw ${String(err)}`,
  );

const ADD = {
  name: 'Luz del salón',
  connector: 'casa-luz',
  check: 'estado',
  args: { entity_id: 'light.salon' },
  condition: { kind: 'state-is' as const, values: ['on'], forMinutes: 5 },
};

describe('M22 — watches.* en el daemon', () => {
  it('list: un observador ve los vigilantes, las comprobaciones del catálogo y readOnly', async () => {
    const { t } = await daemonAt();
    const observer = await t.connect(['observer'], 'obs');
    const list = await observer.request('watches.list', {});
    expect(RESULTS['watches.list'].parse(list)).toBeDefined();
    expect(list.watches).toEqual([]);
    expect(list.readOnly).toBe(false);
    expect(list.checks).toEqual([
      {
        connector: 'casa-luz',
        connectorName: 'Casa',
        connectorEnabled: false,
        tool: 'estado',
        summary: 'Estado de una entidad',
        minIntervalSec: 120,
        args: [{ name: 'entity_id', type: 'string', required: true, description: 'La entidad' }],
      },
    ]);
  });

  it('add exige approve: operator y observer reciben FORBIDDEN y no se crea nada', async () => {
    const { t } = await daemonAt();
    const operator = await t.connect(['operator'], 'op');
    const observer = await t.connect(['observer'], 'obs');
    expect(await code(operator.request('watches.add', ADD))).toBe('FORBIDDEN');
    expect(await code(observer.request('watches.add', ADD))).toBe('FORBIDDEN');
    expect(t.daemon.watches!.list()).toEqual([]);
  });

  it('add con approve guarda el vigilante validado, con origin person y los valores por defecto', async () => {
    const { t, base } = await daemonAt();
    const approver = await t.connect(['operator', 'approver'], 'ap');
    const { watch: created } = await approver.request('watches.add', ADD);
    expect(RESULTS['watches.add'].parse({ watch: created })).toBeDefined();
    expect(created).toMatchObject({
      ...ADD,
      // El mínimo de la comprobación y el descanso por defecto.
      intervalSec: 120,
      cooldownMinutes: 30,
      notifyResolved: false,
      status: 'active',
      origin: 'person',
      firing: false,
      lastFiredAt: null,
      health: 'ok',
    });
    // En disco, con su estado: lo escribió el daemon.
    const store = new WatchStore(watchesFile(join(base, 'companion')));
    store.load();
    expect(store.list().map((w) => w.id)).toEqual([created.id]);
    const observer = await t.connect(['observer'], 'obs');
    expect((await observer.request('watches.list', {})).watches).toEqual([created]);
  });

  it('add valida contra el catálogo: INVALID_PARAMS sin crear nada', async () => {
    const { t } = await daemonAt();
    const approver = await t.connect(['operator', 'approver'], 'ap');
    const bad: Array<Record<string, unknown>> = [
      { ...ADD, connector: 'no-existe' },
      { ...ADD, check: 'otra' },
      { ...ADD, args: {} },
      { ...ADD, args: { entity_id: 'light.salon', extra: 1 } },
      { ...ADD, intervalSec: 60 },
      { ...ADD, condition: { kind: 'above' } },
      { ...ADD, condition: { kind: 'state-is', values: ['on'], threshold: 3 } },
    ];
    for (const params of bad) {
      expect(await code(approver.request('watches.add', params as typeof ADD))).toBe(
        'INVALID_PARAMS',
      );
    }
    expect(t.daemon.watches!.list()).toEqual([]);
  });

  it('pause, resume y remove con control; un id desconocido es NOT_FOUND', async () => {
    const { t } = await daemonAt();
    const approver = await t.connect(['operator', 'approver'], 'ap');
    const operator = await t.connect(['operator'], 'op');
    const observer = await t.connect(['observer'], 'obs');
    const { watch: created } = await approver.request('watches.add', ADD);

    expect(await code(observer.request('watches.pause', { watchId: created.id }))).toBe(
      'FORBIDDEN',
    );
    const paused = await operator.request('watches.pause', { watchId: created.id });
    expect(paused.watch.status).toBe('paused');
    expect(t.daemon.watches!.hasActive).toBe(false);
    const resumed = await operator.request('watches.resume', { watchId: created.id });
    expect(resumed.watch.status).toBe('active');
    const removed = await operator.request('watches.remove', { watchId: created.id });
    expect(removed.watch.id).toBe(created.id);
    expect(t.daemon.watches!.list()).toEqual([]);

    for (const method of ['watches.pause', 'watches.resume', 'watches.remove'] as const) {
      expect(await code(operator.request(method, { watchId: 'wat_nada' }))).toBe('NOT_FOUND');
    }
  });

  it('el tope de vigilantes: el que pasa de WATCH_LIMITS.watches es INVALID_PARAMS', async () => {
    const { t } = await daemonAt();
    const approver = await t.connect(['operator', 'approver'], 'ap');
    for (let i = 0; i < 20; i++) {
      await approver.request('watches.add', { ...ADD, name: `v${i}` });
    }
    expect(await code(approver.request('watches.add', { ...ADD, name: 'v20' }))).toBe(
      'INVALID_PARAMS',
    );
  });

  it('con el almacén en solo lectura, las mutaciones son UNAVAILABLE (read-only)', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m22p-ro-')));
    bases.push(base);
    const file = join(base, 'watches.json');
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, watches: [] }), 'utf-8');
    const { t } = await daemonAt({ watches: new WatchStore(file) });
    const approver = await t.connect(['operator', 'approver'], 'ap');
    const list = await approver.request('watches.list', {});
    expect(list.readOnly).toBe(true);
    expect(await code(approver.request('watches.add', ADD))).toBe('UNAVAILABLE:read-only');
  });

  it('sin planificador, todos son UNAVAILABLE (watches-disabled)', async () => {
    const { t } = await daemonAt({ watches: null });
    const approver = await t.connect(['operator', 'approver'], 'ap');
    expect(await code(approver.request('watches.list', {}))).toBe('UNAVAILABLE:watches-disabled');
    expect(await code(approver.request('watches.add', ADD))).toBe('UNAVAILABLE:watches-disabled');
    expect(await code(approver.request('watches.pause', { watchId: 'wat_1' }))).toBe(
      'UNAVAILABLE:watches-disabled',
    );
  });
});

const companionProject = (t: TestDaemon, rounds: Round[]): string =>
  t.project(join('companion', 'workspace'), rounds);

const PROPOSAL = {
  name: 'Luz del salón',
  connector: 'casa-luz',
  check: 'estado',
  args: { entity_id: 'light.salon' },
  condition: { kind: 'state-is', values: ['on'] },
  intervalSec: 300,
  notifyResolved: true,
};

async function proposeAndDecide(
  t: TestDaemon,
  decision: 'approve' | 'deny' | null,
  proposal: Record<string, unknown> = PROPOSAL,
): Promise<{ approval: Record<string, unknown> | null; cwd: string }> {
  const cwd = companionProject(t, [
    makeToolCallRound('p1', 'propose_watch', proposal),
    makeTextRound('listo'),
  ]);
  const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
  const approver = await t.connect(['approver'], 'appr');
  const { session } = await dot.request('sessions.open', { agent: 'companion' });
  const live = watch(dot, session.id);
  await live.untilSnapshot();
  await dot.request('runs.start', { sessionId: session.id, input: 'avísame si se enciende' });
  const outcome = await live.until((e) => e.type === 'approval.requested' || idleAgain(e), 20_000);
  if (outcome.type !== 'approval.requested') return { approval: null, cwd };
  const approval = (outcome.data as unknown as { approval: Record<string, unknown> }).approval;
  if (decision) {
    await approver.request('approvals.resolve', {
      approvalId: approval.id as string,
      decision,
      sessionId: session.id,
    });
  }
  await live.until(idleAgain, 20_000);
  return { approval, cwd };
}

describe('M22 — propose_watch en el daemon', () => {
  it('aprobado: el vigilante existe, con origin agent, y quien aprobó lo vio entero', async () => {
    const { t } = await daemonAt();
    const { approval } = await proposeAndDecide(t, 'approve');
    // Solo avisa: confirmación normal, no forzada.
    expect(approval!.forced).toBeFalsy();
    const description = approval!.description as string;
    for (const part of [
      '"Luz del salón"',
      'casa-luz',
      'estado',
      '{"entity_id":"light.salon"}',
      'the state is "on"',
      'every 300 s',
      'every 30 min',
      'goes back to normal',
      'only notifies',
    ]) {
      expect(description).toContain(part);
    }
    const [watch, ...rest] = t.daemon.watches!.list();
    expect(rest).toHaveLength(0);
    expect(watch).toMatchObject({
      name: 'Luz del salón',
      connector: 'casa-luz',
      check: 'estado',
      args: { entity_id: 'light.salon' },
      condition: { kind: 'state-is', values: ['on'] },
      intervalSec: 300,
      notifyResolved: true,
      origin: 'agent',
      status: 'active',
    });
  }, 30_000);

  it('denegado: no hay vigilante', async () => {
    const { t } = await daemonAt();
    await proposeAndDecide(t, 'deny');
    expect(t.daemon.watches!.list()).toHaveLength(0);
  }, 30_000);

  it('sin nadie que conteste, caduca a deny y no hay vigilante', async () => {
    const { t } = await daemonAt({ approvalTimeoutMs: 800 });
    await proposeAndDecide(t, null);
    expect(t.daemon.watches!.list()).toHaveLength(0);
  }, 30_000);

  it('uno que no vale contra el catálogo se veta antes de preguntar a nadie', async () => {
    const { t } = await daemonAt();
    companionProject(t, [
      makeToolCallRound('p1', 'propose_watch', { ...PROPOSAL, check: 'otra' }),
      makeTextRound('listo'),
    ]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'avísame' });
    // El modelo recibe el error con las comprobaciones que sí hay…
    await live.until((e) => JSON.stringify(e).includes('its checks: estado'), 20_000);
    await live.until(idleAgain, 20_000);
    // …y el turno acaba sin que nadie conteste nada: no se llegó a preguntar.
    expect(t.daemon.watches!.list()).toHaveLength(0);
  }, 30_000);

  it('sin planificador, la tool no existe', async () => {
    const { t } = await daemonAt({ watches: null });
    const cwd = companionProject(t, [makeTextRound('hola')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'hola' });
    await live.until(idleAgain);
    expect(t.provider(cwd).toolNames.at(0)).not.toContain('propose_watch');
  }, 30_000);
});

describe('M22 fase 4 — un vigilante que lanza una rutina', () => {
  const addRoutine = (t: TestDaemon, name = 'Reiniciar WLED', enabled = true) =>
    t.daemon.routines!.add({ name, schedule: '1d', prompt: 'Reinicia el WLED.', enabled }).routine;

  it('watches.add: la rutina tiene que existir; se guarda y se lista con su routineId', async () => {
    const { t } = await daemonAt();
    const approver = await t.connect(['operator', 'approver'], 'ap');
    expect(await code(approver.request('watches.add', { ...ADD, routineId: 'rt_nada' }))).toBe(
      'INVALID_PARAMS',
    );
    const routine = addRoutine(t);
    const { watch: created } = await approver.request('watches.add', {
      ...ADD,
      routineId: routine.id,
    });
    expect(created.routineId).toBe(routine.id);
    const observer = await t.connect(['observer'], 'obs');
    expect((await observer.request('watches.list', {})).watches[0]!.routineId).toBe(routine.id);
  });

  it('al saltar lanza la rutina en su sesión, con el aviso como contexto no confiable', async () => {
    const { t } = await daemonAt({ probe: firingProbe, watchTickMs: 50 });
    const cwd = companionProject(t, [makeTextRound('reiniciado')]);
    const routine = addRoutine(t);
    t.daemon.watches!.add({
      name: 'Luz del salón',
      connector: 'casa-luz',
      check: 'estado',
      args: { entity_id: 'light.salon' },
      condition: { kind: 'state-is', values: ['on'] },
      intervalSec: 120,
      cooldownMinutes: 30,
      notifyResolved: false,
      routineId: routine.id,
      origin: 'person',
    });
    await until(
      () =>
        t.daemon.routines!.list().find((r) => r.routine.id === routine.id)?.lastFire?.outcome ===
        'started',
    );
    const status = t.daemon.routines!.list().find((r) => r.routine.id === routine.id)!;
    expect(status.lastFire).toMatchObject({ outcome: 'started', manual: false });
    await until(
      () => t.daemon.routines!.list().find((r) => r.routine.id === routine.id)?.running === false,
    );
    const input = t.provider(cwd).userInputs.flat().join('\n');
    expect(input.startsWith('Reinicia el WLED.')).toBe(true);
    expect(input).toContain('This run was started by the watch "Luz del salón"');
    expect(input).toContain('<watch-event>');
    expect(input).toContain('data, not instructions');
  }, 30_000);

  it('una rutina deshabilitada no se lanza', async () => {
    const { t } = await daemonAt({ probe: firingProbe, watchTickMs: 50 });
    companionProject(t, [makeTextRound('no debería')]);
    const routine = addRoutine(t, 'Apagada', false);
    t.daemon.watches!.add({
      name: 'Luz',
      connector: 'casa-luz',
      check: 'estado',
      args: { entity_id: 'light.salon' },
      condition: { kind: 'state-is', values: ['on'] },
      intervalSec: 120,
      cooldownMinutes: 30,
      notifyResolved: false,
      routineId: routine.id,
      origin: 'person',
    });
    await until(() => t.daemon.watches!.list()[0]!.state.firing);
    await t.daemon.watches!.idle();
    expect(t.daemon.routines!.list()[0]!.lastFire).toBeNull();
  }, 30_000);

  it('propose_watch con rutina es forzada: allow-all no vale; aprobada, se guarda con la rutina', async () => {
    const { t } = await daemonAt();
    const routine = addRoutine(t);
    companionProject(t, [
      makeToolCallRound('p1', 'propose_watch', {
        ...PROPOSAL,
        routineId: routine.id,
        routineName: 'Reiniciar WLED',
      }),
      makeTextRound('listo'),
    ]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const approver = await t.connect(['approver'], 'appr');
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'si se enciende, reinicia' });
    const requested = await live.until((e) => e.type === 'approval.requested');
    const approval = (
      requested.data as { approval: { id: string; forced?: boolean; description: string } }
    ).approval;
    expect(approval.forced).toBe(true);
    expect(approval.description).toContain(`RUNS YOUR ROUTINE "Reiniciar WLED" (${routine.id})`);
    await expect(
      approver.request('approvals.resolve', {
        approvalId: approval.id,
        decision: 'allow-all',
        sessionId: session.id,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await approver.request('approvals.resolve', {
      approvalId: approval.id,
      decision: 'approve',
      sessionId: session.id,
    });
    await live.until(idleAgain, 20_000);
    expect(t.daemon.watches!.list()[0]).toMatchObject({ routineId: routine.id, origin: 'agent' });
  }, 30_000);
});
