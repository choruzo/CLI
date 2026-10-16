/**
 * M4 — aprobaciones, preguntas y planes a través del daemon. Daemon, clientes,
 * sesiones y tools de verdad; lo único de guion es el modelo.
 *
 * La operación destructiva de estos tests es `rm victim.txt` dentro del proyecto
 * temporal: que el fichero siga o no en disco es la prueba de que la tool se
 * ejecutó, y cuántas veces.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ConfirmRequest, DestructiveDecision } from '../agent/types.js';
import { StratumClient } from '../client/client.js';
import { fileDiscovery } from '../client/discovery.js';
import type { GateContext } from '../host/interactions.js';
import { ProtocolError } from '../ipc/codec.js';
import { MemorySink, flushLogging, resetLogging } from '../logging/index.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  FEATURE_REMOTE_APPROVALS,
  type ProtocolApproval,
  type ProtocolEvent,
  type ProtocolStateEvent,
} from '../protocol/index.js';
import {
  TEST_APPROVER_KEY,
  startPeer,
  startTestDaemon,
  watch,
  type Round,
  type TestDaemon,
  type TestPeer,
  type Watcher,
} from './daemon.fixtures.js';

let t: TestDaemon | undefined;
const peers: TestPeer[] = [];

afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
  await t?.stop();
  t = undefined;
});

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const RM = 'rm victim.txt';
/** Una operación destructiva y el cierre del turno. */
const destructive = (): Round[] => [
  makeToolCallRound('c1', 'exec', { command: RM }),
  makeTextRound('hecho'),
];

function victim(cwd: string): string {
  const path = join(cwd, 'victim.txt');
  writeFileSync(path, 'no me borres\n');
  return path;
}

const isType =
  <T extends ProtocolStateEvent['type']>(type: T) =>
  (e: ProtocolEvent): e is Extract<ProtocolStateEvent, { type: T }> =>
    e.type === type;

async function untilType<T extends ProtocolStateEvent['type']>(
  w: Watcher,
  type: T,
): Promise<Extract<ProtocolStateEvent, { type: T }>> {
  return (await w.until(isType(type))) as Extract<ProtocolStateEvent, { type: T }>;
}

async function requested(w: Watcher): Promise<ProtocolApproval> {
  const event = await untilType(w, 'approval.requested');
  return (event as Extract<ProtocolStateEvent, { type: 'approval.requested' }>).data.approval;
}

/** Sesión alojada en el daemon con una operación destructiva en marcha. */
async function hosted(
  daemon: TestDaemon,
  rounds: Round[] = destructive(),
  config: Record<string, unknown> = {},
) {
  const cwd = daemon.project(`p${Math.random().toString(36).slice(2, 8)}`, rounds, config);
  const file = victim(cwd);
  const operator = await daemon.connect(['operator'], 'op');
  const approver = await daemon.connect(['approver'], 'appr');
  const { session } = await operator.request('sessions.open', { cwd });
  const w = watch(approver, session.id);
  await w.untilSnapshot();
  return { cwd, file, operator, approver, sessionId: session.id, w };
}

/** Un prompt local que se contesta desde el test, como una persona en su terminal. */
function localPrompt() {
  const seen: Array<{ req: ConfirmRequest; ctx: GateContext }> = [];
  let answer: ((d: DestructiveDecision) => void) | null = null;
  return {
    seen,
    confirm: (req: ConfirmRequest, ctx?: GateContext): Promise<DestructiveDecision> =>
      new Promise<DestructiveDecision>((resolve) => {
        seen.push({ req, ctx: ctx! });
        answer = resolve;
      }),
    answer: (d: DestructiveDecision) => answer?.(d),
  };
}

async function peerWithPrompt(daemon: TestDaemon, rounds: Round[] = destructive()) {
  const prompt = localPrompt();
  const p = await startPeer(
    daemon,
    `peer${Math.random().toString(36).slice(2, 8)}`,
    rounds,
    {},
    { destructivePolicy: 'ask', gates: { confirm: prompt.confirm } },
  );
  peers.push(p);
  const file = victim(p.host.env.cwd);
  const approver = await daemon.connect(['approver'], 'appr');
  const w = watch(approver, p.sessionId);
  await w.untilSnapshot();
  return { p, prompt, file, approver, w };
}

describe('M4 — sesión alojada en el daemon', () => {
  it('solicitud → pendiente → un aprobador la resuelve → el runtime sigue', async () => {
    t = await startTestDaemon();
    const s = await hosted(t);
    const observer = await t.connect(['observer'], 'obs');
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });

    const approval = await requested(s.w);
    expect(approval).toMatchObject({
      kind: 'tool',
      sessionId: s.sessionId,
      tool: 'exec',
      forced: false,
      resolvable: 'anywhere',
      status: 'pending',
    });
    expect(approval.description).toContain(RM);
    // Sin nadie delante, caduca.
    expect(approval.expiresAt).toBeGreaterThan(approval.requestedAt);
    await s.w.until((e) => e.type === 'run.updated' && e.data.run.status === 'waiting_approval');

    // Un observador lo ve; resolverlo es otra cosa.
    const listed = await observer.request('approvals.list', {});
    expect(listed.approvals.map((a) => a.id)).toEqual([approval.id]);
    expect((await observer.request('core.status', {})).pendingApprovals).toBe(1);
    expect(
      (await observer.request('sessions.get', { sessionId: s.sessionId })).snapshot,
    ).toMatchObject({ session: { state: 'waiting' }, approvals: [{ id: approval.id }] });
    expect(existsSync(s.file)).toBe(true);

    await s.approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' });
    const resolved = await untilType(s.w, 'approval.resolved');
    expect(resolved.data).toMatchObject({
      approvalId: approval.id,
      status: 'approved',
      decision: 'approve',
      resolvedBy: { kind: 'remote', client: 'cli', connectionId: s.approver.server!.connectionId },
    });
    await s.w.until((e) => e.type === 'run.completed');
    expect(existsSync(s.file)).toBe(false);
    expect((await observer.request('approvals.list', {})).approvals).toEqual([]);
    expect((await observer.request('core.status', {})).pendingApprovals).toBe(0);

    // Quién lo aprobó queda en la auditoría, junto al comando que autorizó.
    const audited = (): Array<Record<string, unknown>> =>
      readdirSync(t!.base)
        .filter((f) => /^audit-\d+\.jsonl$/.test(f))
        .flatMap((f) => readFileSync(join(t!.base, f), 'utf-8').trim().split(/\r?\n/))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    await until(() => audited().some((r) => r['event'] === 'approval'));
    expect(audited().find((r) => r['event'] === 'approval')).toMatchObject({
      sessionId: s.sessionId,
      approvalId: approval.id,
      tool: 'exec',
      status: 'resolved',
      decision: 'approve',
      by: 'remote',
      client: 'cli',
      connectionId: s.approver.server!.connectionId,
    });
    expect(audited().some((r) => r['command'] === RM && r['status'] === 'exited')).toBe(true);

    // El `seq` es de la sesión y no tiene huecos: el centro no numera nada.
    const seqs = s.w.seqs();
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
    // Una respuesta posterior llega tarde.
    expect(
      await code(
        s.approver.request('approvals.resolve', { approvalId: approval.id, decision: 'deny' }),
      ),
    ).toBe('ALREADY_RESOLVED');
  }, 30_000);

  it('host, operator y observer no aprueban; el approver aprueba y no cancela', async () => {
    t = await startTestDaemon();
    const s = await hosted(t);
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });
    const approval = await requested(s.w);
    const resolve = { approvalId: approval.id, decision: 'approve' } as const;

    const observer = await t.connect(['observer'], 'obs');
    const host = await t.connect(['host'], 'host');
    expect(host.capabilities).toEqual(['observe', 'host']);
    for (const client of [observer, s.operator, host]) {
      expect(await code(client.request('approvals.resolve', resolve))).toBe('FORBIDDEN');
      expect(
        await code(client.request('questions.answer', { requestId: 'x', answers: null })),
      ).toBe('FORBIDDEN');
      expect(
        await code(client.request('plans.decide', { requestId: 'x', decision: 'approve' })),
      ).toBe('FORBIDDEN');
    }

    // El token del canal no basta: sin clave, el rol approver no trae la capacidad.
    const noKey = await t.connect(['approver'], 'no-key', { approverKey: null });
    expect(noKey.capabilities).toEqual(['observe']);
    expect(await code(noKey.request('approvals.resolve', resolve))).toBe('FORBIDDEN');
    // Una clave que no vale no degrada a observador: se rechaza.
    expect(await code(t.connect(['approver'], 'bad-key', { approverKey: 'otra clave' }))).toBe(
      'UNAUTHORIZED',
    );
    // Ni con la clave: una conexión de anfitrión no recibe `approve` ni `control`.
    const hostWithKey = await t.connect(['host', 'approver', 'operator'], 'host+', {
      approverKey: TEST_APPROVER_KEY,
    });
    expect(hostWithKey.capabilities).toEqual(['observe', 'host']);
    expect(await code(hostWithKey.request('approvals.resolve', resolve))).toBe('FORBIDDEN');
    expect(await code(hostWithKey.request('runs.cancel', { sessionId: s.sessionId }))).toBe(
      'FORBIDDEN',
    );

    // Nada de lo anterior cambió nada.
    expect(existsSync(s.file)).toBe(true);
    expect((await observer.request('approvals.list', {})).approvals).toHaveLength(1);

    // El aprobador no gobierna el run…
    expect(s.approver.capabilities).toEqual(['observe', 'approve']);
    expect(await code(s.approver.request('runs.cancel', { sessionId: s.sessionId }))).toBe(
      'FORBIDDEN',
    );
    // …y denegar deja la tool sin ejecutar.
    await s.approver.request('approvals.resolve', { approvalId: approval.id, decision: 'deny' });
    await s.w.until((e) => e.type === 'run.completed');
    expect(existsSync(s.file)).toBe(true);
    expect(s.w.types()).toContain('tool.failed');
  }, 30_000);

  it('dos aprobadores a la vez: gana uno, el otro recibe ALREADY_RESOLVED', async () => {
    t = await startTestDaemon();
    const s = await hosted(t);
    const other = await t.connect(['approver'], 'appr-2');
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });
    const approval = await requested(s.w);

    const results = await Promise.all([
      code(
        s.approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' }),
      ),
      code(other.request('approvals.resolve', { approvalId: approval.id, decision: 'deny' })),
    ]);
    expect(results.sort()).toEqual(['ALREADY_RESOLVED', 'OK']);
    await s.w.until((e) => e.type === 'run.completed');
    // Una sola decisión llegó al runtime: la del que ganó.
    const resolved = s.w.states().filter(isType('approval.resolved'));
    expect(resolved).toHaveLength(1);
    expect(existsSync(s.file)).toBe(resolved[0]!.data.decision === 'deny');
  }, 30_000);

  it('M8: un id correcto con la sesión equivocada no resuelve nada, ni dice cómo acabó', async () => {
    t = await startTestDaemon();
    const a = await hosted(t);
    const b = await hosted(t, [makeTextRound('nada')]);
    await a.operator.request('runs.start', { sessionId: a.sessionId, input: 'borra' });
    const approval = await requested(a.w);

    // Con la sesión de otro, la solicitud no existe para esa petición…
    for (const decision of ['approve', 'deny'] as const) {
      expect(
        await code(
          a.approver.request('approvals.resolve', {
            sessionId: b.sessionId,
            approvalId: approval.id,
            decision,
          }),
        ),
      ).toBe('NOT_FOUND');
    }
    expect(
      await code(
        a.approver.request('questions.answer', {
          sessionId: b.sessionId,
          requestId: approval.id,
          answers: null,
        }),
      ),
    ).toBe('NOT_FOUND');
    // …y sigue pendiente, sin ejecutar nada.
    expect((await a.approver.request('approvals.list', {})).approvals.map((x) => x.id)).toEqual([
      approval.id,
    ]);
    expect(existsSync(a.file)).toBe(true);

    // Con la suya, se resuelve.
    await a.approver.request('approvals.resolve', {
      sessionId: a.sessionId,
      approvalId: approval.id,
      decision: 'approve',
    });
    await a.w.until((e) => e.type === 'run.completed');
    expect(existsSync(a.file)).toBe(false);
    // Ya resuelta: a quien nombra su sesión se le dice; a quien nombra otra, no existe.
    const late = { approvalId: approval.id, decision: 'deny' } as const;
    expect(
      await code(a.approver.request('approvals.resolve', { ...late, sessionId: a.sessionId })),
    ).toBe('ALREADY_RESOLVED');
    expect(
      await code(a.approver.request('approvals.resolve', { ...late, sessionId: b.sessionId })),
    ).toBe('NOT_FOUND');
  }, 30_000);

  it('M8: lo mismo con una pregunta y con un plan de verdad', async () => {
    t = await startTestDaemon();
    const other = await hosted(t, [makeTextRound('nada')]);
    const q = await hosted(t, [
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Sigo?' }] }),
      makeTextRound('vale'),
    ]);
    await q.operator.request('runs.start', { sessionId: q.sessionId, input: 'pregunta' });
    const asked = (await untilType(q.w, 'question.requested')).data.request;
    const answers = [{ question: '¿Sigo?', answer: 'sí' }];
    expect(
      await code(
        q.approver.request('questions.answer', {
          sessionId: other.sessionId,
          requestId: asked.id,
          answers,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect((await q.approver.request('approvals.list', {})).questions).toHaveLength(1);
    await q.approver.request('questions.answer', {
      sessionId: q.sessionId,
      requestId: asked.id,
      answers,
    });
    await q.w.until((e) => e.type === 'run.completed');

    const p = await hosted(t, [
      makeToolCallRound('c1', 'present_plan', { summary: 'Plan', steps: [{ title: 'Uno' }] }),
      makeTextRound('hecho'),
    ]);
    await p.operator.request('runs.start', { sessionId: p.sessionId, input: 'x', mode: 'plan' });
    const proposed = (await untilType(p.w, 'plan.proposed')).data.request;
    expect(
      await code(
        p.approver.request('plans.decide', {
          sessionId: other.sessionId,
          requestId: proposed.id,
          decision: 'approve',
        }),
      ),
    ).toBe('NOT_FOUND');
    expect((await p.approver.request('approvals.list', {})).plans).toHaveLength(1);
    await p.approver.request('plans.decide', {
      sessionId: p.sessionId,
      requestId: proposed.id,
      decision: 'reject',
    });
    expect((await untilType(p.w, 'plan.resolved')).data.decision).toBe('reject');
  }, 40_000);

  it('cancelar el run con una aprobación pendiente: no se ejecuta y la solicitud desaparece', async () => {
    t = await startTestDaemon();
    const s = await hosted(t);
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });
    const approval = await requested(s.w);

    await s.operator.request('runs.cancel', { sessionId: s.sessionId });
    const resolved = await untilType(s.w, 'approval.resolved');
    expect(resolved.data.status).toBe('cancelled');
    expect(resolved.data.resolvedBy).toBeUndefined();
    await s.w.until((e) => e.type === 'run.cancelled');
    expect(existsSync(s.file)).toBe(true);
    expect((await s.approver.request('approvals.list', {})).approvals).toEqual([]);
    expect(
      await code(
        s.approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' }),
      ),
    ).toBe('ALREADY_RESOLVED');
    expect(existsSync(s.file)).toBe(true);
  }, 30_000);

  it('cerrar la sesión con una aprobación pendiente no deja nada colgado', async () => {
    t = await startTestDaemon();
    const s = await hosted(t);
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });
    const approval = await requested(s.w);

    await s.operator.request('sessions.close', { sessionId: s.sessionId });
    expect((await s.approver.request('approvals.list', {})).approvals).toEqual([]);
    expect((await s.approver.request('core.status', {})).pendingApprovals).toBe(0);
    expect(
      await code(
        s.approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' }),
      ),
    ).toBe('ALREADY_RESOLVED');
    expect(existsSync(s.file)).toBe(true);
  }, 30_000);

  it('sin respuesta caduca a denegar y el runtime sigue', async () => {
    t = await startTestDaemon({ approvalTimeoutMs: 200 });
    const s = await hosted(t);
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });
    const approval = await requested(s.w);

    const resolved = await untilType(s.w, 'approval.resolved');
    expect(resolved.data).toMatchObject({
      approvalId: approval.id,
      status: 'expired',
      decision: 'deny',
      resolvedBy: { kind: 'timeout' },
    });
    await s.w.until((e) => e.type === 'run.completed');
    expect(existsSync(s.file)).toBe(true);
    expect((await s.approver.request('approvals.list', {})).approvals).toEqual([]);
  }, 30_000);

  it('sin aprobadores acreditados no se pregunta: se deniega, como sin terminal', async () => {
    t = await startTestDaemon({ approver: null });
    // Ni siquiera en un entorno `allow`: sin nadie que pueda aprobar, la
    // política de una sesión del daemon es la de una sesión sin terminal.
    const cwd = t.project('p', destructive(), {
      environments: { lab: { match: ['local'], tier: 'development', policy: 'allow' } },
    });
    const file = victim(cwd);
    const operator = await t.connect(['operator'], 'op');
    expect(operator.server!.features).not.toContain(FEATURE_REMOTE_APPROVALS);
    // Sin acreditación configurada, ninguna clave vale.
    expect(await code(t.connect(['approver'], 'a'))).toBe('UNAUTHORIZED');

    const { session } = await operator.request('sessions.open', { cwd });
    const w = watch(operator, session.id);
    await w.untilSnapshot();
    await operator.request('runs.start', { sessionId: session.id, input: 'borra' });
    await w.until((e) => e.type === 'run.completed');
    expect(w.types()).not.toContain('approval.requested');
    expect(w.types()).toContain('tool.failed');
    expect(existsSync(file)).toBe(true);
  }, 30_000);

  it('confirm-always no cede ante allow-all; fuera de él, allow-all vale para la sesión', async () => {
    t = await startTestDaemon();
    const twice = (): Round[] => [
      makeToolCallRound('c1', 'exec', { command: RM }),
      makeToolCallRound('c2', 'exec', { command: 'rm other.txt' }),
      makeTextRound('hecho'),
    ];
    // Entorno `confirm-always`: cada cambio se aprueba por separado.
    const forced = await hosted(t, twice(), {
      environments: { prod: { match: ['local'], tier: 'production', confirmation: 'simple' } },
    });
    writeFileSync(join(forced.cwd, 'other.txt'), 'x');
    await forced.operator.request('runs.start', { sessionId: forced.sessionId, input: 'borra' });
    const first = await requested(forced.w);
    expect(first).toMatchObject({ forced: true, environment: { name: 'prod' }, target: 'local' });
    expect(
      await code(
        forced.approver.request('approvals.resolve', {
          approvalId: first.id,
          decision: 'allow-all',
        }),
      ),
    ).toBe('INVALID_PARAMS');
    await forced.approver.request('approvals.resolve', {
      approvalId: first.id,
      decision: 'approve',
    });
    // La segunda vuelve a preguntar.
    const second = (await forced.w.until(
      (e) => e.type === 'approval.requested' && e.data.approval.id !== first.id,
    )) as Extract<ProtocolStateEvent, { type: 'approval.requested' }>;
    expect(second.data.approval.forced).toBe(true);
    await forced.approver.request('approvals.resolve', {
      approvalId: second.data.approval.id,
      decision: 'deny',
    });
    await forced.w.until((e) => e.type === 'run.completed');
    expect(existsSync(forced.file)).toBe(false);
    expect(existsSync(join(forced.cwd, 'other.txt'))).toBe(true);

    // Sin la política: allow-all cubre el resto del turno, y queda auditado quién lo dio.
    const plain = await hosted(t, twice());
    writeFileSync(join(plain.cwd, 'other.txt'), 'x');
    await plain.operator.request('runs.start', { sessionId: plain.sessionId, input: 'borra' });
    const only = await requested(plain.w);
    await plain.approver.request('approvals.resolve', {
      approvalId: only.id,
      decision: 'allow-all',
    });
    await plain.w.until((e) => e.type === 'run.completed');
    const asked = plain.w.states().filter(isType('approval.requested'));
    expect(asked).toHaveLength(1);
    expect(plain.w.states().filter(isType('approval.resolved'))[0]!.data).toMatchObject({
      decision: 'allow-all',
      resolvedBy: { kind: 'remote' },
    });
    expect(existsSync(join(plain.cwd, 'other.txt'))).toBe(false);
  }, 40_000);

  it('preguntas: la respuesta remota se valida y llega al agente', async () => {
    t = await startTestDaemon();
    const s = await hosted(t, [
      makeToolCallRound('q1', 'question', {
        questions: [{ question: '¿Entorno?', options: ['staging', 'production'] }],
      }),
      makeTextRound('anotado'),
    ]);
    await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'pregunta' });
    const asked = await untilType(s.w, 'question.requested');
    const { request } = asked.data;
    const [question] = request.questions;
    expect(question!.options!.map((o) => o.label)).toEqual(['staging', 'production']);
    await s.w.until((e) => e.type === 'run.updated' && e.data.run.status === 'waiting_input');
    expect((await s.approver.request('approvals.list', {})).questions).toHaveLength(1);

    const answer = (answers: Array<{ question: string; answer: string; optionId?: string }>) =>
      code(s.approver.request('questions.answer', { requestId: request.id, answers }));
    // Una pregunta de opciones no admite texto libre, ni otro número de respuestas.
    expect(await answer([{ question: 'x', answer: 'la que yo quiera' }])).toBe('INVALID_PARAMS');
    expect(await answer([])).toBe('INVALID_PARAMS');
    expect(
      await code(s.operator.request('questions.answer', { requestId: request.id, answers: null })),
    ).toBe('FORBIDDEN');
    expect(await answer([{ question: '', answer: '', optionId: question!.options![1]!.id }])).toBe(
      'OK',
    );

    const resolved = await untilType(s.w, 'question.resolved');
    expect(resolved.data).toMatchObject({
      requestId: request.id,
      answers: [{ question: '¿Entorno?', answer: 'production' }],
      status: 'resolved',
      resolvedBy: { kind: 'remote' },
    });
    await s.w.until((e) => e.type === 'run.completed');
    expect(await answer([{ question: '', answer: 'staging' }])).toBe('ALREADY_RESOLVED');
  }, 30_000);

  it('plan: se propone, un aprobador decide y el turno ejecuta o termina', async () => {
    t = await startTestDaemon();
    const plan = (): Round[] => [
      makeToolCallRound('c1', 'present_plan', {
        summary: 'Limpieza',
        steps: [{ title: 'Paso uno' }, { title: 'Paso dos' }],
      }),
      makeTextRound('ejecutado'),
    ];
    const s = await hosted(t, plan());
    await s.operator.request('runs.start', {
      sessionId: s.sessionId,
      input: 'limpia',
      mode: 'plan',
    });
    const proposed = await untilType(s.w, 'plan.proposed');
    const { request } = proposed.data;
    expect(request.plan.steps.map((step) => step.title)).toEqual(['Paso uno', 'Paso dos']);
    expect((await s.approver.request('approvals.list', {})).plans).toHaveLength(1);
    expect(
      await code(
        s.operator.request('plans.decide', { requestId: request.id, decision: 'approve' }),
      ),
    ).toBe('FORBIDDEN');

    await s.approver.request('plans.decide', { requestId: request.id, decision: 'approve' });
    const resolved = await untilType(s.w, 'plan.resolved');
    expect(resolved.data).toMatchObject({
      requestId: request.id,
      decision: 'approve',
      status: 'resolved',
      resolvedBy: { kind: 'remote' },
    });
    expect(resolved.data.plan?.steps).toHaveLength(2);
    await s.w.until((e) => e.type === 'run.completed');
    expect(
      await code(s.approver.request('plans.decide', { requestId: request.id, decision: 'reject' })),
    ).toBe('ALREADY_RESOLVED');

    // Rechazar: el plan no se ejecuta.
    const rejected = await hosted(t, plan());
    await rejected.operator.request('runs.start', {
      sessionId: rejected.sessionId,
      input: 'limpia',
      mode: 'plan',
    });
    const again = await untilType(rejected.w, 'plan.proposed');
    await rejected.approver.request('plans.decide', {
      requestId: again.data.request.id,
      decision: 'reject',
    });
    expect((await untilType(rejected.w, 'plan.resolved')).data.decision).toBe('reject');
    await rejected.w.until((e) => e.type === 'run.completed');
  }, 40_000);
});

describe('M4 — sesión de la CLI (anfitrión par)', () => {
  it('el remoto gana: el prompt local se retira y la tool se ejecuta una sola vez', async () => {
    t = await startTestDaemon();
    const { p, prompt, file, approver, w } = await peerWithPrompt(t);
    const running = p.run('borra');

    const approval = await requested(w);
    // Con una persona delante no caduca.
    expect(approval.expiresAt).toBeNull();
    await until(() => prompt.seen.length === 1);
    const local = prompt.seen[0]!;
    expect(local.ctx.id).toBe(approval.id);
    expect(local.ctx.signal.aborted).toBe(false);
    expect((await approver.request('approvals.list', {})).approvals.map((a) => a.id)).toEqual([
      approval.id,
    ]);

    await approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' });
    // El prompt de la terminal se retira…
    expect(local.ctx.signal.aborted).toBe(true);
    // …y lo que la persona conteste después ya no cuenta.
    prompt.answer('deny');
    expect((await running).stopReason).toBe('stop');

    const resolved = await untilType(w, 'approval.resolved');
    expect(resolved.data).toMatchObject({
      status: 'approved',
      resolvedBy: { kind: 'remote', connectionId: approver.server!.connectionId },
    });
    expect(existsSync(file)).toBe(false);
    await w.until((e) => e.type === 'run.completed');
    expect(w.states().filter(isType('approval.resolved'))).toHaveLength(1);
    expect(w.states().filter(isType('tool.started'))).toHaveLength(1);
    expect(p.provider.calls).toBe(2);
  }, 30_000);

  it('el local gana: el remoto ve la resolución y su respuesta posterior llega tarde', async () => {
    t = await startTestDaemon();
    const { p, prompt, file, approver, w } = await peerWithPrompt(t);
    const running = p.run('borra');
    const approval = await requested(w);
    await until(() => prompt.seen.length === 1);

    prompt.answer('deny');
    await running;
    const resolved = await untilType(w, 'approval.resolved');
    expect(resolved.data).toMatchObject({ status: 'denied', resolvedBy: { kind: 'local' } });
    expect(resolved.data.resolvedBy).not.toHaveProperty('connectionId');
    expect(
      await code(
        approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' }),
      ),
    ).toBe('ALREADY_RESOLVED');
    expect(existsSync(file)).toBe(true);
    expect((await approver.request('approvals.list', {})).approvals).toEqual([]);
  }, 30_000);

  it('local y remoto a la vez: una sola decisión llega al runtime', async () => {
    t = await startTestDaemon();
    for (let round = 0; round < 4; round++) {
      const { p, prompt, file, approver, w } = await peerWithPrompt(t);
      const running = p.run('borra');
      const approval = await requested(w);
      await until(() => prompt.seen.length === 1);

      // La terminal dice que no en el mismo instante en que otro cliente dice que sí.
      const remote = code(
        approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' }),
      );
      if (round % 2 === 0) prompt.answer('deny');
      else setImmediate(() => prompt.answer('deny'));
      const outcome = await remote;
      await running;

      const resolved = w.states().filter(isType('approval.resolved'));
      await until(() => w.states().some(isType('run.completed')));
      expect(w.states().filter(isType('approval.resolved'))).toHaveLength(1);
      const winner = (resolved[0] ?? w.states().filter(isType('approval.resolved'))[0])!.data;
      // Lo que se ejecutó es exactamente lo que decidió el que ganó.
      expect(outcome).toBe(winner.resolvedBy?.kind === 'remote' ? 'OK' : 'ALREADY_RESOLVED');
      expect(existsSync(file)).toBe(winner.decision === 'deny');
    }
  }, 60_000);

  it('alojar la sesión no da autoridad sobre lo que pide: ni por host, ni por pid, ni por claim', async () => {
    t = await startTestDaemon();
    const { p, prompt, file, approver, w } = await peerWithPrompt(t);
    const running = p.run('borra');
    const approval = await requested(w);
    const resolve = { approvalId: approval.id, decision: 'approve' } as const;

    // Lo que un comando lanzado por el agente tendría a mano: el token de
    // `endpoint.json`. Con él se puede pedir cualquier rol; ninguno aprueba.
    for (const roles of [['host'], ['operator'], ['observer'], ['host', 'approver']] as const) {
      const fromShell = new StratumClient({
        discovery: fileDiscovery({ dir: t.dir }),
        identity: { kind: 'cli', name: 'agent-shell', version: '0', roles: [...roles] },
        reconnect: false,
      });
      const hello = await fromShell.connect();
      expect(hello.capabilities).not.toContain('approve');
      expect(await code(fromShell.request('approvals.resolve', resolve))).toBe('FORBIDDEN');
      // Los métodos que el daemon envía al anfitrión no son algo que se pueda pedir.
      expect(
        await code(
          fromShell.request('host.resolveApproval', {
            sessionId: p.sessionId,
            approvalId: approval.id,
            decision: 'approve',
            by: { kind: 'local', at: 0 },
          }),
        ),
      ).not.toBe('OK');
      fromShell.close();
    }
    // Reclamar la sesión con su pid no la convierte en aprobada.
    const impostor = await t.connect(['host'], 'impostor');
    const { snapshot } = await approver.request('sessions.get', { sessionId: p.sessionId });
    expect(await code(impostor.request('host.register', { snapshot, pid: process.pid }))).toBe(
      'FORBIDDEN',
    );

    expect(existsSync(file)).toBe(true);
    expect(prompt.seen[0]!.ctx.signal.aborted).toBe(false);
    prompt.answer('deny');
    await running;
    expect(existsSync(file)).toBe(true);
  }, 30_000);

  it('un anfitrión no fabrica un *.resolved de lo que no es suyo: otra sesión, ya resuelto o inexistente', async () => {
    t = await startTestDaemon();
    const victim = await hosted(t);
    await victim.operator.request('runs.start', { sessionId: victim.sessionId, input: 'borra' });
    const approval = await requested(victim.w);
    const { snapshot } = await victim.approver.request('sessions.get', {
      sessionId: victim.sessionId,
    });

    // Otro proceso se registra como anfitrión de una sesión suya que «también»
    // tiene pendiente esa aprobación, con el mismo id.
    const evil = await t.connect(['host'], 'evil-host');
    const evilId = 'sess_evil_0001';
    const forged = {
      ...snapshot,
      session: {
        ...snapshot.session,
        id: evilId,
        host: { kind: 'peer' as const, client: 'cli' as const, connected: true },
        state: 'idle' as const,
        currentRunId: null,
      },
      run: null,
      toolCalls: [],
      subagents: [],
      jobs: [],
      approvals: [{ ...approval, sessionId: evilId }],
    };
    await evil.request('host.register', { snapshot: forged, pid: process.pid });
    // …y dice que ya está resuelta.
    const event = (seq: number, data: Record<string, unknown>, type: string) => ({
      type,
      sessionId: evilId,
      at: Date.now(),
      seq,
      data,
    });
    await evil.request('host.publish', {
      epoch: 1,
      sessionId: evilId,
      events: [
        event(
          forged.seq + 1,
          { approvalId: approval.id, status: 'approved', decision: 'approve' },
          'approval.resolved',
        ),
      ] as never,
    });
    // Publicar una solicitud a nombre de otra sesión no valida.
    expect(
      await code(
        evil.request('host.publish', {
          epoch: 1,
          sessionId: evilId,
          events: [event(forged.seq + 2, { approval }, 'approval.requested')] as never,
        }),
      ),
    ).toBe('INVALID_PARAMS');

    // La solicitud de la víctima sigue siendo suya, pendiente y resoluble.
    const listed = await victim.approver.request('approvals.list', {});
    expect(listed.approvals).toMatchObject([{ id: approval.id, sessionId: victim.sessionId }]);
    expect(existsSync(victim.file)).toBe(true);
    await victim.approver.request('approvals.resolve', {
      approvalId: approval.id,
      decision: 'deny',
    });
    const resolved = await untilType(victim.w, 'approval.resolved');
    expect(resolved.data).toMatchObject({ status: 'denied', resolvedBy: { kind: 'remote' } });
    await victim.w.until((e) => e.type === 'run.completed');
    expect(existsSync(victim.file)).toBe(true);

    // Ya resuelta (denegada): fabricar ahora un «aprobada» no reescribe cómo acabó…
    await evil.request('host.publish', {
      epoch: 1,
      sessionId: evilId,
      events: [
        event(
          forged.seq + 2,
          { approvalId: approval.id, status: 'approved', decision: 'approve' },
          'approval.resolved',
        ),
        // …y resolver una que no existe no hace nada.
        event(
          forged.seq + 3,
          { approvalId: 'apr_no_existe', status: 'approved' },
          'approval.resolved',
        ),
      ] as never,
    });
    await expect(
      victim.approver.request('approvals.resolve', {
        approvalId: approval.id,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_RESOLVED', data: { resolution: 'denied' } });
    expect(
      await code(
        victim.approver.request('approvals.resolve', {
          approvalId: 'apr_no_existe',
          decision: 'approve',
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(existsSync(victim.file)).toBe(true);

    // Lo mismo con preguntas y planes de otra sesión: siguen pendientes y suyos.
    const asking = await hosted(t, [
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Sigo?' }] }),
      makeTextRound('vale'),
    ]);
    await asking.operator.request('runs.start', { sessionId: asking.sessionId, input: 'pregunta' });
    const question = (await untilType(asking.w, 'question.requested')).data.request;
    await evil.request('host.publish', {
      epoch: 1,
      sessionId: evilId,
      events: [
        event(forged.seq + 4, { requestId: question.id, answers: null }, 'question.resolved'),
        event(forged.seq + 5, { requestId: question.id, decision: 'approve' }, 'plan.resolved'),
      ] as never,
    });
    expect((await asking.approver.request('approvals.list', {})).questions).toMatchObject([
      { id: question.id, sessionId: asking.sessionId },
    ]);
    // Y un anfitrión tampoco contesta por la vía de los aprobadores.
    expect(
      await code(evil.request('questions.answer', { requestId: question.id, answers: null })),
    ).toBe('FORBIDDEN');
    await asking.approver.request('questions.answer', {
      requestId: question.id,
      answers: [{ question: '', answer: 'sí' }],
    });
    expect((await untilType(asking.w, 'question.resolved')).data).toMatchObject({
      answers: [{ answer: 'sí' }],
      resolvedBy: { kind: 'remote' },
    });
  }, 40_000);

  it('si el anfitrión se desconecta, la solicitud ni se resuelve ni se inventa', async () => {
    t = await startTestDaemon({ isAlive: () => true });
    const { p, prompt, file, approver, w } = await peerWithPrompt(t);
    const running = p.run('borra');
    const approval = await requested(w);
    await until(() => prompt.seen.length === 1);

    const hostConn = t.daemon.clients.find((c) => c.client?.name === 'test-peer')!;
    (hostConn as unknown as { socket: { destroy(): void } }).socket.destroy();
    await until(
      async () =>
        (await approver.request('sessions.get', { sessionId: p.sessionId })).snapshot.session
          .state === 'detached',
    );
    // Sigue pendiente, pero ahora solo se puede contestar en su terminal.
    const listed = await approver.request('approvals.list', {});
    expect(listed.approvals).toMatchObject([{ id: approval.id, resolvable: 'origin' }]);
    const attempt = approver.request('approvals.resolve', {
      approvalId: approval.id,
      decision: 'approve',
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      data: { reason: 'host-unavailable' },
    });
    // No se dio por resuelta: el prompt local sigue abierto y la tool sin ejecutar.
    expect(prompt.seen[0]!.ctx.signal.aborted).toBe(false);
    expect(existsSync(file)).toBe(true);

    // La persona contesta en su terminal y el turno termina con normalidad.
    prompt.answer('approve');
    expect((await running).stopReason).toBe('stop');
    expect(existsSync(file)).toBe(false);
    // Al volver el anfitrión, su foto manda: ya no hay nada pendiente.
    await until(async () => (await approver.request('approvals.list', {})).approvals.length === 0);
  }, 30_000);

  it('una sesión sin anfitrión que se descarta se lleva sus solicitudes', async () => {
    let alive = true;
    t = await startTestDaemon({ isAlive: () => alive, peerWatchIntervalMs: 50 });
    const { p, prompt, approver, w } = await peerWithPrompt(t);
    const running = p.run('borra');
    const approval = await requested(w);
    await until(() => prompt.seen.length === 1);

    // El proceso del anfitrión «muere»: ni reconecta ni contesta.
    await p.bridge.close('closed', 0).catch(() => undefined);
    alive = false;
    await until(async () => (await approver.request('approvals.list', {})).approvals.length === 0);
    expect((await approver.request('core.status', {})).pendingApprovals).toBe(0);
    expect(
      await code(
        approver.request('approvals.resolve', { approvalId: approval.id, decision: 'approve' }),
      ),
    ).toBe('ALREADY_RESOLVED');
    prompt.answer('deny');
    await running;
  }, 30_000);

  it('sin terminal ni aprobador se deniega sin preguntar; con aprobador, se pregunta y caduca', async () => {
    // Sin daemon que acredite aprobadores: como `stratum run` en CI.
    t = await startTestDaemon({ approver: null });
    const alone = await startPeer(t, 'alone', destructive(), {}, { destructivePolicy: 'ask' });
    peers.push(alone);
    const untouched = victim(alone.host.env.cwd);
    expect(alone.bridge.remoteApprovals).toBe(false);
    expect(alone.host.runOptions().onConfirmDestructive).toBeUndefined();
    await alone.run('borra');
    expect(existsSync(untouched)).toBe(true);
    await alone.stop();
    peers.length = 0;
    await t.stop();

    t = await startTestDaemon();
    const p = await startPeer(
      t,
      'ci',
      destructive(),
      {},
      { destructivePolicy: 'ask', interactionTimeoutMs: 250 },
    );
    peers.push(p);
    const file = victim(p.host.env.cwd);
    expect(p.bridge.remoteApprovals).toBe(true);
    const approver = await t.connect(['approver'], 'appr');
    const w = watch(approver, p.sessionId);
    await w.untilSnapshot();
    const running = p.run('borra');
    const approval = await requested(w);
    expect(approval.expiresAt).not.toBeNull();
    const resolved = await untilType(w, 'approval.resolved');
    expect(resolved.data).toMatchObject({ status: 'expired', resolvedBy: { kind: 'timeout' } });
    await running;
    expect(existsSync(file)).toBe(true);
  }, 40_000);
});

describe('M4 — el mismo ciclo en los dos anfitriones', () => {
  it('desde un aprobador externo, alojada en el daemon y en la CLI se ven igual', async () => {
    t = await startTestDaemon();
    const lifecycle = (w: Watcher): string[] =>
      w
        .states()
        .map((e) => (e.type === 'run.updated' ? `run.updated:${e.data.run.status}` : e.type))
        .filter((type) => /^(run\.|approval\.|tool\.)/.test(type));

    const d = await hosted(t);
    await d.operator.request('runs.start', { sessionId: d.sessionId, input: 'borra' });
    const first = await requested(d.w);
    await d.approver.request('approvals.resolve', { approvalId: first.id, decision: 'approve' });
    await d.w.until((e) => e.type === 'run.completed');

    const c = await peerWithPrompt(t);
    const running = c.p.run('borra');
    const second = await requested(c.w);
    await c.approver.request('approvals.resolve', { approvalId: second.id, decision: 'approve' });
    await running;
    await c.w.until((e) => e.type === 'run.completed');

    const expected = [
      'run.started',
      'approval.requested',
      'run.updated:waiting_approval',
      'approval.resolved',
      'run.updated:running',
      'tool.started',
      'tool.completed',
      'run.completed',
    ];
    // La tool se anuncia (`tool.started`) con sus argumentos antes de pedir la
    // confirmación o después, según el loop; lo que importa es que el orden es
    // el mismo en los dos anfitriones.
    expect(lifecycle(d.w).sort()).toEqual([...expected].sort());
    expect(lifecycle(c.w)).toEqual(lifecycle(d.w));
    expect(existsSync(d.file)).toBe(false);
    expect(existsSync(c.file)).toBe(false);
    // Lo único que cambia es dónde vive la puerta: quién aloja la sesión, y si caduca.
    expect(first.expiresAt).not.toBeNull();
    expect(second.expiresAt).toBeNull();
  }, 40_000);
});

describe('M4 — búsqueda de fugas', () => {
  it('clave de aprobador, token del canal y secretos de la orden no salen por ningún lado', async () => {
    const sink = new MemorySink('trace');
    resetLogging([sink]);
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
    const dumpEnv =
      "node -e \"require('fs').writeFileSync('child.json',JSON.stringify([process.env,process.argv,process.execArgv]))\"";
    try {
      t = await startTestDaemon();
      const traces = join(t.base, 'traces');
      const s = await hosted(
        t,
        [
          // Lo que ve un proceso hijo del agente: su entorno y sus argumentos.
          makeToolCallRound('c0', 'exec', { command: dumpEnv }),
          makeToolCallRound('c1', 'exec', { command: `${RM} ; echo ${secret}` }),
          makeTextRound('hecho'),
        ],
        { trace: { enabled: true, dir: traces } },
      );
      const observer = await t.connect(['observer'], 'obs');
      const overview: unknown[] = [];
      observer.subscribeOverview({
        onOverview: (o) => overview.push(o),
        onEvent: (e) => overview.push(e),
        onError: () => undefined,
      });
      await s.operator.request('runs.start', { sessionId: s.sessionId, input: 'borra' });
      const approval = await requested(s.w);
      // Lo que ve quien aprueba está redactado en origen.
      expect(approval.description).not.toContain(secret);
      expect(approval.description).toContain('[redacted');
      const replies: unknown[] = [
        await observer.request('approvals.list', {}),
        await observer.request('sessions.get', { sessionId: s.sessionId }),
        await observer.request('core.status', {}),
        s.approver.server,
      ];
      // Peticiones rechazadas, que es donde un log descuidado repite la entrada.
      await expect(
        t.connect(['approver'], 'bad', { approverKey: `mala ${secret}` }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(
        await code(
          s.approver.request('approvals.resolve', {
            approvalId: approval.id,
            decision: 'allow-all',
            phrase: secret,
          }),
        ),
      ).toBe('OK');
      await s.w.until((e) => e.type === 'run.completed');
      replies.push(await observer.request('runs.list', {}));

      const files = (dir: string, match: RegExp): string =>
        existsSync(dir)
          ? readdirSync(dir)
              .filter((f) => match.test(f))
              .map((f) => readFileSync(join(dir, f), 'utf-8'))
              .join('\n')
          : '';
      // La traza y la auditoría se escriben en segundo plano.
      await until(() => files(traces, /\.jsonl$/).includes('"resolution"'));
      await until(() => files(t!.base, /^audit-\d+\.jsonl$/).includes('"approval"'));
      await flushLogging();

      const child = readFileSync(join(s.cwd, 'child.json'), 'utf-8');
      const surfaces: Record<string, string> = {
        logs: JSON.stringify(sink.records),
        'eventos y fotos': JSON.stringify([s.w.events, s.w.snapshots, overview]),
        'resultados (DTOs)': JSON.stringify(replies),
        auditoría: files(t.base, /^audit-\d+\.jsonl$/),
        traza: files(traces, /\.jsonl$/),
        'entorno y argumentos de un proceso hijo': child,
      };
      const token = t.daemon.endpoint.token;
      for (const [where, text] of Object.entries(surfaces)) {
        expect(text.length, where).toBeGreaterThan(50);
        expect(text.includes(TEST_APPROVER_KEY), `clave de aprobador en ${where}`).toBe(false);
        expect(text.includes(token), `token del canal en ${where}`).toBe(false);
        expect(/approverKey|approver_key/i.test(text), `campo de clave en ${where}`).toBe(false);
        if (where !== 'entorno y argumentos de un proceso hijo') {
          expect(text.includes(secret), `secreto de la orden en ${where}`).toBe(false);
          // El entorno del daemon no viaja; un hijo, en cambio, sí lo hereda.
          expect(text.includes('daemon-env'), `entorno en ${where}`).toBe(false);
        }
      }
      // Control: el volcado del hijo es de verdad su entorno, y aun así no trae credenciales.
      expect(child).toContain('daemon-env');
      // Quién resolvió sí consta, y es solo la vía y lo declarado.
      expect(surfaces['auditoría']).toContain('"by":"remote"');
      expect(surfaces['traza']).toContain('"resolution"');
      const resolved = (await untilType(s.w, 'approval.resolved')).data.resolvedBy!;
      expect(Object.keys(resolved).sort()).toEqual(['at', 'client', 'connectionId', 'kind']);
    } finally {
      resetLogging();
    }
  }, 40_000);
});
