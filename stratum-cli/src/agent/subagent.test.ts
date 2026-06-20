import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProfileLoader, parseProfile, GENERAL_PROFILE } from './profiles.js';
import { runSubagent, serializeSubagentResult, generateSubagentId } from './subagent.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { AgentProfile, Message, SubagentResult, SubagentRouter } from './types.js';
import type { CompletionRequest, OpenAIStreamChunk, IProvider } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

function newRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

/** Router de prueba que envuelve un IProvider mock (no abre conexiones). */
function mockRouter(provider: IProvider): SubagentRouter {
  return {
    getActive: () => provider,
    model: 'mock-model',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    switchModel: () => {},
  };
}

const researchProfile: AgentProfile = {
  name: 'research',
  allowedTools: ['read_file', 'glob', 'list_directory', 'grep'],
  destructivePolicy: 'deny',
  budget: { maxIterations: 15, timeoutMs: 120_000 },
  systemPromptFragment: 'You are a research subagent. Explore and summarize.',
};

describe('ProfileLoader (Hito 8A)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stratum-profiles-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('descubre perfiles de proyecto y expone el general embebido', () => {
    const agentsDir = join(dir, '.stratum', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'research.md'),
      `---\nallowedTools: [read_file, glob, grep]\ndestructivePolicy: deny\nbudget: { maxIterations: 15, timeoutMs: 120000 }\n---\nYou are research.`,
    );

    const loader = new ProfileLoader(dir);
    const research = loader.resolve('research');
    expect(research).toBeDefined();
    expect(research?.allowedTools).toEqual(['read_file', 'glob', 'grep']);
    expect(research?.destructivePolicy).toBe('deny');
    expect(research?.budget.maxIterations).toBe(15);
    expect(research?.budget.timeoutMs).toBe(120_000);
    expect(research?.systemPromptFragment).toContain('research');

    // general embebido siempre disponible
    expect(loader.resolve('general')).toBeDefined();
    expect(loader.availableNames()).toContain('research');
    expect(loader.availableNames()).toContain('general');
    // perfil inexistente
    expect(loader.resolve('nope')).toBeUndefined();
  });

  it('parseProfile: allowedTools omitido → null (hereda todas)', () => {
    const p = parseProfile('code', `---\nprovider: main\n---\nYou are code.`);
    expect(p).not.toBeNull();
    expect(p?.allowedTools).toBeNull();
    expect(p?.provider).toBe('main');
    expect(p?.budget.maxIterations).toBe(GENERAL_PROFILE.budget.maxIterations);
  });
});

describe('Filtrado de toolset por perfil + profundidad=1 (Hito 8A)', () => {
  it('un perfil research no ve bash/edit_file pero sí read_file', () => {
    const reg = newRegistry();
    const schemas = reg.toToolSchemas('normal', {
      allowedTools: researchProfile.allowedTools,
      isSubagent: true,
    });
    const names = schemas.map((s) => s.function.name);
    expect(names).toContain('read_file');
    expect(names).toContain('grep');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('edit_file');
    expect(names).not.toContain('write_file');
  });

  it('un subagente nunca ve delegate_task (profundidad = 1)', () => {
    const reg = newRegistry();
    // allowedTools null = hereda todas, pero isSubagent oculta delegate_task.
    const names = reg
      .toToolSchemas('normal', { allowedTools: null, isSubagent: true })
      .map((s) => s.function.name);
    expect(names).toContain('bash');
    expect(names).not.toContain('delegate_task');

    // El loop padre (sin filtro de subagente) SÍ ve delegate_task.
    const parentNames = reg.toToolSchemas('normal').map((s) => s.function.name);
    expect(parentNames).toContain('delegate_task');
  });
});

describe('runSubagent (Hito 8A)', () => {
  it('contexto aislado: el hijo solo recibe system(subagente) + task, no el historial del padre', async () => {
    let captured: Message[] | null = null;
    const provider: IProvider = {
      async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
        // Snapshot: el loop muta this.messages in-place tras la ronda; copiamos
        // para inspeccionar el contexto tal como estaba en el momento de la llamada.
        captured = req.messages.map((m) => ({ ...m }));
        yield* makeTextRound('Resumen del trabajo.');
      },
      async healthCheck() {
        return true;
      },
    };

    const result = await runSubagent({
      task: { id: 'sub_test', task: 'Investiga el módulo X', profile: 'research', budget: researchProfile.budget },
      profile: researchProfile,
      registry: newRegistry(),
      config,
      parentSignal: new AbortController().signal,
      makeRouter: () => mockRouter(provider),
    });

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Resumen del trabajo.');
    expect(captured).not.toBeNull();
    const msgs = captured!;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe('system');
    expect(msgs[0]?.content).toContain('subagent');
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.content).toContain('Investiga el módulo X');
    // No hay rastro del historial del padre.
    expect(msgs.some((m) => m.content?.includes('PADRE-HISTORIAL'))).toBe(false);
  });

  it('trunca el resumen al cap antes de devolverlo al padre', async () => {
    const huge = 'x'.repeat(50_000);
    const provider = new MockProvider([makeTextRound(huge)]);
    const result = await runSubagent({
      task: { id: 'sub_big', task: 't', profile: 'general', budget: GENERAL_PROFILE.budget },
      profile: GENERAL_PROFILE,
      registry: newRegistry(),
      config,
      parentSignal: new AbortController().signal,
      makeRouter: () => mockRouter(provider),
    });
    expect(result.summary.length).toBeLessThan(huge.length);
    expect(result.summary).toContain('output truncated');
  });

  it('agotar maxIterations → status budget_exceeded con resultado parcial', async () => {
    // El provider siempre pide un glob → el loop nunca para; con maxIterations=1
    // se agota el presupuesto.
    const provider = new MockProvider([makeToolCallRound('g1', 'glob', { pattern: '*.none' })]);
    const profile: AgentProfile = { ...GENERAL_PROFILE, budget: { maxIterations: 1 } };
    const result = await runSubagent({
      task: { id: 'sub_budget', task: 't', profile: 'general', budget: profile.budget },
      profile,
      registry: newRegistry(),
      config,
      parentSignal: new AbortController().signal,
      makeRouter: () => mockRouter(provider),
    });
    expect(result.status).toBe('budget_exceeded');
    expect(result.error).toBeDefined();
  });

  it('signal del padre abortado → el hijo termina cancelado (signal encadenado)', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = new MockProvider([makeTextRound('no debería llegar')]);
    const result = await runSubagent({
      task: { id: 'sub_cancel', task: 't', profile: 'general', budget: GENERAL_PROFILE.budget },
      profile: GENERAL_PROFILE,
      registry: newRegistry(),
      config,
      parentSignal: ac.signal,
      makeRouter: () => mockRouter(provider),
    });
    expect(result.status).toBe('cancelled');
  });

  it('provider del perfil mal configurado (sin makeRouter ni config.provider) → failed, no lanza', async () => {
    const result = await runSubagent({
      task: { id: 'sub_fail', task: 't', profile: 'general', budget: GENERAL_PROFILE.budget },
      profile: GENERAL_PROFILE,
      registry: newRegistry(),
      config, // sin provider configurado
      parentSignal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/provider/i);
  });
});

describe('serializeSubagentResult (Hito 8A)', () => {
  it('serializa a XML con summary, files_changed y error', () => {
    const result: SubagentResult = {
      id: 'sub_x',
      status: 'completed',
      summary: 'Hecho & <listo>',
      filesChanged: [{ path: 'src/a.ts', action: 'modified' }],
      usage: { iterations: 3, durationMs: 1200 },
    };
    const xml = serializeSubagentResult(result, 'code');
    expect(xml).toContain('<subagent_result id="sub_x" profile="code" status="completed"');
    expect(xml).toContain('iterations="3"');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;listo&gt;');
    expect(xml).toContain('<file path="src/a.ts" action="modified" />');
  });
});

describe('generateSubagentId', () => {
  it('genera ids con prefijo sub_', () => {
    expect(generateSubagentId()).toMatch(/^sub_\d{8}_\d{6}_[a-z0-9]+$/);
  });
});
