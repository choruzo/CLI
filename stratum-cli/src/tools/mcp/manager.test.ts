import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpManager } from './manager.js';
import { ToolRegistry } from '../registry.js';
import type { McpServerClient } from './client.js';
import type { StratumConfig } from '../../config/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(servers: { name: string }[] = []): StratumConfig {
  return {
    provider: undefined,
    memory: {
      projectFile: '',
      globalFile: '',
      decisionsFile: '',
      vectorDb: '',
      embeddingModel: '',
      retrievalTopK: 5,
      embeddingWarmup: false,
    },
    tools: {
      confirmDestructive: false,
      bashTimeout: 30000,
      webSearch: { backend: 'meta', apiKey: '', tavilyApiKey: '', maxResults: 10 },
      destructivePatterns: [],
    },
    mcp: {
      servers: servers.map((s) => ({ name: s.name, command: 'npx', args: [], env: undefined })),
      heartbeatInterval: 30000,
    },
    agent: {
      maxIterations: 50,
      maxToolRetries: 3,
      toolErrorFormat: 'xml',
      compressionKeepRounds: 6,
      compressionThreshold: 0.8,
    },
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
