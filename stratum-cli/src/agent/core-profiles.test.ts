import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StratumAgent } from './core.js';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { IProvider } from '../providers/base.js';
import type { AgentEvent, Message, RunOptions, SubagentRouter } from './types.js';

const config = StratumConfigSchema.parse({
  provider: {
    default: 'test',
    providers: {
      test: {
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: '',
        model: 'test-model',
        contextWindow: 32768,
      },
    },
  },
});

const root = mkdtempSync(join(tmpdir(), 'stratum-core-h15-'));
const agentsDir = join(root, '.stratum', 'agents');
mkdirSync(agentsDir, { recursive: true });
writeFileSync(
  join(agentsDir, 'h15-reviewer.md'),
  `---\ndescription: Reviews diffs for correctness\nmode: primary\nallowedTools: [read_file, grep]\ndestructivePolicy: deny\nmodel: big-model\n---\nYou are a strict reviewer.`,
);
writeFileSync(
  join(agentsDir, 'h15-both.md'),
  `---\ndescription: Works either way\nmode: all\n---\nYou can be both.`,
);
writeFileSync(
  join(agentsDir, 'h15-helper.md'),
  `---\ndescription: Writes documentation\n---\nYou are a docs helper.`,
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

function newAgent(extra: { initialMessages?: Message[]; activeAgent?: string } = {}) {
  return new StratumAgent(config, new ProviderRouter(config), newRegistry(), {
    profileLoader: new ProfileLoader(root),
    ...extra,
  });
}

function system(agent: StratumAgent): string {
  return agent.getMessages()[0]?.content ?? '';
}

function mockRouter(provider: IProvider): SubagentRouter {
  return {
    getActive: () => provider,
    model: 'mock',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    switchModel: () => {},
  };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('StratumAgent — índice de perfiles (Hito 15)', () => {
  it('el system prompt lista los delegables con su descripción y omite los primary', () => {
    const prompt = system(newAgent());
    expect(prompt).toContain('# Agent profiles');
    expect(prompt).toContain('| h15-helper | Writes documentation |');
    expect(prompt).toContain('| h15-both | Works either way |');
    expect(prompt).not.toContain('| h15-reviewer |');
  });
});

describe('StratumAgent.setPrimaryProfile (/agent)', () => {
  it('activa el perfil: bloque en el system prompt y aviso del modelo ignorado', () => {
    const agent = newAgent();
    const applied = agent.setPrimaryProfile('h15-reviewer');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.notes.join(' ')).toContain('big-model');
    expect(agent.getActiveProfile()?.name).toBe('h15-reviewer');
    expect(system(agent)).toContain('# Active agent profile: h15-reviewer');
    expect(system(agent)).toContain('You are a strict reviewer.');
  });

  it('el bloque sobrevive a /model, a la recarga de memoria y a /clear', () => {
    const agent = newAgent();
    agent.setPrimaryProfile('h15-reviewer');
    agent.switchModel('other-model');
    agent.reloadMemory();
    agent.clearHistory();
    expect(system(agent)).toContain('# Active agent profile: h15-reviewer');
    expect(system(agent)).toContain('other-model');
  });

  it('el perfil activo sale del índice de delegables', () => {
    const agent = newAgent();
    agent.setPrimaryProfile('h15-both');
    expect(system(agent)).toContain('# Active agent profile: h15-both');
    expect(system(agent)).not.toContain('| h15-both |');
  });

  it('off restaura el prompt por defecto', () => {
    const agent = newAgent();
    const base = system(agent);
    agent.setPrimaryProfile('h15-reviewer');
    agent.setPrimaryProfile(null);
    expect(agent.getActiveProfile()).toBeNull();
    expect(system(agent)).toBe(base);
  });

  it('rechaza un perfil subagent y uno inexistente sin tocar el prompt', () => {
    const agent = newAgent();
    const base = system(agent);
    const sub = agent.setPrimaryProfile('h15-helper');
    expect(sub.ok).toBe(false);
    if (!sub.ok) expect(sub.error).toContain('mode: subagent');
    expect(agent.setPrimaryProfile('nope').ok).toBe(false);
    expect(system(agent)).toBe(base);
  });
});

describe('StratumAgent — reanudación con perfil activo', () => {
  const saved: Message[] = [
    { role: 'system', content: 'prompt guardado' },
    { role: 'user', content: 'hola' },
  ];

  it('chat --resume recompone el system prompt con el perfil', () => {
    const agent = newAgent({ initialMessages: saved, activeAgent: 'h15-reviewer' });
    expect(agent.getActiveProfile()?.name).toBe('h15-reviewer');
    expect(system(agent)).toContain('# Active agent profile: h15-reviewer');
    expect(agent.takeResumeNotice()).toBeNull();
    expect(agent.getMessages()[1]).toEqual(saved[1]);
  });

  it('si el perfil ya no se puede activar, vuelve al prompt base y avisa', () => {
    const agent = newAgent({ initialMessages: saved, activeAgent: 'h15-helper' });
    expect(agent.getActiveProfile()).toBeNull();
    expect(system(agent)).not.toBe('prompt guardado');
    expect(system(agent)).not.toContain('# Active agent profile');
    expect(agent.takeResumeNotice()).toContain('h15-helper');
    expect(agent.takeResumeNotice()).toBeNull();
  });

  it('/sessions resume aplica el perfil de la sesión cargada, no el que había', () => {
    const agent = newAgent();
    agent.setPrimaryProfile('h15-reviewer');

    expect(agent.replaceHistory(saved)).toBeNull();
    expect(agent.getActiveProfile()).toBeNull();

    expect(agent.replaceHistory(saved, 'h15-both')).toBeNull();
    expect(agent.getActiveProfile()?.name).toBe('h15-both');

    expect(agent.replaceHistory(saved, 'h15-helper')).toContain('h15-helper');
    expect(agent.getActiveProfile()).toBeNull();
  });
});

describe('StratumAgent.runDelegate (@perfil, run --delegate)', () => {
  it('ejecuta el subagente y deja user → assistant(tool_calls) → tool → assistant', async () => {
    const agent = newAgent();
    const before = agent.getMessages().length;
    const child = new MockProvider([makeTextRound('Documenté el módulo X.')]);
    const opts: RunOptions = { makeSubagentRouter: () => mockRouter(child) };

    const events = await collect(agent.runDelegate('h15-helper', 'documenta X', opts));

    expect(events.find((e) => e.type === 'subagent_started')).toMatchObject({
      profile: 'h15-helper',
      task: 'documenta X',
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });

    const added = agent.getMessages().slice(before);
    expect(added.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(added[0]?.content).toBe('@h15-helper documenta X');
    const callId = added[1]?.tool_calls?.[0]?.id;
    expect(added[1]?.tool_calls?.[0]?.function.name).toBe('delegate_task');
    expect(added[2]?.tool_call_id).toBe(callId);
    expect(added[2]?.content).toContain('<subagent_result');
    expect(added[3]?.content).toBe('[@h15-helper] Documenté el módulo X.');
    expect(agent.toolCallCount).toBe(1);
  });

  it('un perfil primary, uno inexistente o una tarea vacía → error sin tocar el historial', async () => {
    const agent = newAgent();
    const before = agent.getMessages().length;

    const primary = await collect(agent.runDelegate('h15-reviewer', 'x'));
    expect(primary[0]).toMatchObject({ type: 'error', fatal: false });
    expect((primary[0] as { message: string }).message).toContain('primary-only');

    const unknown = await collect(agent.runDelegate('nope', 'x'));
    expect((unknown[0] as { message: string }).message).toContain("unknown profile 'nope'");

    const empty = await collect(agent.runDelegate('h15-helper', '   '));
    expect((empty[0] as { message: string }).message).toContain('Uso: @h15-helper');

    expect(agent.getMessages()).toHaveLength(before);
  });

  it('cancelado antes de arrancar: done cancelled y el par tool_call/tool queda cerrado', async () => {
    const agent = newAgent();
    const before = agent.getMessages().length;
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      agent.runDelegate('h15-helper', 'documenta X', { signal: controller.signal }),
    );

    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    const added = agent.getMessages().slice(before);
    expect(added.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(added[2]?.content).toContain('status="cancelled"');
  });
});

describe('delegate_task del modelo con un perfil primary (Hito 15)', () => {
  it('tool_error recuperable que lo distingue de un perfil inexistente', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 't', profile: 'h15-reviewer' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: new ProfileLoader(root),
    });

    const events = await collect(loop.run({}));
    const err = events.find((e) => e.type === 'tool_error') as
      | { error: string; recoverable: boolean }
      | undefined;
    expect(err?.error).toContain('primary-only');
    expect(err?.error).not.toContain('h15-reviewer,');
    expect(err?.recoverable).toBe(true);
    expect(events.some((e) => e.type === 'subagent_started')).toBe(false);
  });
});

describe('arreglos de la revisión de Codex (Hito 15)', () => {
  it('una tool fuera del perfil se rechaza al ejecutar aunque el modelo la invente', async () => {
    const parent = new MockProvider([
      makeToolCallRound('b1', 'bash', { command: 'echo hola' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: new ProfileLoader(root),
      toolsetFilter: { allowedTools: ['read_file'], controlTools: 'keep' },
    });

    const events = await collect(loop.run({}));
    const err = events.find((e) => e.type === 'tool_error') as
      | { name: string; error: string; recoverable: boolean }
      | undefined;
    expect(err?.name).toBe('bash');
    expect(err?.error).toContain('not available to this agent profile');
    expect(err?.recoverable).toBe(true);
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
  });

  it('un delegate_task oculto por el perfil tampoco lanza un subagente', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 't', profile: 'general' }),
      makeTextRound('ok'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: new ProfileLoader(root),
      toolsetFilter: { allowedTools: ['read_file'], controlTools: 'keep' },
    });

    const events = await collect(loop.run({}));
    expect(events.some((e) => e.type === 'subagent_started')).toBe(false);
    expect((events.find((e) => e.type === 'tool_error') as { name: string })?.name).toBe(
      'delegate_task',
    );
  });

  it('un perfil principal sin delegate_task no recibe índice de perfiles ni work routing', () => {
    const agent = newAgent();
    expect(system(agent)).toContain('# Work routing');
    agent.setPrimaryProfile('h15-reviewer');
    expect(system(agent)).not.toContain('# Agent profiles');
    expect(system(agent)).not.toContain('# Work routing');
  });

  it('avisa de que el budget de un perfil no limita al agente principal', () => {
    writeFileSync(
      join(agentsDir, 'h15-budget.md'),
      `---\nmode: primary\nbudget: { maxIterations: 3 }\n---\nBudgeted.`,
    );
    const applied = newAgent().setPrimaryProfile('h15-budget');
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.notes.join(' ')).toContain('budget');
  });

  it('abandonar runDelegate a mitad deja el par tool_call/tool cerrado', async () => {
    const agent = newAgent();
    const before = agent.getMessages().length;
    const child = new MockProvider([makeTextRound('hecho')]);
    const gen = agent.runDelegate('h15-helper', 'documenta X', {
      makeSubagentRouter: () => mockRouter(child),
    });

    const first = await gen.next();
    expect((first.value as AgentEvent).type).toBe('subagent_started');
    await gen.return(undefined);

    const added = agent.getMessages().slice(before);
    expect(added.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(added[2]?.tool_call_id).toBe(added[1]?.tool_calls?.[0]?.id);
  });
});
