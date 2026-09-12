import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import { ChangeTracker, LARGE_AUTHORED_CHANGE_LINES } from './risk.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildSkillsBlock } from '../skills/registry.js';
import type { AgentEvent, Message, RunOptions, SubagentRouter } from './types.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';

const config = StratumConfigSchema.parse({});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-risk-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

describe('protección del revisor — flujo del loop (Hito 12)', () => {
  it('emite un warning cuando el cambio acumulado cruza el umbral', async () => {
    const content = Array.from(
      { length: LARGE_AUTHORED_CHANGE_LINES + 10 },
      (_, i) => `l${i}`,
    ).join('\n');
    const provider = new MockProvider([
      makeToolCallRound('c1', 'write_file', { path: join(tmp, 'grande.ts'), content }),
      makeTextRound('Escrito.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const changes = new ChangeTracker();
    const loop = new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, {
      changes,
    });

    const events = await collect(loop.run({}));
    const warning = events.find(
      (e) => e.type === 'warning' && e.message.startsWith('large_change'),
    ) as { message: string } | undefined;

    expect(warning).toBeDefined();
    expect(warning!.message).toContain('riesgo high');
    expect(changes.authoredLines).toBeGreaterThanOrEqual(LARGE_AUTHORED_CHANGE_LINES);
  });

  it('un cambio pequeño no emite ningún warning', async () => {
    const provider = new MockProvider([
      makeToolCallRound('c1', 'write_file', { path: join(tmp, 'chico.ts'), content: 'a\nb\n' }),
      makeTextRound('Escrito.'),
    ]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const events = await collect(
      new ReactLoop(provider, newRegistry(), messages, config, 'm', 32768, undefined, {
        changes: new ChangeTracker(),
      }).run({}),
    );

    expect(events.some((e) => e.type === 'warning' && e.message.startsWith('large_change'))).toBe(
      false,
    );
  });
});

describe('índice de skills en el prompt (Hito 12)', () => {
  const skills = buildSkillsBlock([
    {
      name: 'deploy',
      description: 'Publicar una release',
      path: '/p/.stratum/skills/deploy/SKILL.md',
      scope: 'project',
      source: '.stratum/skills',
    },
  ]);

  it('se inyecta en el agente principal y también en el subagente', () => {
    expect(buildSystemPrompt(config, undefined, { skills })).toContain('# Skills');
    expect(buildSystemPrompt(config, undefined, { skills, isSubagent: true })).toContain('deploy');
  });

  it('sin skills no añade sección alguna', () => {
    expect(buildSystemPrompt(config, undefined, {})).not.toContain('# Skills');
  });

  it('el hijo delegado hereda el índice del padre (no redescubre)', async () => {
    const parent = new MockProvider([
      makeToolCallRound('d1', 'delegate_task', { task: 'Explora', profile: 'general' }),
      makeTextRound('Listo.'),
    ]);
    const childProvider = new MockProvider([makeTextRound('Hecho.')]);
    const seen: CompletionRequest[] = [];
    const spyChild: IProvider = {
      async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
        seen.push(req);
        yield* childProvider.complete(req);
      },
      healthCheck: async () => true,
    };
    const childRouter: SubagentRouter = {
      getActive: () => spyChild,
      model: 'mock',
      providerName: 'mock',
      contextWindow: 32768,
      hasFallback: false,
      advanceProvider: () => null,
      switchModel: () => {},
    };

    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(parent, newRegistry(), messages, config, 'm', 32768, undefined, {
      profiles: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-noprofiles-'))),
      skillsBlock: skills,
    });
    const opts: RunOptions = { makeSubagentRouter: () => childRouter };
    await collect(loop.run(opts));

    const childSystem = seen[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(childSystem).toContain('# Skills');
    expect(childSystem).toContain('deploy');
  });
});
