import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SessionHost, type SessionHostOptions } from './session-host.js';
import { ensureCompanionWorkspace } from './companion.js';
import { ProviderRouter } from '../providers/router.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import { createSessionEnv } from '../runtime/session-env.js';
import type { CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { AgentEvent } from '../agent/types.js';
import type { ActiveConnectors, ActiveConnectorsSource } from '../connectors/active.js';
import type { SkillEntry } from '../skills/registry.js';

/**
 * M20 — los conectores del `companion` en su sesión: `SessionHost` los monta al
 * empezar cada turno (`RunOptions.beforeTurn`), declara sus tools de solo
 * lectura, suma su skill solo si el server conectó y los retira al
 * desactivarlos. La fuente de conectores es de mentira (no hay caja); el server
 * MCP es el real de pruebas.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-companion-conn-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MCP_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tools',
  'mcp',
  'fixtures',
  'test-mcp-server.mjs',
);

const SKILL_PATH = join(root, 'SKILL.md');
writeFileSync(
  SKILL_PATH,
  '---\nname: connector-fix\ndescription: Úsala para el conector de pruebas.\n---\n\nCUERPO-DE-LA-SKILL\n',
);
const SKILL: SkillEntry = {
  name: 'connector-fix',
  description: 'Úsala para el conector de pruebas.',
  path: SKILL_PATH,
  scope: 'builtin',
  source: 'connectors/fix',
  presets: ['companion'],
};

function config(): StratumConfig {
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
    box: { enabled: true, name: 'box', image: 'custom/box:1' },
    skills: { enabled: true },
  });
}

function server(name = 'fix', beforeConnect?: () => Promise<void>) {
  return {
    config: StratumConfigSchema.parse({
      mcp: {
        autoInstall: false,
        servers: [{ name, command: process.execPath, args: [MCP_FIXTURE] }],
      },
    }).mcp.servers[0]!,
    ...(beforeConnect ? { beforeConnect } : {}),
  };
}

/** Fuente que cambia entre turnos, como `connectors.json`. */
function source(initial: Partial<ActiveConnectors> = {}) {
  const state: { active: ActiveConnectors; resolves: number; failWith: Error | null } = {
    active: { servers: [], readOnlyTools: {}, skills: [], warnings: [], ...initial },
    resolves: 0,
    failWith: null,
  };
  const src: ActiveConnectorsSource = {
    async resolve() {
      state.resolves++;
      if (state.failWith) throw state.failWith;
      return state.active;
    },
  };
  return { state, src };
}

const ENABLED: Partial<ActiveConnectors> = {
  servers: [server()],
  readOnlyTools: { fix: ['echo'] },
  skills: [{ id: 'fix', skill: SKILL }],
};

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
  connectors: ActiveConnectorsSource | false | undefined,
  extra: Partial<SessionHostOptions> = {},
): Promise<SessionHost> {
  const dataDir = join(root, `data-${++n}`);
  const cfg = config();
  const router = new ProviderRouter(cfg);
  vi.spyOn(router, 'getActive').mockReturnValue(provider);
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd: ensureCompanionWorkspace(dataDir), env: {} }),
    config: cfg,
    router,
    preset: 'companion',
    companionDataDir: dataDir,
    ...(connectors !== undefined ? { connectors } : {}),
    ...extra,
  });
  hosts.push(host);
  return host;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const toolsOf = (req: CompletionRequest | undefined): string[] =>
  (req?.tools ?? []).map((t) => t.function.name);
const systemOf = (req: CompletionRequest | undefined): string => {
  const first = req?.messages[0];
  return typeof first?.content === 'string' ? first.content : '';
};
const warnings = (events: AgentEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'warning' ? [e.message] : []));

describe('companion — conectores del catálogo (M20)', () => {
  it('monta los servers al empezar el turno: sus tools llegan al modelo en ese turno', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const { src } = source(ENABLED);
    const host = await companionHost(provider, src);
    await collect(host.run('hola'));
    const tools = toolsOf(provider.requests[0]);
    expect(tools).toContain('mcp__fix__echo');
    expect(tools).toContain('mcp__fix__cwd');
    expect(tools).toContain('exec');
  }, 30_000);

  it('sin conectores activos no hay tools mcp__ ni se toca nada', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const { src, state } = source();
    const host = await companionHost(provider, src);
    await collect(host.run('hola'));
    expect(toolsOf(provider.requests[0]).filter((t) => t.startsWith('mcp__'))).toEqual([]);
    expect(state.resolves).toBe(1);
  });

  it('connectors: false → ninguno, y no se mira nada', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const host = await companionHost(provider, false);
    await collect(host.run('hola'));
    expect(toolsOf(provider.requests[0]).filter((t) => t.startsWith('mcp__'))).toEqual([]);
  });

  it('el prompt presenta los conectores (# Your connectors) en el turno en que se montan', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const { src } = source(ENABLED);
    const host = await companionHost(provider, src);
    await collect(host.run('hola'));
    expect(systemOf(provider.requests[0])).toContain('# Your connectors');
  }, 30_000);

  it('sus tools de solo lectura no piden confirmación; las demás, sí', async () => {
    const confirm = vi.fn(async () => 'approve' as const);
    const { src } = source(ENABLED);
    const host = await companionHost(
      new MockProvider([
        makeToolCallRound('c1', 'mcp__fix__echo', { text: 'a' }),
        makeToolCallRound('c2', 'mcp__fix__cwd', {}),
        makeTextRound('hecho'),
      ]),
      src,
      { destructivePolicy: 'ask', gates: { confirm } },
    );
    const events = await collect(host.run('usa el conector'));
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
    expect(confirm).toHaveBeenCalledTimes(1);
    const [asked] = confirm.mock.calls[0] as unknown as [{ toolName: string }];
    expect(asked.toolName).toBe('mcp__fix__cwd');
  }, 30_000);

  it('suma la skill solo si el server conectó: en el índice y servida por read_skill', async () => {
    const provider = new RecordingProvider([
      makeToolCallRound('c1', 'read_skill', { name: 'connector-fix' }),
      makeTextRound('leída'),
    ]);
    const { src } = source(ENABLED);
    const host = await companionHost(provider, src);
    const events = await collect(host.run('mira cómo se usa'));
    const result = events.find((e) => e.type === 'tool_result');
    expect(JSON.stringify(result)).toContain('CUERPO-DE-LA-SKILL');
    const prompt = systemOf(provider.requests[0]);
    expect(prompt).toContain('connector-fix');
    expect(prompt).toContain('Úsala para el conector de pruebas.');
  }, 30_000);

  it('un server que no conecta: aviso en el turno, ni tools ni skill', async () => {
    const provider = new RecordingProvider([makeTextRound('hola')]);
    const down = server('fix', async () => {
      throw new Error('The connectors box is stopped.');
    });
    const { src } = source({ ...ENABLED, servers: [down] });
    const host = await companionHost(provider, src);
    const events = await collect(host.run('hola'));
    expect(toolsOf(provider.requests[0]).filter((t) => t.startsWith('mcp__'))).toEqual([]);
    expect(systemOf(provider.requests[0])).not.toContain('connector-fix');
    expect(warnings(events).join('\n')).toMatch(/connectors box is stopped/);
  }, 30_000);

  it('al desactivarlo, en el turno siguiente desaparecen sus tools y su skill', async () => {
    const provider = new RecordingProvider([makeTextRound('uno'), makeTextRound('dos')]);
    const { src, state } = source(ENABLED);
    const host = await companionHost(provider, src);
    await collect(host.run('primero'));
    expect(toolsOf(provider.requests[0])).toContain('mcp__fix__echo');
    expect(systemOf(provider.requests[0])).toContain('connector-fix');

    state.active = { servers: [], readOnlyTools: {}, skills: [], warnings: [] };
    await collect(host.run('segundo'));
    expect(toolsOf(provider.requests[1]).filter((t) => t.startsWith('mcp__'))).toEqual([]);
    expect(systemOf(provider.requests[1])).not.toContain('connector-fix');
  }, 30_000);

  it('al activarlo entre turnos, aparece en el siguiente', async () => {
    const provider = new RecordingProvider([makeTextRound('uno'), makeTextRound('dos')]);
    const { src, state } = source();
    const host = await companionHost(provider, src);
    await collect(host.run('primero'));
    expect(toolsOf(provider.requests[0]).filter((t) => t.startsWith('mcp__'))).toEqual([]);
    state.active = { servers: [server()], readOnlyTools: {}, skills: [], warnings: [] };
    await collect(host.run('segundo'));
    expect(toolsOf(provider.requests[1])).toContain('mcp__fix__echo');
  }, 30_000);

  it('los avisos salen como warning en el turno y no se repiten si no cambian', async () => {
    const provider = new RecordingProvider([
      makeTextRound('uno'),
      makeTextRound('dos'),
      makeTextRound('tres'),
    ]);
    const { src, state } = source({ warnings: ['Aviso A'] });
    const host = await companionHost(provider, src);
    expect(warnings(await collect(host.run('1')))).toEqual(['Aviso A']);
    expect(warnings(await collect(host.run('2')))).toEqual([]);
    state.active = { ...state.active, warnings: ['Aviso B'] };
    expect(warnings(await collect(host.run('3')))).toEqual(['Aviso B']);
  });

  it('un resolve que lanza no tumba el turno: sin conectores y con aviso', async () => {
    const provider = new RecordingProvider([makeTextRound('uno'), makeTextRound('dos')]);
    const { src, state } = source(ENABLED);
    const host = await companionHost(provider, src);
    await collect(host.run('primero'));
    expect(toolsOf(provider.requests[0])).toContain('mcp__fix__echo');

    state.failWith = new Error('boom');
    const events = await collect(host.run('segundo'));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(warnings(events).join('\n')).toMatch(/Connectors are off for this turn: boom/);
    // Falla cerrado: lo que había se retira.
    expect(toolsOf(provider.requests[1]).filter((t) => t.startsWith('mcp__'))).toEqual([]);
    expect(systemOf(provider.requests[1])).not.toContain('connector-fix');
  }, 30_000);
});
