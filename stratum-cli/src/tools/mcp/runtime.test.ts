/**
 * Runtime MCP contra un server real en proceso hijo (fixtures/test-mcp-server.mjs):
 * descubrimiento paginado, nombres, timeouts, caídas, list_changed y cierre.
 * Sin mocks del protocolo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpManager } from './manager.js';
import { McpServerClient } from './client.js';
import { MCP_TOOL_NAME_MAX, mcpToolName } from './bridge.js';
import { ToolDispatcher, ToolRegistry } from '../registry.js';
import { StratumConfigSchema, type StratumConfig } from '../../config/schema.js';
import type { ToolContext } from '../../agent/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/test-mcp-server.mjs', import.meta.url));
const NO_LOG = (): void => {};
/** Herramientas del fixture (sin extras). */
const BASE_TOOLS = 9;

let tmp: string;
let managers: McpManager[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stratum-mcp-rt-'));
});

afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.shutdownAll()));
  managers = [];
  rmSync(tmp, { recursive: true, force: true });
});

interface ServerOpts {
  name?: string;
  env?: Record<string, string>;
  toolTimeout?: number;
}

function makeConfig(servers: ServerOpts[], heartbeatInterval = 30000): StratumConfig {
  return StratumConfigSchema.parse({
    mcp: {
      heartbeatInterval,
      autoInstall: false,
      servers: servers.map((s, i) => ({
        name: s.name ?? `srv${i}`,
        command: process.execPath,
        args: [FIXTURE],
        env: s.env,
        ...(s.toolTimeout ? { toolTimeout: s.toolTimeout } : {}),
      })),
    },
  });
}

function makeManager(servers: ServerOpts[], heartbeatInterval?: number): McpManager {
  const m = new McpManager(makeConfig(servers, heartbeatInterval), NO_LOG, {
    reconnectDelaysMs: [50, 100, 200],
  });
  managers.push(m);
  return m;
}

function ctx(config: StratumConfig): ToolContext {
  return { signal: new AbortController().signal, cwd: process.cwd(), config };
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function spawnCount(log: string): number {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

describe('descubrimiento y registro', () => {
  it('sigue la paginación de tools/list', async () => {
    const m = makeManager([{ env: { MCP_TEST_PAGE_SIZE: '2' } }]);
    await m.connectAll();
    const registry = new ToolRegistry();
    expect(m.registerInto(registry)).toEqual([]);
    expect(m.getClients()[0]!.tools).toHaveLength(BASE_TOOLS);
    expect(registry.get('mcp__srv0__remove_tool')).toBeDefined();
  });

  it('un server que muere al arrancar queda disconnected', async () => {
    const m = makeManager([{ env: { MCP_TEST_EXIT_ON_START: '1' } }]);
    const warnings = await m.connectAll();
    expect(warnings).toHaveLength(1);
    expect(m.getClients()[0]!.status).toBe('disconnected');
  });

  it('nombres inválidos o largos se registran ≤64 y sin colisionar', async () => {
    const long = 'x'.repeat(80);
    const m = makeManager([{ env: { MCP_TEST_EXTRA_TOOLS: `my.tool,my_tool,${long},${long}y` } }]);
    await m.connectAll();
    const registry = new ToolRegistry();
    expect(m.registerInto(registry)).toEqual([]);
    const names = registry
      .list()
      .map((t) => t.name)
      .filter((n) => n.startsWith('mcp__'));
    expect(names).toHaveLength(BASE_TOOLS + 4);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
      expect(n).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    // Y la tool con nombre recortado sigue funcionando contra el server.
    const dispatcher = new ToolDispatcher(registry);
    const [res] = await dispatcher.dispatch(
      [{ id: '1', name: mcpToolName('srv0', long), input: {} }],
      ctx(makeConfig([])),
    );
    expect(res!.result).toEqual({ ok: true, output: `ran ${long}` });
  });

  it('una tool repetida o un nombre ya ocupado se omite con aviso, sin pisar', async () => {
    const m = makeManager([{ env: { MCP_TEST_EXTRA_TOOLS: 'echo' } }]);
    await m.connectAll();
    const registry = new ToolRegistry();
    const builtin = {
      name: 'mcp__srv0__slow',
      description: 'ocupado',
      schema: z.object({}),
      execute: async () => ({ ok: true as const, output: 'builtin' }),
    };
    registry.register(builtin);
    const warnings = m.registerInto(registry);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/srv0\/echo.*skipped/);
    expect(warnings.map((w) => w.message).join('\n')).toMatch(/srv0\/slow.*skipped/);
    expect(registry.get('mcp__srv0__slow')).toBe(builtin);
  });
});

describe('resultados', () => {
  it('recurso embebido con texto, binario y structuredContent llegan al modelo', async () => {
    const m = makeManager([{}]);
    await m.connectAll();
    const registry = new ToolRegistry();
    m.registerInto(registry);
    const dispatcher = new ToolDispatcher(registry);
    const [res, structured, fail] = await dispatcher.dispatch(
      [
        { id: '1', name: 'mcp__srv0__resource', input: {} },
        { id: '2', name: 'mcp__srv0__structured', input: {} },
        { id: '3', name: 'mcp__srv0__fail', input: {} },
      ],
      ctx(makeConfig([])),
    );
    expect(res!.result).toEqual({
      ok: true,
      output:
        '[resource: file:///r.txt]\nRESOURCE BODY\n' +
        '[resource: file:///b.bin, application/octet-stream, binary, 3 bytes]',
    });
    expect(structured!.result).toEqual({ ok: true, output: '{\n  "answer": 42\n}' });
    expect(fail!.result).toMatchObject({ ok: false, error: 'boom' });
  });
});

describe('timeouts', () => {
  it('manda el toolTimeout del server, no el default de 30 s del dispatcher', async () => {
    const m = makeManager([{ toolTimeout: 400 }]);
    await m.connectAll();
    const registry = new ToolRegistry();
    m.registerInto(registry);
    expect(registry.get('mcp__srv0__slow')!.timeout).toBe(400);

    const dispatcher = new ToolDispatcher(registry);
    const start = Date.now();
    const [slow] = await dispatcher.dispatch(
      [{ id: '1', name: 'mcp__srv0__slow', input: { ms: 5000 } }],
      ctx(makeConfig([])),
    );
    expect(Date.now() - start).toBeLessThan(3000);
    expect(slow!.result.ok).toBe(false);
    if (!slow!.result.ok) expect(slow!.result.error).toMatch(/timed out/);

    // El server sigue sano: la cancelación se notificó y no se quedó colgado.
    const [echo] = await dispatcher.dispatch(
      [{ id: '2', name: 'mcp__srv0__echo', input: { text: 'vivo' } }],
      ctx(makeConfig([])),
    );
    expect(echo!.result).toEqual({ ok: true, output: 'vivo' });
  });
});

describe('caídas y reconexión', () => {
  it('un server que se cae a mitad de llamada avisa y se reconecta solo', async () => {
    const log = join(tmp, 'spawns.log');
    const m = makeManager([{ env: { MCP_TEST_SPAWN_LOG: log } }]);
    await m.connectAll();
    const registry = new ToolRegistry();
    m.registerInto(registry);
    const dispatcher = new ToolDispatcher(registry);

    const [crash] = await dispatcher.dispatch(
      [{ id: '1', name: 'mcp__srv0__crash', input: {} }],
      ctx(makeConfig([])),
    );
    expect(crash!.result.ok).toBe(false);
    if (!crash!.result.ok)
      expect(crash!.result.error).toMatch(/may or may not have been performed/);

    const client = m.getClients()[0]!;
    await waitFor(() => client.status === 'connected' && spawnCount(log) === 2);
    const [echo] = await dispatcher.dispatch(
      [{ id: '2', name: 'mcp__srv0__echo', input: { text: 'de vuelta' } }],
      ctx(makeConfig([])),
    );
    expect(echo!.result).toEqual({ ok: true, output: 'de vuelta' });
  });

  it('el heartbeat detecta un server colgado y lo relanza', async () => {
    const log = join(tmp, 'spawns.log');
    const m = makeManager([{ env: { MCP_TEST_SPAWN_LOG: log } }], 150);
    await m.connectAll();
    const registry = new ToolRegistry();
    m.registerInto(registry);
    m.startHeartbeat();

    // `freeze` bloquea el event loop del server: no responde ni al ping.
    const client = m.getClients()[0]!;
    void client.callTool('freeze', {}, undefined, 60_000).catch(() => {});
    await waitFor(() => spawnCount(log) === 2, 10_000);
    await waitFor(() => client.status === 'connected');
    const [echo] = await new ToolDispatcher(registry).dispatch(
      [{ id: '1', name: 'mcp__srv0__echo', input: { text: 'ok' } }],
      ctx(makeConfig([])),
    );
    expect(echo!.result).toEqual({ ok: true, output: 'ok' });
  }, 20_000);

  it('shutdownAll durante el backoff no relanza el server', async () => {
    const log = join(tmp, 'spawns.log');
    const m = new McpManager(makeConfig([{ env: { MCP_TEST_SPAWN_LOG: log } }]), NO_LOG, {
      reconnectDelaysMs: [400],
    });
    managers.push(m);
    await m.connectAll();
    const client = m.getClients()[0]!;
    void client.callTool('crash', {}).catch(() => {});
    await waitFor(() => client.status === 'reconnecting');
    await m.shutdownAll();
    await new Promise((r) => setTimeout(r, 700));
    expect(spawnCount(log)).toBe(1);
    expect(client.status).toBe('disconnected');
  });

  it('close() durante un connect en vuelo no deja el server conectado', async () => {
    const cfg = makeConfig([{}]).mcp.servers[0]!;
    const client = new McpServerClient(cfg, { installDir: tmp, autoInstall: false }, NO_LOG);
    const connecting = client.connect();
    await client.close();
    await expect(connecting).rejects.toThrow();
    expect(client.status).toBe('disconnected');
  });
});

describe('tools/list_changed', () => {
  it('registra las tools nuevas y retira las eliminadas', async () => {
    const m = makeManager([{}]);
    await m.connectAll();
    const registry = new ToolRegistry();
    m.registerInto(registry);
    const dispatcher = new ToolDispatcher(registry);
    const config = makeConfig([]);

    await dispatcher.dispatch(
      [{ id: '1', name: 'mcp__srv0__add_tool', input: { name: 'nueva' } }],
      ctx(config),
    );
    await waitFor(() => registry.get('mcp__srv0__nueva') !== undefined);

    await dispatcher.dispatch(
      [{ id: '2', name: 'mcp__srv0__remove_tool', input: { name: 'echo' } }],
      ctx(config),
    );
    await waitFor(() => registry.get('mcp__srv0__echo') === undefined);
    expect(m.registeredNames(m.getClients()[0]!).has('mcp__srv0__nueva')).toBe(true);
  });
});

describe('reload', () => {
  it('retira las tools del ciclo anterior y vuelve a registrar', async () => {
    const m = makeManager([{}]);
    await m.connectAll();
    const registry = new ToolRegistry();
    m.registerInto(registry);
    const warnings = await m.reload(registry);
    expect(warnings).toEqual([]);
    expect(m.getStatusSummary().connected).toBe(1);
    expect(registry.get('mcp__srv0__echo')).toBeDefined();
  });
});
