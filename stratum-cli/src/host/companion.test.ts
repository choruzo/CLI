import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionHost, type SessionHostOptions } from './session-host.js';
import {
  buildCompanionConfig,
  companionWorkspaceDir,
  ensureCompanionWorkspace,
} from './companion.js';
import { buildAssistantConfig } from './assistant.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { ASSISTANT_TOOLS, COMPANION_TOOLS } from '../agent/presets.js';
import { buildCompanionPrompt } from '../agent/system-prompt.js';
import { containerBackend } from '../tools/exec/backends/container.js';
import { localBackend } from '../tools/exec/backends/local.js';
import { sshBackend } from '../tools/exec/backends/ssh.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent } from '../agent/types.js';

/**
 * M14 — el agente embebido `companion` (PRD de Dot §23.3, §23.6): `exec` solo
 * en su caja, sin ficheros del anfitrión, y su propia memoria.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-companion-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeConfig(extra: Record<string, unknown> = {}): StratumConfig {
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
    memory: { autoExtract: false, globalFile: join(root, 'global-STRATUM.md') },
    tools: { auditLog: false },
    trace: { enabled: false },
    ssh: { hosts: { portatil: { host: '127.0.0.1', user: 'u', useAgent: true } } },
    ...extra,
  });
}

class RecordingProvider extends MockProvider {
  readonly requests: CompletionRequest[] = [];
  override complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    this.requests.push(req);
    return super.complete(req);
  }
}

const hosts: SessionHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((h) => h.dispose({ cancelBackground: true })));
});

let n = 0;
async function companionHost(
  provider: MockProvider,
  opts: { box?: boolean; extra?: Partial<SessionHostOptions> } = {},
): Promise<{ host: SessionHost; dataDir: string }> {
  const dataDir = join(root, `data-${++n}`);
  const config = makeConfig(opts.box === false ? {} : { box: { enabled: true, name: 'box' } });
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd: ensureCompanionWorkspace(dataDir), env: {} }),
    config,
    router,
    preset: 'companion',
    companionDataDir: dataDir,
    ...opts.extra,
  });
  hosts.push(host);
  return { host, dataDir };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function offered(provider: RecordingProvider): string[] {
  return (provider.requests[0]?.tools ?? []).map((t) => t.function.name).sort();
}

const CODING_MARKERS = [
  '# Shell',
  'Working directory',
  '# Work routing',
  '# Testing discipline',
  'delegate_task',
  'present_plan',
  'Project Memory',
  'repository',
  '# Workspace',
  'Stratum Desktop, a desktop app',
];

describe('companion — prompt y toolset', () => {
  it('con caja: sus tools más exec, sin ficheros del anfitrión ni nada de código', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const { host } = await companionHost(provider);
    await collect(host.run('hola'));
    expect(offered(provider)).toEqual([...COMPANION_TOOLS].sort());
    for (const tool of ['read_file', 'write_file', 'list_directory', 'glob', 'grep']) {
      expect(offered(provider)).not.toContain(tool);
    }
    const prompt = host.agent.getMessages()[0]?.content ?? '';
    expect(prompt).toContain('Stratum Dot');
    expect(prompt).toContain('# Your box');
    expect(prompt).toContain('container:box');
    for (const marker of CODING_MARKERS) expect(prompt, marker).not.toContain(marker);
  });

  it('sin caja habilitada no hay exec y el prompt lo dice', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const { host } = await companionHost(provider, { box: false });
    await collect(host.run('hola'));
    expect(offered(provider)).toEqual([...ASSISTANT_TOOLS].sort());
    const prompt = host.agent.getMessages()[0]?.content ?? '';
    expect(prompt).not.toContain('# Your box');
    expect(prompt).toContain('cannot run commands');
  });

  it('no admite perfiles de agente ni de sesión, y no carga MCP ni plugins', async () => {
    const { host } = await companionHost(new MockProvider([]));
    expect(host.agent.setPrimaryProfile('general').ok).toBe(false);
    expect(host.agent.setSessionProfile('full').ok).toBe(false);
    expect(host.plugins.size).toBe(0);
    expect(host.config.mcp.servers).toEqual([]);
    expect(Object.keys(host.config.ssh?.hosts ?? {})).toEqual([]);
    expect(host.agent.jobs).toBeUndefined();
  });

  it('su directorio de trabajo es el suyo, dentro de sus datos', async () => {
    const { host, dataDir } = await companionHost(new MockProvider([]));
    expect(host.env.cwd).toBe(companionWorkspaceDir(dataDir));
  });
});

describe('companion — exec solo en su caja (§23.3)', () => {
  it.each([
    ['local', { target: 'local', command: 'cat notas.txt' }],
    ['sin target', { command: 'cat notas.txt' }],
    ['ssh', { target: 'ssh:portatil', command: 'cat notas.txt' }],
    ['otro contenedor', { target: 'container:postgres', command: 'cat notas.txt' }],
  ])('%s: se veta en preflight y nunca llega a un backend', async (_label, args) => {
    const local = vi.spyOn(localBackend, 'run');
    const ssh = vi.spyOn(sshBackend, 'run');
    const box = vi.spyOn(containerBackend, 'run');
    const confirm = vi.fn(async () => 'approve' as const);
    const { host } = await companionHost(
      new MockProvider([makeToolCallRound('c1', 'exec', args), makeTextRound('no puedo')]),
      // Ni con todo permitido: el veto no es una confirmación.
      { extra: { destructivePolicy: 'allow', allowDestructive: true, gates: { confirm } } },
    );
    const events = await collect(host.run('lee notas.txt de mi ordenador'));
    const err = events.find((e) => e.type === 'tool_error') as
      | { name: string; error: string; blocked?: string }
      | undefined;
    expect(err?.name).toBe('exec');
    expect(err?.error).toContain('only run commands in its box');
    expect(err?.blocked).toBe('preflight');
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
    expect(local).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
    expect(box).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('en su caja instala y ejecuta sin pedir aprobación', async () => {
    const box = vi.spyOn(containerBackend, 'run').mockResolvedValue({
      status: 'exited',
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    });
    const confirm = vi.fn(async () => 'deny' as const);
    const { host } = await companionHost(
      new MockProvider([
        makeToolCallRound('c1', 'exec', {
          target: 'container:box',
          command: 'sudo apt-get install -y jq',
        }),
        makeToolCallRound('c2', 'exec', {
          target: 'container:box',
          command: 'rm -rf /home/stratum/tmp/build',
        }),
        makeTextRound('hecho'),
      ]),
      { extra: { destructivePolicy: 'ask', gates: { confirm } } },
    );
    const events = await collect(host.run('instala jq y limpia el build'));
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
    expect(events.some((e) => e.type === 'tool_error')).toBe(false);
    expect(box).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('companion — su memoria (§23.6)', () => {
  it('ve su STRATUM.md, no el global del asistente, y el asistente no ve el suyo', async () => {
    const { host, dataDir } = await companionHost(new MockProvider([]), {
      extra: {},
    });
    // Las rutas son las suyas, distintas de las del asistente y de un proyecto.
    const base = makeConfig();
    const assistant = buildAssistantConfig(base, join(root, 'assistant'));
    expect(host.config.memory.decisionsFile).toBe(join(dataDir, 'memory', 'decisions.json'));
    expect(host.config.memory.vectorDb).toBe(join(dataDir, 'memory', 'vectors.db'));
    expect(host.config.memory.decisionsFile).not.toBe(assistant.memory.decisionsFile);
    expect(host.config.memory.globalFile).toBe(join(dataDir, 'STRATUM.md'));

    writeFileSync(join(dataDir, 'STRATUM.md'), 'MEMORIA-COMPANION-XYZ', 'utf-8');
    writeFileSync(join(root, 'global-STRATUM.md'), 'MEMORIA-GLOBAL-XYZ', 'utf-8');
    try {
      const { host: fresh } = await companionHost(new MockProvider([]));
      // Otro dataDir: su STRATUM.md no existe todavía.
      expect(fresh.agent.getMessages()[0]?.content).not.toContain('MEMORIA-GLOBAL-XYZ');

      const config = makeConfig({ box: { enabled: true } });
      const router = new ProviderRouter(config);
      const again = await SessionHost.create({
        env: createSessionEnv({ cwd: ensureCompanionWorkspace(dataDir), env: {} }),
        config,
        router,
        preset: 'companion',
        companionDataDir: dataDir,
      });
      hosts.push(again);
      const companionPrompt = again.agent.getMessages()[0]?.content ?? '';
      expect(companionPrompt).toContain('MEMORIA-COMPANION-XYZ');
      expect(companionPrompt).not.toContain('MEMORIA-GLOBAL-XYZ');

      const desktopDir = join(root, 'desktop-conv');
      mkdirSync(desktopDir, { recursive: true });
      const desktop = await SessionHost.create({
        env: createSessionEnv({ cwd: desktopDir, env: {} }),
        config: makeConfig(),
        router: new ProviderRouter(makeConfig()),
        preset: 'assistant',
        assistantData: { dir: join(root, 'assistant'), legacyMemoryDir: null },
      });
      hosts.push(desktop);
      const desktopPrompt = desktop.agent.getMessages()[0]?.content ?? '';
      expect(desktopPrompt).toContain('MEMORIA-GLOBAL-XYZ');
      expect(desktopPrompt).not.toContain('MEMORIA-COMPANION-XYZ');
    } finally {
      rmSync(join(root, 'global-STRATUM.md'), { force: true });
    }
  });

  it('buildCompanionConfig no depende de la memoria de la config de partida', () => {
    const base = makeConfig();
    const a = buildCompanionConfig(base, join(root, 'x'));
    expect(a.memory.globalFile).not.toBe(base.memory.globalFile);
    expect(a.memory.decisionsFile).not.toBe(base.memory.decisionsFile);
  });

  it('el prompt presenta su memoria como propia, no la de Desktop', () => {
    const prompt = buildCompanionPrompt('Prefiero el tuteo.', { box: 'box' });
    expect(prompt).toContain('## User Memory');
    expect(prompt).toContain('Prefiero el tuteo.');
    expect(prompt).toContain('not shared with Stratum Desktop');
  });
});

describe('companion — skills de serie', () => {
  it('ve las suyas y la de autoría; ni la del asistente ni la de proyecto', async () => {
    const config = makeConfig({ box: { enabled: true }, skills: { enabled: true } });
    const router = new ProviderRouter(config);
    const dataDir = join(root, 'skills-data');
    const host = await SessionHost.create({
      env: createSessionEnv({ cwd: ensureCompanionWorkspace(dataDir), env: {} }),
      config,
      router,
      preset: 'companion',
      companionDataDir: dataDir,
    });
    hosts.push(host);
    const prompt = host.agent.getMessages()[0]?.content ?? '';
    expect(prompt).toContain('stratum-companion-memory');
    expect(prompt).toContain('stratum-skill-authoring');
    expect(prompt).not.toContain('stratum-global-memory');
    expect(prompt).not.toContain('stratum-project-memory');
  });
});
