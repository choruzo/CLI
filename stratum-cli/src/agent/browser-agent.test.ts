import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StratumAgent } from './core.js';
import { ProfileLoader } from './profiles.js';
import type { PromptPreset } from './presets.js';
import type { AgentEvent } from './types.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { buildAssistantRegistry } from '../host/assistant.js';
import { BROWSER_TOOLS } from '../tools/browser/names.js';
import { createSessionEnv } from '../runtime/session-env.js';

/** «Navegador» que existe en cualquier máquina: no se lanza en estos tests. */
function makeConfig(
  browser: Record<string, unknown> = { executable: process.execPath },
): StratumConfig {
  return StratumConfigSchema.parse({
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
    memory: { globalFile: '/nonexistent/stratum-test/STRATUM.md', autoExtract: false },
    tools: { browser },
  });
}

class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push(req);
    return super.complete(req);
  }
}

const dirs: string[] = [];
const agents: StratumAgent[] = [];

beforeEach(() => {
  // `vitest.config.ts` lo apaga para el resto de los tests.
  vi.stubEnv('STRATUM_NO_BROWSER', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(agents.splice(0).map((a) => a.dispose()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function firstRequest(
  preset: PromptPreset,
  config: StratumConfig,
  assistantRegistry = false,
) {
  const cwd = mkdtempSync(join(tmpdir(), 'stratum-browser-agent-'));
  dirs.push(cwd);
  const registry = assistantRegistry ? buildAssistantRegistry(config) : new ToolRegistry();
  if (!assistantRegistry) registerBuiltinTools(registry, config);
  const router = new ProviderRouter(config);
  const provider = new RecordingProvider([makeTextRound('ok')]);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  const agent = new StratumAgent(config, router, registry, {
    profileLoader: new ProfileLoader([]),
    promptPreset: preset,
    env: createSessionEnv({ cwd, env: process.env }),
    snapshots: false,
  });
  agents.push(agent);
  const events: AgentEvent[] = [];
  for await (const ev of agent.run('hola')) events.push(ev);
  const req = provider.requests[0]!;
  const system = String(req.messages[0]?.content ?? '');
  const offered = (req.tools ?? []).map((t) => t.function.name);
  return { agent, system, offered };
}

describe('navegador del agente en StratumAgent', () => {
  it('el agente de código lo tiene: tools (sin captura sin visión) y bloque # Browser', async () => {
    const { agent, system, offered } = await firstRequest('coding', makeConfig());
    expect(agent.browser).toBeDefined();
    for (const name of BROWSER_TOOLS.filter((n) => n !== 'browser_screenshot')) {
      expect(offered, name).toContain(name);
    }
    expect(offered).not.toContain('browser_screenshot');
    expect(system).toContain('# Browser');
    // Arranque perezoso: ofrecerlo no lanza nada.
    expect(agent.browser!.state).toBe('closed');
  });

  it('el asistente también', async () => {
    const { agent, system, offered } = await firstRequest('assistant', makeConfig(), true);
    expect(agent.browser).toBeDefined();
    expect(offered).toContain('browser_navigate');
    expect(system).toContain('# Browser');
  });

  it('el companion no, aunque las tools estén registradas', async () => {
    const { agent, system, offered } = await firstRequest('companion', makeConfig());
    expect(agent.browser).toBeUndefined();
    for (const name of BROWSER_TOOLS) expect(offered).not.toContain(name);
    expect(system).not.toContain('# Browser');
  });

  it('apagado (o sin navegador) ni se registra ni sale en el prompt', async () => {
    const off = await firstRequest(
      'coding',
      makeConfig({ enabled: false, executable: process.execPath }),
    );
    expect(off.agent.browser).toBeUndefined();
    expect(off.offered.some((n) => n.startsWith('browser_'))).toBe(false);
    expect(off.system).not.toContain('# Browser');
    const missing = await firstRequest(
      'coding',
      makeConfig({ executable: join(tmpdir(), 'no-existe.exe') }),
    );
    expect(missing.agent.browser).toBeUndefined();
    expect(missing.system).not.toContain('# Browser');
  });

  it('dispose cierra el navegador de la sesión', async () => {
    const { agent } = await firstRequest('coding', makeConfig());
    await agent.dispose();
    expect(agent.browser!.state).toBe('dead');
  });
});
