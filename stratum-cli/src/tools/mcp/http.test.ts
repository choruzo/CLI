/**
 * M22 parte 3 — MCP por Streamable HTTP: la política del `fetch` confinado
 * (`http-fetch.ts`) y el cliente contra un server MCP HTTP real del SDK.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHttpFetch, mcpAddressProblem, McpHttpBlockedError } from './http-fetch.js';
import { McpServerClient } from './client.js';
import type { McpServer } from '../../config/schema.js';

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  delete process.env.STRATUM_TEST_MCP_TOKEN;
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Un `lookup` falso que resuelve cualquier nombre a `ip` (DNS rebinding). */
function fakeLookup(ip: string) {
  return ((_host: string, _opts: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
    cb(null, [{ address: ip, family: ip.includes(':') ? 6 : 4 }])) as never;
}

describe('mcpAddressProblem', () => {
  it('lo público solo por https; lo local solo con allowPrivate; lo vetado nunca', () => {
    expect(mcpAddressProblem('8.8.8.8', 'https:', false)).toBeNull();
    expect(mcpAddressProblem('8.8.8.8', 'http:', true)).toMatch(/plain http/);
    expect(mcpAddressProblem('192.168.1.10', 'http:', false)).toMatch(/allowPrivate/);
    expect(mcpAddressProblem('192.168.1.10', 'http:', true)).toBeNull();
    expect(mcpAddressProblem('127.0.0.1', 'http:', true)).toBeNull();
    expect(mcpAddressProblem('::ffff:10.0.0.1', 'http:', true)).toBeNull();
    expect(mcpAddressProblem('169.254.169.254', 'http:', true)).toMatch(/link-local/);
    expect(mcpAddressProblem('fe80::1', 'https:', true)).toMatch(/link-local/);
    expect(mcpAddressProblem('::ffff:169.254.169.254', 'https:', true)).toMatch(/link-local/);
    expect(mcpAddressProblem('224.0.0.1', 'https:', true)).toMatch(/multicast/);
    // `localhost` que resuelve fuera: nunca.
    expect(mcpAddressProblem('8.8.8.8', 'https:', true, true)).toMatch(/localhost/);
  });
});

describe('createMcpHttpFetch', () => {
  it('rechaza otro origen, también otro puerto del mismo host', async () => {
    const base = await listen((_q, r) => r.end('ok'));
    const f = createMcpHttpFetch({ url: new URL(`${base}/mcp`), allowPrivate: true });
    await expect(f('http://127.0.0.1:1/mcp')).rejects.toThrow(/another origin/);
    await expect(f('https://example.com/mcp')).rejects.toBeInstanceOf(McpHttpBlockedError);
    const ok = await f(`${base}/otra`);
    expect(await ok.text()).toBe('ok');
  });

  it('nunca sigue una redirección, ni al mismo origen', async () => {
    const base = await listen((req, res) => {
      if (req.url === '/mcp') {
        res.writeHead(307, { location: '/destino' });
        res.end();
      } else res.end('no debería llegar');
    });
    const f = createMcpHttpFetch({ url: new URL(`${base}/mcp`), allowPrivate: true });
    await expect(f(`${base}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow(
      /redirect refused \(HTTP 307\)/,
    );
  });

  it('sin allowPrivate no alcanza loopback, ni por IP literal ni por localhost', async () => {
    const base = await listen((_q, r) => r.end('ok'));
    const port = new URL(base).port;
    const literal = createMcpHttpFetch({ url: new URL(`${base}/mcp`), allowPrivate: false });
    await expect(literal(`${base}/mcp`)).rejects.toThrow(/allowPrivate/);
    const name = new URL(`http://localhost:${port}/mcp`);
    const byName = createMcpHttpFetch({ url: name, allowPrivate: false });
    await expect(byName(name)).rejects.toThrow(/allowPrivate/);
  });

  it('comprueba la IP al conectar: un nombre que resuelve a loopback o a metadatos no pasa', async () => {
    const base = await listen((_q, r) => r.end('ok'));
    const port = new URL(base).port;
    const url = new URL(`http://mcp.example.test:${port}/mcp`);
    const rebind = createMcpHttpFetch({
      url,
      allowPrivate: false,
      lookup: fakeLookup('127.0.0.1'),
    });
    await expect(rebind(url)).rejects.toThrow(/resolves to 127\.0\.0\.1/);
    const meta = createMcpHttpFetch({
      url,
      allowPrivate: true,
      lookup: fakeLookup('169.254.169.254'),
    });
    await expect(meta(url)).rejects.toThrow(/link-local/);
    // Con allowPrivate, el mismo nombre resolviendo a loopback sí llega.
    const lan = createMcpHttpFetch({ url, allowPrivate: true, lookup: fakeLookup('127.0.0.1') });
    expect(await (await lan(url)).text()).toBe('ok');
  });

  it('pone la cabecera de autenticación y no deja que el llamador la cambie', async () => {
    let seen: string | undefined;
    const base = await listen((req, res) => {
      seen = req.headers.authorization;
      res.end('ok');
    });
    const f = createMcpHttpFetch({
      url: new URL(`${base}/mcp`),
      allowPrivate: true,
      authHeader: { name: 'Authorization', value: 'Bearer secreto' },
    });
    await f(`${base}/mcp`, { headers: { Authorization: 'Bearer otro' } });
    expect(seen).toBe('Bearer secreto');
  });

  it('corta una respuesta que pasa del tope', async () => {
    const base = await listen((_q, res) => res.end('x'.repeat(4096)));
    const f = createMcpHttpFetch({
      url: new URL(`${base}/mcp`),
      allowPrivate: true,
      maxResponseBytes: 1024,
    });
    const res = await f(`${base}/mcp`);
    await expect(res.text()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cliente contra un server MCP HTTP real (SDK, con sesión)
// ---------------------------------------------------------------------------

async function startMcpHttpServer(): Promise<{ url: string; auth: () => string | undefined }> {
  const server = new Server(
    { name: 'http-test', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'eco',
        description: 'Devuelve el texto',
        inputSchema: { type: 'object', properties: { texto: { type: 'string' } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: `eco: ${String(req.params.arguments?.texto ?? '')}` }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  let lastAuth: string | undefined;
  const base = await listen((req, res) => {
    lastAuth = req.headers.authorization;
    void transport.handleRequest(req, res);
  });
  return { url: `${base}/mcp`, auth: () => lastAuth };
}

function httpServerConfig(url: string, extra: Partial<McpServer> = {}): McpServer {
  return {
    name: 'remoto',
    args: [],
    url,
    allowPrivate: true,
    startupTimeout: 5000,
    toolTimeout: 5000,
    ...extra,
  };
}

describe('McpServerClient por Streamable HTTP', () => {
  it('conecta, descubre las tools y llama a una, con la cabecera del entorno', async () => {
    const srv = await startMcpHttpServer();
    process.env.STRATUM_TEST_MCP_TOKEN = 'tok-123';
    const client = new McpServerClient(
      httpServerConfig(srv.url, {
        auth: { env: 'STRATUM_TEST_MCP_TOKEN', header: 'Authorization', scheme: 'Bearer' },
      }),
    );
    try {
      await client.connect();
      expect(client.status).toBe('connected');
      expect(client.tools.map((t) => t.name)).toEqual(['eco']);
      const result = await client.callTool('eco', { texto: 'hola' });
      expect(result.content).toEqual([{ type: 'text', text: 'eco: hola' }]);
      expect(srv.auth()).toBe('Bearer tok-123');
      await client.ping(2000);
    } finally {
      await client.close();
    }
  });

  it('sin la variable de entorno no conecta, y el error la nombra sin valor', async () => {
    const srv = await startMcpHttpServer();
    const client = new McpServerClient(
      httpServerConfig(srv.url, {
        auth: { env: 'STRATUM_TEST_MCP_TOKEN', header: 'Authorization', scheme: 'Bearer' },
      }),
    );
    await expect(client.connect()).rejects.toThrow(/STRATUM_TEST_MCP_TOKEN is not set/);
    expect(client.status).toBe('disconnected');
    expect(srv.auth()).toBeUndefined();
  });

  it('sin allowPrivate, un server en loopback no conecta', async () => {
    const srv = await startMcpHttpServer();
    const client = new McpServerClient(httpServerConfig(srv.url, { allowPrivate: false }));
    await expect(client.connect()).rejects.toThrow(/allowPrivate/);
    expect(client.status).toBe('disconnected');
  });
});
