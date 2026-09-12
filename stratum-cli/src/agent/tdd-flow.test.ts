import { describe, it, expect } from 'vitest';
import { ReactLoop } from './harness.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { TddLedger, parseTddSnapshot } from './tdd.js';
import { buildSystemPrompt, buildTestingDisciplineBlock } from './system-prompt.js';
import { TEST_EVIDENCE_TOOL } from '../tools/tdd.js';
import type { AgentEvent, Message } from './types.js';

const baseConfig = StratumConfigSchema.parse({});
const tddConfig = StratumConfigSchema.parse({ tools: { testCommand: 'npm test' } });

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function newRegistry(config = tddConfig): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

describe('registro condicional de test_evidence (Hito 13)', () => {
  it('sin tools.testCommand la tool no existe: el modelo no la ve', () => {
    const names = newRegistry(baseConfig)
      .list()
      .map((t) => t.name);
    expect(names).not.toContain(TEST_EVIDENCE_TOOL);
  });

  it('con tools.testCommand la tool se registra', () => {
    const names = newRegistry()
      .list()
      .map((t) => t.name);
    expect(names).toContain(TEST_EVIDENCE_TOOL);
  });

  it('el bloque de prompt solo aparece cuando hay comando de tests', () => {
    expect(buildTestingDisciplineBlock('')).toBe('');
    expect(buildTestingDisciplineBlock('  ')).toBe('');
    expect(buildSystemPrompt(baseConfig)).not.toContain('# Testing discipline');
    const prompt = buildSystemPrompt(tddConfig);
    expect(prompt).toContain('# Testing discipline');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('TRIANGULATE');
  });

  it('los subagentes también reciben el bloque: son quienes ejecutan el ciclo', () => {
    const prompt = buildSystemPrompt(tddConfig, undefined, { isSubagent: true });
    expect(prompt).toContain('# Testing discipline');
  });
});

describe('test_evidence — flujo del loop (Hito 13)', () => {
  it('se intercepta: no se despacha y devuelve el snapshot', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', TEST_EVIDENCE_TOOL, {
        action: 'record',
        task: 'suma',
        phase: 'red',
        outcome: 'fail',
        evidence: '1 failing',
      }),
      makeTextRound('Listo.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const tdd = new TddLedger();
    const loop = new ReactLoop(
      provider,
      newRegistry(),
      messages,
      tddConfig,
      'm',
      32768,
      undefined,
      { tdd },
    );

    const events = await collect(loop.run({}));

    const result = messages.find((m) => m.role === 'tool' && m.name === TEST_EVIDENCE_TOOL);
    expect(parseTddSnapshot(result!.content!)).toHaveLength(1);
    expect(tdd.snapshot[0]).toMatchObject({ task: 'suma', phase: 'red' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('un GREEN sin RED vuelve como tool_error recuperable, no como fallo fatal', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', TEST_EVIDENCE_TOOL, {
        action: 'record',
        task: 'suma',
        phase: 'green',
        outcome: 'pass',
        evidence: '1 passing',
      }),
      makeTextRound('Corrijo.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      provider,
      newRegistry(),
      messages,
      tddConfig,
      'm',
      32768,
      undefined,
      { tdd: new TddLedger() },
    );

    const events = await collect(loop.run({}));
    const error = events.find((e) => e.type === 'tool_error') as {
      error: string;
      recoverable: boolean;
    };
    expect(error.recoverable).toBe(true);
    expect(error.error).toContain('No hay un RED registrado');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('reinyecta el ciclo abierto en el system prompt antes de la iteración siguiente', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', TEST_EVIDENCE_TOOL, {
        action: 'record',
        task: 'parser de fechas',
        phase: 'red',
        outcome: 'fail',
        evidence: '1 failing',
      }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      provider,
      newRegistry(),
      messages,
      tddConfig,
      'm',
      32768,
      undefined,
      { tdd: new TddLedger() },
    );

    await collect(loop.run({}));

    expect(messages[0]!.content).toContain('# TDD cycle in progress');
    expect(messages[0]!.content).toContain('parser de fechas');
  });

  it('action list lee la evidencia sin registrar nada', async () => {
    const tdd = new TddLedger();
    tdd.record({ task: 'suma', phase: 'red', outcome: 'fail', evidence: '1 failing' });

    const provider = new MockProvider([
      makeToolCallRound('c1', TEST_EVIDENCE_TOOL, { action: 'list' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      provider,
      newRegistry(),
      messages,
      tddConfig,
      'm',
      32768,
      undefined,
      { tdd },
    );

    await collect(loop.run({}));
    expect(tdd.snapshot).toHaveLength(1);
  });
});
