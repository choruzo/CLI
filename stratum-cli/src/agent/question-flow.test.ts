import { describe, it, expect } from 'vitest';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { AgentEvent, Message, QuestionAnswer, QuestionItem } from './types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

describe('tool question — flujo del loop (Hito 2.5, F7)', () => {
  it('abre el gate, inyecta las respuestas como tool result y sigue el turno', async () => {
    const provider = new MockProvider([
      makeToolCallRound('q1', 'question', {
        questions: [{ question: '¿Entrypoint real?', options: ['src/index.ts', 'src/cli.ts'] }],
      }),
      makeTextRound('Anotado.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const seen: QuestionItem[][] = [];
    const events = await collect(
      loop.run({
        onAskQuestions: async (questions): Promise<QuestionAnswer[]> => {
          seen.push(questions);
          return [{ question: questions[0]!.question, answer: 'src/cli.ts' }];
        },
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]![0]!.options!.map((o) => o.label)).toEqual(['src/index.ts', 'src/cli.ts']);

    const asked = events.find((e) => e.type === 'questions_asked');
    expect(asked).toBeDefined();
    const answered = events.find((e) => e.type === 'questions_answered');
    expect((answered as { answers: QuestionAnswer[] }).answers[0]!.answer).toBe('src/cli.ts');

    const injected = messages.find((m) => m.role === 'tool' && m.name === 'question');
    expect(injected?.content).toContain('<answer>src/cli.ts</answer>');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('sin callback (CI/piped) inyecta "usuario no disponible" y no bloquea', async () => {
    const provider = new MockProvider([
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Sigo?' }] }),
      makeTextRound('Continúo con supuestos.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const events = await collect(loop.run({}));

    const answered = events.find((e) => e.type === 'questions_answered');
    expect((answered as { answers: QuestionAnswer[] | null }).answers).toBeNull();
    const injected = messages.find((m) => m.role === 'tool' && m.name === 'question');
    expect(injected?.content).toContain('unavailable="true"');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('un callback que lanza se trata como sin respuesta', async () => {
    const provider = new MockProvider([
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Sigo?' }] }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const events = await collect(
      loop.run({
        onAskQuestions: async () => {
          throw new Error('TTY perdida');
        },
      }),
    );

    const answered = events.find((e) => e.type === 'questions_answered');
    expect((answered as { answers: QuestionAnswer[] | null }).answers).toBeNull();
    expect(events.some((e) => e.type === 'error' && e.fatal)).toBe(false);
  });

  it('la tanda es única: la segunda llamada se rechaza como recuperable', async () => {
    const provider = new MockProvider([
      makeToolCallRound('q1', 'question', { questions: [{ question: 'Primera' }] }),
      makeToolCallRound('q2', 'question', { questions: [{ question: 'Segunda' }] }),
      makeTextRound('fin'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    let calls = 0;
    const events = await collect(
      loop.run({
        onAskQuestions: async (questions): Promise<QuestionAnswer[]> => {
          calls++;
          return [{ question: questions[0]!.question, answer: 'sí' }];
        },
      }),
    );

    expect(calls).toBe(1);
    const err = events.find((e) => e.type === 'tool_error');
    expect((err as { error: string }).error).toContain('tanda única');
    expect((err as { recoverable: boolean }).recoverable).toBe(true);
  });

  it('está disponible en modo plan (no se rechaza como tool mutante)', async () => {
    const provider = new MockProvider([
      makeToolCallRound('q1', 'question', { questions: [{ question: '¿Alcance?' }] }),
      makeToolCallRound('c1', 'present_plan', {
        summary: 'Plan',
        steps: [{ title: 'Paso' }],
      }),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    const events = await collect(
      loop.run({
        mode: 'plan',
        onAskQuestions: async (questions): Promise<QuestionAnswer[]> => [
          { question: questions[0]!.question, answer: 'solo el backend' },
        ],
        onApprovePlan: async () => ({ decision: 'reject' }),
      }),
    );

    expect(events.some((e) => e.type === 'questions_asked')).toBe(true);
    expect(events.some((e) => e.type === 'tool_error')).toBe(false);
    expect(events.some((e) => e.type === 'plan_proposed')).toBe(true);
  });

  it('una tanda sin preguntas utilizables devuelve tool_error recuperable', async () => {
    const provider = new MockProvider([
      makeToolCallRound('q1', 'question', { questions: [{ question: '   ' }] }),
      makeTextRound('fin'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768);

    let called = false;
    const events = await collect(
      loop.run({
        onAskQuestions: async () => {
          called = true;
          return null;
        },
      }),
    );

    expect(called).toBe(false);
    const err = events.find((e) => e.type === 'tool_error');
    expect((err as { recoverable: boolean }).recoverable).toBe(true);
  });

  it('los subagentes no ven la tool question (la TTY es del padre)', () => {
    const names = newRegistry()
      .toToolSchemas('normal', { isSubagent: true })
      .map((t) => t.function.name);
    expect(names).not.toContain('question');
    expect(
      newRegistry()
        .toToolSchemas('normal')
        .map((t) => t.function.name),
    ).toContain('question');
  });
});
