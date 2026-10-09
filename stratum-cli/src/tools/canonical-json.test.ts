import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';
import { ToolRegistry } from './registry.js';
import { registerBuiltinTools } from './index.js';
import { OpenAICompatible } from '../providers/openai-compatible.js';
import type { ToolSchema } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';
import { TraceRecorder } from '../trace/recorder.js';
import type { TraceRecord } from '../trace/records.js';
import type { Message, ToolDefinition } from '../agent/types.js';

// El mismo JSON Schema tal como lo anunciaría un server MCP en dos arranques:
// mismas claves y mismos valores, en otro orden a todos los niveles.
const SCHEMA_A = {
  type: 'object',
  properties: {
    repo: { type: 'string', description: 'owner/name' },
    state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
    labels: { type: 'array', items: { type: 'string', minLength: 1 } },
    filter: {
      anyOf: [{ type: 'null' }, { type: 'object', properties: { since: { type: 'string' } } }],
    },
  },
  required: ['repo', 'state'],
  additionalProperties: false,
};

const SCHEMA_B = {
  additionalProperties: false,
  required: ['repo', 'state'],
  properties: {
    filter: {
      anyOf: [{ type: 'null' }, { properties: { since: { type: 'string' } }, type: 'object' }],
    },
    labels: { items: { minLength: 1, type: 'string' }, type: 'array' },
    state: { default: 'open', enum: ['open', 'closed', 'all'], type: 'string' },
    repo: { description: 'owner/name', type: 'string' },
  },
  type: 'object',
};

describe('canonicalJson', () => {
  it('dos valores equivalentes con otro orden de claves serializan igual', () => {
    expect(JSON.stringify(SCHEMA_A)).not.toBe(JSON.stringify(SCHEMA_B));
    expect(JSON.stringify(canonicalJson(SCHEMA_A))).toBe(JSON.stringify(canonicalJson(SCHEMA_B)));
  });

  it('ordena las claves a todos los niveles, también dentro de arrays', () => {
    const out = canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } });
    expect(JSON.stringify(out)).toBe('{"a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('conserva el orden de los arrays', () => {
    const out = canonicalJson(SCHEMA_B);
    expect(out.required).toEqual(['repo', 'state']);
    expect(out.properties.state.enum).toEqual(['open', 'closed', 'all']);
    expect(out.properties.filter.anyOf.map((s) => s.type)).toEqual(['null', 'object']);
  });

  it('no altera tipos ni valores', () => {
    const value = { n: 0, f: 1.5, s: '', t: true, x: null, list: [3, '3', false, null, []], o: {} };
    expect(canonicalJson(value)).toEqual(value);
    expect(canonicalJson(SCHEMA_B)).toEqual(SCHEMA_A);
    for (const scalar of ['texto', 7, false, null, undefined]) {
      expect(canonicalJson(scalar)).toBe(scalar);
    }
  });

  it('no muta el original y devuelve una copia', () => {
    const original = { b: { d: 1, c: [{ f: 1, e: 2 }] }, a: 1 };
    const before = JSON.stringify(original);
    const out = canonicalJson(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(out).not.toBe(original);
    expect(out.b).not.toBe(original.b);
    expect(out.b.c).not.toBe(original.b.c);
  });

  it('el orden no depende de la configuración regional', () => {
    // Por unidades de código: mayúsculas antes que minúsculas, sin colación.
    expect(Object.keys(canonicalJson({ b: 1, a: 1, B: 1, ä: 1, _x: 1, $ref: 1 }))).toEqual([
      '$ref',
      'B',
      '_x',
      'a',
      'b',
      'ä',
    ]);
  });

  it('una clave __proto__ es un dato, no un prototipo', () => {
    const hostile = JSON.parse('{"b":1,"__proto__":{"polluted":true},"a":2}') as object;
    const out = canonicalJson(hostile) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['__proto__', 'a', 'b']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// De extremo a extremo: el registro, la petición y la huella de la traza
// ---------------------------------------------------------------------------

const mcpTool = (name: string, rawParameters: Record<string, unknown>): ToolDefinition => ({
  name,
  description: `MCP ${name}`,
  schema: z.object({}),
  rawParameters,
  async execute() {
    return { ok: true, output: '' };
  },
});

/** Un arranque: las built-in más un catálogo MCP anunciado en cierto orden. */
function startup(tools: Array<[string, Record<string, unknown>]>): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, StratumConfigSchema.parse({}));
  for (const [name, schema] of tools) registry.register(mcpTool(name, schema));
  return registry;
}

const FIRST_BOOT = (): ToolRegistry =>
  startup([
    ['mcp__github__list_issues', SCHEMA_A],
    ['mcp__files__read', { type: 'object', properties: { path: { type: 'string' } } }],
  ]);
// Otro arranque: el otro server conecta antes y los dos serializan sus schemas distinto.
const SECOND_BOOT = (): ToolRegistry =>
  startup([
    ['mcp__files__read', { properties: { path: { type: 'string' } }, type: 'object' }],
    ['mcp__github__list_issues', SCHEMA_B],
  ]);

describe('schemas de tools MCP en forma canónica', () => {
  it('dos arranques con schemas equivalentes ofrecen las tools byte a byte igual', () => {
    const a = JSON.stringify(FIRST_BOOT().toToolSchemas());
    const b = JSON.stringify(SECOND_BOOT().toToolSchemas());
    expect(b).toBe(a);
  });

  it('el schema que registró el server queda intacto', () => {
    const raw = structuredClone(SCHEMA_B);
    const registry = startup([['mcp__github__list_issues', raw]]);
    registry.toToolSchemas();
    registry.toToolSchemas();
    expect(JSON.stringify(raw)).toBe(JSON.stringify(SCHEMA_B));
    expect(registry.get('mcp__github__list_issues')!.rawParameters).toBe(raw);
  });

  it('un schema distinto de verdad sigue siendo distinto', () => {
    const other = { ...SCHEMA_B, required: ['state', 'repo'] };
    const a = JSON.stringify(startup([['mcp__github__list_issues', SCHEMA_A]]).toToolSchemas());
    const b = JSON.stringify(startup([['mcp__github__list_issues', other]]).toToolSchemas());
    expect(b).not.toBe(a);
  });

  it('los schemas de las built-in no se reordenan: su orden lo fija el código', () => {
    const builtin = startup([]).toToolSchemas();
    const read = builtin.find((t) => t.function.name === 'read_file')!;
    expect(Object.keys(read.function.parameters)[0]).toBe('type');
    expect(JSON.stringify(startup([]).toToolSchemas())).toBe(JSON.stringify(builtin));
  });
});

let server: Server | undefined;
const bodies: string[] = [];

async function serve(): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      bodies.push(raw);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

let dir: string | undefined;

afterEach(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  bodies.length = 0;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const MESSAGES: Message[] = [
  { role: 'system', content: 'You are Stratum.' },
  { role: 'user', content: 'lista las incidencias abiertas' },
];

describe('la misma petición y la misma huella de prefijo', () => {
  it('el cuerpo que sale hacia el backend es idéntico byte a byte', async () => {
    const client = new OpenAICompatible(await serve(), 'key', 'm');
    for (const registry of [FIRST_BOOT(), SECOND_BOOT()]) {
      const request = {
        messages: MESSAGES,
        stream: true,
        model: 'm',
        tools: registry.toToolSchemas(),
      };
      for await (const _ of client.complete(request)) {
        /* consumir */
      }
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('mcp__github__list_issues');
    expect(bodies[1]).toBe(bodies[0]);
  });

  /** Huella y prefijo que la traza registra para una llamada con esas tools. */
  async function prefixes(toolsets: ToolSchema[][]): Promise<Array<Record<string, unknown>>> {
    dir = mkdtempSync(join(tmpdir(), 'stratum-canonical-'));
    const file = join(dir, 'sess.jsonl');
    const config = StratumConfigSchema.parse({ trace: { dir } });
    const rec = new TraceRecorder({ file, sessionId: 'sess', config });
    const scope = rec.scope();
    scope.turnStart('tarea', MESSAGES);
    toolsets.forEach((tools, i) => {
      scope
        .modelStart({
          iteration: i,
          model: 'm',
          messages: MESSAGES,
          tools: tools.length,
          toolSchemas: tools,
        })
        .end({ text: 'ok', reasoning: '', toolCalls: [] });
    });
    scope.turnEnd('stop');
    await rec.flush();
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TraceRecord)
      .flatMap((r) =>
        r.t === 'begin' && r.kind === 'model' ? [r.data!.prefix as Record<string, unknown>] : [],
      );
  }

  it('la huella de tools de la traza coincide y el prefijo no diverge', async () => {
    const [first, second] = await prefixes([
      FIRST_BOOT().toToolSchemas(),
      SECOND_BOOT().toToolSchemas(),
    ]);
    expect(first!.tools).toMatch(/^[0-9a-f]{8}$/);
    expect(second!.tools).toBe(first!.tools);
    expect(second!.diverged).toBeUndefined();
    expect(second!.sharedChars).toBe(first!.chars);
  });

  it('sin la forma canónica, los mismos schemas dan otra huella y rompen el prefijo', async () => {
    // Control: es el orden de las claves, y nada más, lo que separaba las dos peticiones.
    const offered = (schema: Record<string, unknown>): ToolSchema[] => [
      {
        type: 'function',
        function: { name: 'mcp__github__list_issues', description: 'd', parameters: schema },
      },
    ];
    const [first, second] = await prefixes([offered(SCHEMA_A), offered(SCHEMA_B)]);
    expect(second!.tools).not.toBe(first!.tools);
    expect(second!.diverged).toBe('tools');
  });
});
