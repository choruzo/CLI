/**
 * M18 — el centro de aprobaciones con el enlace de un canal externo: aplica los
 * límites de A9 por su cuenta (sin fiarse de qué botones se enseñaron), resuelve
 * con `by.kind: 'channel'` y avisa de lo que entra y sale.
 */
import { describe, expect, it } from 'vitest';
import type { ProtocolApproval, ProtocolEvent, ProtocolResolver } from '../protocol/index.js';
import { ApprovalCenter, type InteractionRoute, type PendingChange } from './approval-center.js';
import { TELEGRAM_LINK } from './channel-approvals.js';

function approval(over: Partial<ProtocolApproval> = {}): ProtocolApproval {
  return {
    id: 'ap1',
    kind: 'tool',
    sessionId: 's1',
    runId: 'r1',
    tool: 'exec',
    description: 'rm -rf build',
    forced: false,
    resolvable: 'anywhere',
    requestedAt: 1,
    expiresAt: null,
    status: 'pending',
    ...over,
  };
}

/** `resolve` rechaza de forma síncrona lo que no puede valer. */
const attempt = (fn: () => Promise<void>): Promise<void> => Promise.resolve().then(fn);

function setup() {
  const delivered: { id: string; decision: string; by: ProtocolResolver }[] = [];
  const route: InteractionRoute = {
    resolveApproval: (id, decision, _phrase, by) => {
      delivered.push({ id, decision, by });
    },
    answerQuestions: () => undefined,
    decidePlan: () => undefined,
  };
  const center = new ApprovalCenter({
    routeOf: () => route,
    hostsSession: () => false,
    reachable: () => true,
    now: () => 42,
  });
  const changes: PendingChange[] = [];
  center.subscribe((c) => changes.push(c));
  const request = (a: ProtocolApproval): void =>
    center.apply({
      type: 'approval.requested',
      sessionId: a.sessionId,
      seq: 1,
      at: 1,
      data: { approval: a },
    } as ProtocolEvent);
  return { center, delivered, changes, request };
}

describe('ApprovalCenter con un canal (M18, A9)', () => {
  it('aprobar una vez desde el canal: by channel, sin conexión ni cliente', async () => {
    const { center, delivered, changes, request } = setup();
    request(approval());
    expect(changes[0]).toMatchObject({ type: 'added', kind: 'approval' });
    await center.resolve(TELEGRAM_LINK, { kind: 'approval', id: 'ap1', decision: 'approve' });
    expect(delivered).toEqual([
      { id: 'ap1', decision: 'approve', by: { kind: 'channel', channel: 'telegram', at: 42 } },
    ]);
    expect(changes[1]).toMatchObject({
      type: 'closed',
      id: 'ap1',
      resolution: 'approved',
      by: { kind: 'channel' },
    });
  });

  it('lo forzado, con frase o una host key no se aprueba desde el canal (y sigue pendiente); denegar, sí', async () => {
    for (const over of [
      { forced: true },
      { confirmPhrase: 'prod' },
      { kind: 'host-key' as const },
    ]) {
      const { center, delivered, request } = setup();
      request(approval(over));
      await expect(
        attempt(() =>
          center.resolve(TELEGRAM_LINK, { kind: 'approval', id: 'ap1', decision: 'approve' }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(center.list().approvals).toHaveLength(1);
      await center.resolve(TELEGRAM_LINK, { kind: 'approval', id: 'ap1', decision: 'deny' });
      expect(delivered.map((d) => d.decision)).toEqual(['deny']);
    }
  });

  it('allow-all y concesiones nunca, aunque la solicitud las admita', async () => {
    const { center, delivered, request } = setup();
    request(approval({ grantable: true }));
    for (const r of [
      { decision: 'allow-all' as const },
      { decision: 'approve' as const, grant: { minutes: 30 as const } },
    ]) {
      await expect(
        attempt(() => center.resolve(TELEGRAM_LINK, { kind: 'approval', id: 'ap1', ...r })),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    expect(delivered).toEqual([]);
  });

  it('un plan (6C) se aprueba o rechaza desde el canal, pero no se edita', async () => {
    const { center } = setup();
    center.apply({
      type: 'plan.proposed',
      sessionId: 's1',
      seq: 1,
      at: 1,
      data: {
        request: {
          id: 'pl1',
          sessionId: 's1',
          runId: 'r1',
          plan: { steps: [] },
          requestedAt: 1,
          expiresAt: null,
        },
      },
    } as unknown as ProtocolEvent);
    await expect(
      attempt(() =>
        center.resolve(TELEGRAM_LINK, {
          kind: 'plan',
          id: 'pl1',
          decision: 'approve',
          plan: { summary: 'otro', steps: [] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(center.list().plans).toHaveLength(1);
    await center.resolve(TELEGRAM_LINK, { kind: 'plan', id: 'pl1', decision: 'approve' });
    expect(center.list().plans).toHaveLength(0);
  });

  it('resuelta en otro sitio: el aviso de cierre lleva quién', () => {
    const { center, changes, request } = setup();
    request(approval());
    center.apply({
      type: 'approval.resolved',
      sessionId: 's1',
      seq: 2,
      at: 2,
      data: {
        approvalId: 'ap1',
        status: 'approved',
        resolvedBy: { kind: 'remote', client: 'dot', at: 2 },
      },
    } as ProtocolEvent);
    expect(changes.at(-1)).toMatchObject({
      type: 'closed',
      resolution: 'approved',
      by: { kind: 'remote', client: 'dot' },
    });
  });
});
