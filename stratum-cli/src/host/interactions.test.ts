import { describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest, DestructiveDecision, Plan, QuestionItem } from '../agent/types.js';
import { ProtocolError } from '../ipc/codec.js';
import { PendingInteractions, type GateContext, type InteractionChange } from './interactions.js';

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  callId: 'call_1',
  toolName: 'exec',
  description: 'rm -rf build',
  ...over,
});

const by = { client: 'cli' as const, connectionId: 7 };

/** Un prompt local que se contesta desde el test. */
function manualGate<T>() {
  let answer!: (value: T) => void;
  let ctx: GateContext | undefined;
  const gate = vi.fn((_req: unknown, c?: GateContext) => {
    ctx = c;
    return new Promise<T>((resolve) => (answer = resolve));
  });
  return { gate, answer: (v: T) => answer(v), ctx: () => ctx! };
}

function code(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProtocolError) return err.code;
    throw err;
  }
  return 'OK';
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('PendingInteractions', () => {
  it('sin prompt local ni remoto no da puertas: el runtime no pregunta', () => {
    const gates = new PendingInteractions().gatesFor();
    expect(gates.confirm).toBeUndefined();
    expect(gates.askQuestions).toBeUndefined();
    expect(gates.approvePlan).toBeUndefined();
  });

  it('el prompt local resuelve y queda dicho que fue local', async () => {
    const local = manualGate<DestructiveDecision>();
    const center = new PendingInteractions({ local: { confirm: local.gate } });
    const changes: InteractionChange[] = [];
    center.subscribe((c) => changes.push(c));

    const decision = center.gatesFor().confirm!(request());
    await tick();
    expect(center.size).toBe(1);
    expect(center.pending()[0]!.expiresAt).toBeNull();
    local.answer('approve');
    expect(await decision).toBe('approve');
    expect(center.size).toBe(0);
    expect(changes.map((c) => c.type)).toEqual(['requested', 'resolved']);
    const resolved = changes[1] as Extract<InteractionChange, { type: 'resolved' }>;
    expect(resolved.outcome).toMatchObject({ status: 'resolved', by: { kind: 'local' } });
  });

  it('gana el remoto: el prompt local se retira y su respuesta tardía no cuenta', async () => {
    const local = manualGate<DestructiveDecision>();
    const center = new PendingInteractions({ local: { confirm: local.gate }, remote: () => true });
    const resolved: InteractionChange[] = [];
    center.subscribe((c) => c.type === 'resolved' && resolved.push(c));

    const decision = center.gatesFor().confirm!(request());
    await tick();
    const { id } = center.pending()[0]!;
    expect(local.ctx().id).toBe(id);
    expect(local.ctx().signal.aborted).toBe(false);

    center.resolveApproval(id, 'approve', undefined, by);
    expect(await decision).toBe('approve');
    expect(local.ctx().signal.aborted).toBe(true);

    local.answer('deny');
    await tick();
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as { outcome: unknown }).outcome).toMatchObject({
      decision: 'approve',
      by: { kind: 'remote', client: 'cli', connectionId: 7 },
    });
  });

  it('gana el local: la respuesta remota posterior es ALREADY_RESOLVED', async () => {
    const local = manualGate<DestructiveDecision>();
    const center = new PendingInteractions({ local: { confirm: local.gate }, remote: () => true });
    const decision = center.gatesFor().confirm!(request());
    await tick();
    const { id } = center.pending()[0]!;
    local.answer('deny');
    expect(await decision).toBe('deny');
    expect(code(() => center.resolveApproval(id, 'approve', undefined, by))).toBe(
      'ALREADY_RESOLVED',
    );
  });

  it('dos respuestas remotas: exactamente una gana', async () => {
    const center = new PendingInteractions({ remote: () => true, timeoutMs: 60_000 });
    const decision = center.gatesFor().confirm!(request());
    const { id } = center.pending()[0]!;
    const first = code(() => center.resolveApproval(id, 'approve', undefined, by));
    const second = code(() => center.resolveApproval(id, 'deny', undefined, { connectionId: 8 }));
    expect([first, second]).toEqual(['OK', 'ALREADY_RESOLVED']);
    expect(await decision).toBe('approve');
    expect(code(() => center.resolveApproval('apr_unknown', 'deny', undefined, by))).toBe(
      'NOT_FOUND',
    );
  });

  it('una respuesta que no vale no resuelve: forzada sin allow-all, y la frase exacta', async () => {
    const center = new PendingInteractions({ remote: () => true, timeoutMs: 60_000 });
    const decision = center.gatesFor().confirm!(request({ forced: true, confirmPhrase: 'prod-1' }));
    const { id } = center.pending()[0]!;
    expect(code(() => center.resolveApproval(id, 'allow-all', 'prod-1', by))).toBe(
      'INVALID_PARAMS',
    );
    expect(code(() => center.resolveApproval(id, 'approve', undefined, by))).toBe('INVALID_PARAMS');
    expect(code(() => center.resolveApproval(id, 'approve', 'prod-2', by))).toBe('INVALID_PARAMS');
    expect(center.size).toBe(1);
    center.resolveApproval(id, 'approve', 'prod-1', by);
    expect(await decision).toBe('approve');
  });

  it('sin prompt local caduca a la respuesta negativa; con él no caduca', async () => {
    vi.useFakeTimers();
    try {
      const center = new PendingInteractions({ remote: () => true, timeoutMs: 1_000 });
      const outcomes: InteractionChange[] = [];
      center.subscribe((c) => c.type === 'resolved' && outcomes.push(c));
      const decision = center.gatesFor().confirm!(request());
      const { id, expiresAt, requestedAt } = center.pending()[0]!;
      expect(expiresAt).toBe(requestedAt + 1_000);
      vi.advanceTimersByTime(1_001);
      expect(await decision).toBe('deny');
      expect((outcomes[0] as { outcome: unknown }).outcome).toMatchObject({
        status: 'expired',
        decision: 'deny',
        by: { kind: 'timeout' },
      });
      expect(code(() => center.resolveApproval(id, 'approve', undefined, by))).toBe(
        'ALREADY_RESOLVED',
      );

      const local = manualGate<DestructiveDecision>();
      const withLocal = new PendingInteractions({
        local: { confirm: local.gate },
        remote: () => true,
        timeoutMs: 1_000,
      });
      void withLocal.gatesFor().confirm!(request());
      vi.advanceTimersByTime(60_000);
      expect(withLocal.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelar el turno cancela lo pendiente y retira el prompt', async () => {
    const local = manualGate<DestructiveDecision>();
    const center = new PendingInteractions({ local: { confirm: local.gate }, remote: () => true });
    const outcomes: InteractionChange[] = [];
    center.subscribe((c) => c.type === 'resolved' && outcomes.push(c));
    const turn = new AbortController();
    const decision = center.gatesFor({ signal: turn.signal }).confirm!(request());
    await tick();
    const { id } = center.pending()[0]!;
    turn.abort();
    expect(await decision).toBe('deny');
    expect(local.ctx().signal.aborted).toBe(true);
    expect((outcomes[0] as { outcome: { status: string; by?: unknown } }).outcome.status).toBe(
      'cancelled',
    );
    expect(center.size).toBe(0);
    expect(code(() => center.resolveApproval(id, 'approve', undefined, by))).toBe(
      'ALREADY_RESOLVED',
    );
  });

  it('cancelAll no deja ninguna promesa colgada', async () => {
    const center = new PendingInteractions({ remote: () => true });
    const gates = center.gatesFor();
    const plan: Plan = { summary: 's', steps: [{ id: '1', title: 't', status: 'pending' }] };
    const all = Promise.all([
      gates.confirm!(request()),
      gates.askQuestions!([{ question: '¿Cuál?' }]),
      gates.approvePlan!(plan),
    ]);
    expect(center.size).toBe(3);
    center.cancelAll();
    expect(await all).toEqual(['deny', null, { decision: 'reject' }]);
    expect(center.size).toBe(0);
  });

  it('si ya nadie puede contestar, se resuelve por política sin esperar', async () => {
    let remote = true;
    const center = new PendingInteractions({ remote: () => remote });
    const gates = center.gatesFor();
    remote = false;
    const outcomes: InteractionChange[] = [];
    center.subscribe((c) => c.type === 'resolved' && outcomes.push(c));
    expect(await gates.confirm!(request())).toBe('deny');
    expect((outcomes[0] as { outcome: unknown }).outcome).toMatchObject({ by: { kind: 'policy' } });
  });

  it('preguntas: la respuesta remota se valida contra las opciones', async () => {
    const center = new PendingInteractions({ remote: () => true });
    const questions: QuestionItem[] = [
      {
        question: '¿Entorno?',
        options: [
          { id: 'opt_a', label: 'staging' },
          { id: 'opt_b', label: 'production' },
        ],
      },
      { question: '¿Nombre?' },
    ];
    const answers = center.gatesFor().askQuestions!(questions);
    const { id } = center.pending()[0]!;
    const bad = (a: Array<{ question: string; answer: string; optionId?: string }>): string =>
      code(() => center.answerQuestions(id, a, by));
    expect(bad([{ question: 'x', answer: 'staging' }])).toBe('INVALID_PARAMS');
    expect(
      bad([
        { question: 'x', answer: 'cualquiera' },
        { question: 'y', answer: 'n' },
      ]),
    ).toBe('INVALID_PARAMS');
    expect(
      bad([
        { question: 'x', answer: '', optionId: 'opt_z' },
        { question: 'y', answer: 'n' },
      ]),
    ).toBe('INVALID_PARAMS');
    expect(center.size).toBe(1);
    center.answerQuestions(
      id,
      [
        { question: 'ignorado', answer: 'ignorado', optionId: 'opt_b' },
        { question: 'ignorado', answer: ' Javi ' },
      ],
      by,
    );
    expect(await answers).toEqual([
      { question: '¿Entorno?', answer: 'production', optionId: 'opt_b' },
      { question: '¿Nombre?', answer: 'Javi' },
    ]);
  });

  it('plan: aprobar sin plan aprueba el propuesto; rechazar no lleva plan', async () => {
    const center = new PendingInteractions({ remote: () => true });
    const plan: Plan = { summary: 's', steps: [{ id: '1', title: 't', status: 'pending' }] };
    const gates = center.gatesFor();
    const first = gates.approvePlan!(plan);
    center.decidePlan(center.pending()[0]!.id, 'approve', undefined, by);
    expect(await first).toEqual({ decision: 'approve', plan });

    const second = gates.approvePlan!(plan);
    const id = center.pending()[0]!.id;
    expect(code(() => center.decidePlan(id, 'approve', { summary: 's', steps: [] }, by))).toBe(
      'INVALID_PARAMS',
    );
    center.decidePlan(id, 'reject', undefined, by);
    expect(await second).toEqual({ decision: 'reject' });
    // Un id de plan no resuelve una aprobación ni al revés.
    const third = gates.confirm!(request());
    expect(code(() => center.decidePlan(center.pending()[0]!.id, 'approve', undefined, by))).toBe(
      'NOT_FOUND',
    );
    center.cancelAll();
    await third;
  });
});
