import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpManager, type DynamicMcpServer } from './manager.js';
import { ToolRegistry } from '../registry.js';
import type { McpServerClient } from './client.js';
import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';

/** Secciones que este test no ejercita: los defaults del schema. */
const DEFAULTS = StratumConfigSchema.parse({});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(servers: { name: string }[] = []): StratumConfig {
  return {
    logging: DEFAULTS.logging,
    agents: DEFAULTS.agents,
    skills: DEFAULTS.skills,
    trace: DEFAULTS.trace,
    prompt: DEFAULTS.prompt,
    snapshots: DEFAULTS.snapshots,
    desktop: DEFAULTS.desktop,
    daemon: DEFAULTS.daemon,
    context: DEFAULTS.context,
    session: DEFAULTS.session,
    plugins: DEFAULTS.plugins,
    box: DEFAULTS.box,
    companion: DEFAULTS.companion,
    channels: DEFAULTS.channels,
    provider: undefined,
    memory: {
      projectFile: '',
      globalFile: '',
      decisionsFile: '',
      vectorDb: '',
      embeddingModel: '',
      embeddingDimension: 384,
      retrievalTopK: 5,
      embeddingWarmup: false,
      autoExtract: false,
      similarityThreshold: 0.9,
      index: DEFAULTS.memory.index,
      dreaming: DEFAULTS.memory.dreaming,
      session: DEFAULTS.memory.session,
    },
    tools: {
      confirmDestructive: false,
      bashTimeout: 30000,
      testCommand: '',
      jobs: {
        enabled: true,
        maxRunning: 8,
        maxRetained: 50,
        maxOutputChars: 1_000_000,
        maxTotalOutputChars: 8_000_000,
        readChars: 8000,
        maxReadChars: 24_000,
        maxRuntimeMs: 1_800_000,
        maxWaitMs: 60_000,
        subagentAccess: 'own',
      },
      webSearch: { backend: 'meta', apiKey: '', tavilyApiKey: '', maxResults: 10 },
      webFetch: { allowHosts: [] },
      browser: DEFAULTS.tools.browser,
      destructivePatterns: [],
      guardedCommands: {},
      sensitivePathAllowlist: [],
      execMaxBytes: 1024 * 1024,
      auditLog: false,
      redaction: { extraPatterns: [] },
    },
    mcp: {
      servers: servers.map((s) => ({
        name: s.name,
        command: 'npx',
        args: [],
        env: undefined,
        startupTimeout: 15000,
        toolTimeout: 120000,
      })),
      heartbeatInterval: 30000,
      startup: 'lazy',
      installDir: '~/.stratum/mcp',
      autoInstall: true,
    },
    agent: {
      maxIterations: 50,
      maxToolRetries: 3,
      toolErrorFormat: 'xml',
      compressionKeepRounds: 6,
      compressionTimeoutMs: 120_000,
      compressionThreshold: 0.8,
      compressionReusePrefix: false,
    },
    lsp: DEFAULTS.lsp,
    tui: DEFAULTS.tui,
  };
}

/** Reemplaza McpServerClient en el manager con fakes controlables. */
function injectFakeClients(manager: McpManager, fakes: Partial<McpServerClient>[]): void {
  // Acceso directo a la propiedad privada (solo tests)
  (manager as unknown as { clients: unknown[] }).clients = fakes;
}

function makeFakeClient(
  name: string,
  opts: {
    connectFails?: boolean;
    pingFails?: boolean;
    tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  } = {},
): McpServerClient {
  let status: McpServerClient['status'] = 'connecting';
  return {
    name,
    get status() {
      return status;
    },
    get tools() {
      return opts.tools ?? [];
    },
    connect: vi.fn(async () => {
      if (opts.connectFails) throw new Error(`${name} failed to connect`);
      status = 'connected';
    }),
    callTool: vi.fn(),
    ping: vi.fn(async () => {
      if (opts.pingFails) throw new Error(`${name} ping failed`);
    }),
    close: vi.fn(async () => {
      status = 'disconnected';
    }),
    reconnect: vi.fn(async () => {
      status = 'connected';
    }),
  } as unknown as McpServerClient;
}

// ---------------------------------------------------------------------------
// connectAll
// ---------------------------------------------------------------------------

describe('McpManager.connectAll', () => {
  it('retorna lista vacía de warnings cuando todos los servers conectan', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }]));
    const fake = makeFakeClient('a');
    injectFakeClients(manager, [fake]);

    const warnings = await manager.connectAll();
    expect(warnings).toHaveLength(0);
    expect(fake.connect).toHaveBeenCalledOnce();
  });

  it('no aborta si un server falla — devuelve warning y continúa', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }, { name: 'b' }]));
    const fakeA = makeFakeClient('a', { connectFails: true });
    const fakeB = makeFakeClient('b');
    injectFakeClients(manager, [fakeA, fakeB]);

    const warnings = await manager.connectAll();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.serverName).toBe('a');
    expect(fakeB.connect).toHaveBeenCalledOnce();
  });

  it('devuelve warning con mensaje descriptivo', async () => {
    const manager = new McpManager(makeConfig([{ name: 'bad' }]));
    const fake = makeFakeClient('bad', { connectFails: true });
    injectFakeClients(manager, [fake]);

    const warnings = await manager.connectAll();
    expect(warnings[0]!.message).toContain("MCP server 'bad' failed to connect");
  });
});

// ---------------------------------------------------------------------------
// registerInto
// ---------------------------------------------------------------------------

describe('McpManager.registerInto', () => {
  it('registra tools del server conectado en el ToolRegistry', async () => {
    const manager = new McpManager(makeConfig([{ name: 'fs' }]));
    const fake = makeFakeClient('fs', {
      tools: [
        { name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    injectFakeClients(manager, [fake]);
    await manager.connectAll();

    const registry = new ToolRegistry();
    manager.registerInto(registry);

    const tool = registry.get('mcp__fs__read_file');
    expect(tool).toBeDefined();
    expect(tool!.description).toBe('Read');
  });

  it('no registra tools de un server desconectado', async () => {
    const manager = new McpManager(makeConfig([{ name: 'bad' }]));
    const fake = makeFakeClient('bad', {
      connectFails: true,
      tools: [{ name: 'some_tool', description: '', inputSchema: {} }],
    });
    injectFakeClients(manager, [fake]);
    await manager.connectAll();

    const registry = new ToolRegistry();
    manager.registerInto(registry);

    expect(registry.get('mcp__bad__some_tool')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getStatusSummary
// ---------------------------------------------------------------------------

describe('McpManager.getStatusSummary', () => {
  it('reporta 0 connected cuando no hay servers', () => {
    const manager = new McpManager(makeConfig([]));
    const summary = manager.getStatusSummary();
    expect(summary).toEqual({ connected: 0, reconnecting: 0, disconnected: 0, total: 0 });
  });

  it('refleja el estado real de cada client', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }, { name: 'b' }]));
    const fakeA = makeFakeClient('a');
    const fakeB = makeFakeClient('b', { connectFails: true });
    injectFakeClients(manager, [fakeA, fakeB]);
    await manager.connectAll();

    const summary = manager.getStatusSummary();
    expect(summary.connected).toBe(1);
    expect(summary.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// shutdownAll
// ---------------------------------------------------------------------------

describe('McpManager.shutdownAll', () => {
  it('llama close() en todos los clients', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }, { name: 'b' }]));
    const fakeA = makeFakeClient('a');
    const fakeB = makeFakeClient('b');
    injectFakeClients(manager, [fakeA, fakeB]);

    await manager.shutdownAll();

    expect(fakeA.close).toHaveBeenCalledOnce();
    expect(fakeB.close).toHaveBeenCalledOnce();
  });

  it('no lanza aunque close() falle en algún client', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }]));
    const fake = makeFakeClient('a');
    vi.mocked(fake.close).mockRejectedValue(new Error('already dead'));
    injectFakeClients(manager, [fake]);

    await expect(manager.shutdownAll()).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Heartbeat + backoff (fake timers)
// ---------------------------------------------------------------------------

describe('McpManager heartbeat y reconexión', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startHeartbeat no bloquea el proceso (timer unref)', () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }]));
    const fake = makeFakeClient('a');
    injectFakeClients(manager, [fake]);
    // No debe lanzar
    expect(() => manager.startHeartbeat()).not.toThrow();
    manager.shutdownAll();
  });

  it('el heartbeat intenta ping en los servers conectados', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }]));
    const fake = makeFakeClient('a');
    injectFakeClients(manager, [fake]);
    await manager.connectAll();
    manager.startHeartbeat();

    // Avanzar el timer un intervalo (30 s por defecto en makeConfig, pero el
    // manager lo lee de config.mcp.heartbeatInterval)
    await vi.advanceTimersByTimeAsync(30000);

    expect(fake.ping).toHaveBeenCalled();
    await manager.shutdownAll();
  });

  it('cuando el ping falla intenta reconectar con backoff', async () => {
    const manager = new McpManager(makeConfig([{ name: 'a' }]));
    const fake = makeFakeClient('a', { pingFails: true });
    injectFakeClients(manager, [fake]);
    await manager.connectAll();
    manager.startHeartbeat();

    // Disparar el heartbeat
    await vi.advanceTimersByTimeAsync(30000);
    // Dejar pasar el primer delay del backoff (2 s)
    await vi.advanceTimersByTimeAsync(2000);

    expect(fake.reconnect).toHaveBeenCalled();
    await manager.shutdownAll();
  });
});

// ---------------------------------------------------------------------------
// M20 — servers dinámicos (los conectores del companion), contra el server real
// ---------------------------------------------------------------------------

describe('McpManager.setDynamicServers (M20)', () => {
  const FIXTURE = fileURLToPath(new URL('./fixtures/test-mcp-server.mjs', import.meta.url));
  let tmp: string;
  let managers: McpManager[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stratum-mcp-dyn-'));
  });
  afterEach(async () => {
    await Promise.allSettled(managers.map((m) => m.shutdownAll()));
    managers = [];
    rmSync(tmp, { recursive: true, force: true });
  });

  const spawnLog = (): string => join(tmp, 'spawns.log');
  const spawns = (): number =>
    existsSync(spawnLog())
      ? readFileSync(spawnLog(), 'utf8').split('\n').filter(Boolean).length
      : 0;

  function dyn(
    name: string,
    over: {
      env?: Record<string, string>;
      beforeConnect?: () => Promise<void>;
      forcedTools?: string[];
    } = {},
  ): DynamicMcpServer {
    const [config] = StratumConfigSchema.parse({
      mcp: {
        autoInstall: false,
        servers: [
          {
            name,
            command: process.execPath,
            args: [FIXTURE],
            env: { MCP_TEST_SPAWN_LOG: spawnLog(), ...over.env },
          },
        ],
      },
    }).mcp.servers;
    return {
      config: config!,
      ...(over.beforeConnect ? { beforeConnect: over.beforeConnect } : {}),
      ...(over.forcedTools ? { forcedTools: over.forcedTools } : {}),
    };
  }

  function make(configServers: string[] = []): { m: McpManager; registry: ToolRegistry } {
    const config = StratumConfigSchema.parse({
      mcp: {
        autoInstall: false,
        servers: configServers.map((name) => ({
          name,
          command: process.execPath,
          args: [FIXTURE],
        })),
      },
    });
    const m = new McpManager(config, () => {}, { reconnectDelaysMs: [50, 100, 200] });
    managers.push(m);
    const registry = new ToolRegistry();
    m.registerInto(registry);
    return { m, registry };
  }

  const mcpTools = (registry: ToolRegistry): string[] =>
    registry
      .list()
      .map((t) => t.name)
      .filter((n) => n.startsWith('mcp__'));

  it('añade, conecta y registra las tools del server', async () => {
    const { m, registry } = make();
    expect(await m.setDynamicServers([dyn('uno-dos')])).toEqual([]);
    expect(registry.get('mcp__uno-dos__echo')).toBeDefined();
    expect(m.getClients().map((c) => [c.name, c.status])).toEqual([['uno-dos', 'connected']]);
  });

  it('M27: las tools forzadas se registran forzadas; cambiarlas relanza el server', async () => {
    const { m, registry } = make();
    await m.setDynamicServers([dyn('uno-dos', { forcedTools: ['echo'] })]);
    const forced = registry.get('mcp__uno-dos__echo')!;
    expect(forced.confirmAlways?.({}, {} as never)).toBe(true);
    expect(forced.describeConfirmation).toBeDefined();
    await m.setDynamicServers([dyn('uno-dos')]);
    expect(spawns()).toBe(2);
    expect(registry.get('mcp__uno-dos__echo')!.confirmAlways).toBeUndefined();
  });

  it('con la misma config no relanza el server', async () => {
    const { m } = make();
    await m.setDynamicServers([dyn('uno-dos')]);
    await m.setDynamicServers([dyn('uno-dos')]);
    expect(spawns()).toBe(1);
  });

  it('retira (cierra y quita sus tools) el que desaparece', async () => {
    const { m, registry } = make();
    await m.setDynamicServers([dyn('uno-dos'), dyn('tres-cuatro')]);
    const closing = m.getClients().find((c) => c.name === 'uno-dos')!;
    expect(mcpTools(registry).some((n) => n.startsWith('mcp__uno-dos__'))).toBe(true);
    await m.setDynamicServers([dyn('tres-cuatro')]);
    expect(closing.status).toBe('disconnected');
    expect(mcpTools(registry).some((n) => n.startsWith('mcp__uno-dos__'))).toBe(false);
    expect(mcpTools(registry).some((n) => n.startsWith('mcp__tres-cuatro__'))).toBe(true);
    expect(m.getClients().map((c) => c.name)).toEqual(['tres-cuatro']);
    await m.setDynamicServers([]);
    expect(mcpTools(registry)).toEqual([]);
    expect(m.getClients()).toEqual([]);
  });

  it('si cambia la config, lo cierra y lo lanza de nuevo', async () => {
    const { m, registry } = make();
    await m.setDynamicServers([dyn('uno-dos')]);
    const first = m.getClients()[0]!;
    await m.setDynamicServers([dyn('uno-dos', { env: { MCP_TEST_EXTRA_TOOLS: 'extra_a' } })]);
    expect(first.status).toBe('disconnected');
    expect(spawns()).toBe(2);
    expect(m.getClients()).toHaveLength(1);
    expect(registry.get('mcp__uno-dos__extra_a')).toBeDefined();
  });

  it('un beforeConnect que lanza: aviso, ningún proceso lanzado y ninguna tool', async () => {
    const { m, registry } = make();
    const warnings = await m.setDynamicServers([
      dyn('uno-dos', {
        beforeConnect: async () => {
          throw new Error('the connectors box is stopped');
        },
      }),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.serverName).toBe('uno-dos');
    expect(warnings[0]!.message).toMatch(/connectors box is stopped/);
    expect(spawns()).toBe(0);
    expect(mcpTools(registry)).toEqual([]);
  });

  it('reintenta en la siguiente sincronización el que no estaba conectado', async () => {
    const { m, registry } = make();
    let ready = false;
    const beforeConnect = async (): Promise<void> => {
      if (!ready) throw new Error('not yet');
    };
    expect(await m.setDynamicServers([dyn('uno-dos', { beforeConnect })])).toHaveLength(1);
    ready = true;
    expect(await m.setDynamicServers([dyn('uno-dos', { beforeConnect })])).toEqual([]);
    expect(spawns()).toBe(1);
    expect(registry.get('mcp__uno-dos__echo')).toBeDefined();
  });

  it('un nombre que ya usa un server de la config se omite con aviso', async () => {
    const { m } = make(['ocupado']);
    await m.connectAll();
    const warnings = await m.setDynamicServers([dyn('ocupado'), dyn('libre-uno')]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/'ocupado' skipped.*already uses that name/);
    const byName = new Map(m.getClients().map((c) => [c.name, c.status]));
    expect(byName.get('ocupado')).toBe('connected');
    expect(byName.get('libre-uno')).toBe('connected');
    expect(m.getClients()).toHaveLength(2);
    // El de la config no es dinámico: quitarlo de la lista no lo cierra.
    await m.setDynamicServers([]);
    expect(m.getClients().map((c) => c.name)).toEqual(['ocupado']);
    expect(m.getClients()[0]!.status).toBe('connected');
  });

  it('un nombre repetido en la misma lista se omite con aviso', async () => {
    const { m } = make();
    const warnings = await m.setDynamicServers([dyn('uno-dos'), dyn('uno-dos')]);
    expect(warnings).toHaveLength(1);
    expect(m.getClients()).toHaveLength(1);
  });

  it('tras shutdownAll no hace nada', async () => {
    const { m, registry } = make();
    await m.shutdownAll();
    expect(await m.setDynamicServers([dyn('uno-dos')])).toEqual([]);
    expect(spawns()).toBe(0);
    expect(m.getClients()).toEqual([]);
    expect(mcpTools(registry)).toEqual([]);
  });

  it('dos sincronizaciones a la vez no se solapan', async () => {
    const { m } = make();
    const [a, b] = await Promise.all([
      m.setDynamicServers([dyn('uno-dos')]),
      m.setDynamicServers([dyn('uno-dos')]),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(spawns()).toBe(1);
    expect(m.getClients()).toHaveLength(1);
  });
});
