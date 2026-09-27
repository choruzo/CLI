// MCP server de pruebas sobre stdio (tests de integración de tools/mcp).
// Protocolo real del SDK, sin mocks: el cliente lo lanza con `node`.
//
// Entorno:
//   MCP_TEST_EXIT_ON_START=1   sale antes de hablar el protocolo
//   MCP_TEST_PAGE_SIZE=n       tamaño de página de tools/list (3)
//   MCP_TEST_SPAWN_LOG=ruta    añade una línea por arranque (cuenta relanzamientos)
//   MCP_TEST_EXTRA_TOOLS=a,b   tools adicionales (nombres libres, p. ej. inválidos)
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.env.MCP_TEST_SPAWN_LOG) {
  appendFileSync(process.env.MCP_TEST_SPAWN_LOG, `${process.pid}\n`);
}
if (process.env.MCP_TEST_EXIT_ON_START === '1') process.exit(2);

const pageSize = Number(process.env.MCP_TEST_PAGE_SIZE ?? 3);
const schema = (props = {}) => ({ type: 'object', properties: props });

const tools = [
  { name: 'echo', description: 'Echo text', inputSchema: schema({ text: { type: 'string' } }) },
  { name: 'slow', description: 'Wait ms', inputSchema: schema({ ms: { type: 'number' } }) },
  { name: 'crash', description: 'Exit mid-call', inputSchema: schema() },
  { name: 'freeze', description: 'Block the event loop', inputSchema: schema() },
  { name: 'resource', description: 'Embedded resources', inputSchema: schema() },
  { name: 'structured', description: 'Structured only', inputSchema: schema() },
  { name: 'fail', description: 'isError result', inputSchema: schema() },
  {
    name: 'add_tool',
    description: 'Add a tool',
    inputSchema: schema({ name: { type: 'string' } }),
  },
  {
    name: 'remove_tool',
    description: 'Remove a tool',
    inputSchema: schema({ name: { type: 'string' } }),
  },
];
for (const name of (process.env.MCP_TEST_EXTRA_TOOLS ?? '').split(',').filter(Boolean)) {
  tools.push({ name, description: `extra ${name}`, inputSchema: schema() });
}

const server = new Server(
  { name: 'stratum-test', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = Number(req.params?.cursor ?? 0);
  const page = tools.slice(start, start + pageSize);
  const next = start + pageSize < tools.length ? String(start + pageSize) : undefined;
  return next ? { tools: page, nextCursor: next } : { tools: page };
});

const text = (t) => ({ content: [{ type: 'text', text: t }] });

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const args = req.params.arguments ?? {};
  switch (req.params.name) {
    case 'echo':
      return text(String(args.text ?? ''));
    case 'slow':
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, Number(args.ms ?? 1000));
        extra.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('cancelled'));
        });
      });
      return text('done');
    case 'crash':
      setTimeout(() => process.exit(3), 20);
      return new Promise(() => {});
    case 'freeze': {
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        /* bloquea el event loop: ni responde a ping */
      }
      return text('unfrozen');
    }
    case 'resource':
      return {
        content: [
          {
            type: 'resource',
            resource: { uri: 'file:///r.txt', mimeType: 'text/plain', text: 'RESOURCE BODY' },
          },
          {
            type: 'resource',
            resource: { uri: 'file:///b.bin', mimeType: 'application/octet-stream', blob: 'AAAA' },
          },
        ],
      };
    case 'structured':
      return { content: [], structuredContent: { answer: 42 } };
    case 'fail':
      return { content: [{ type: 'text', text: 'boom' }], isError: true };
    case 'add_tool':
      tools.push({ name: String(args.name), description: 'dynamic', inputSchema: schema() });
      await server.sendToolListChanged();
      return text('added');
    case 'remove_tool': {
      const i = tools.findIndex((t) => t.name === args.name);
      if (i >= 0) tools.splice(i, 1);
      await server.sendToolListChanged();
      return text('removed');
    }
    default:
      if (tools.some((t) => t.name === req.params.name)) return text(`ran ${req.params.name}`);
      return {
        content: [{ type: 'text', text: `unknown tool ${req.params.name}` }],
        isError: true,
      };
  }
});

await server.connect(new StdioServerTransport());
