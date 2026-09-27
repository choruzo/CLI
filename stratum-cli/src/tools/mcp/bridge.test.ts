import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeSegment,
  mcpToolName,
  parseMcpToolName,
  flattenContent,
  buildMcpTool,
  MCP_TOOL_NAME_MAX,
} from './bridge.js';
import type { McpServerClient, McpToolInfo } from './client.js';
import { ToolRegistry } from '../registry.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { StratumConfigSchema } from '../../config/schema.js';

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

describe('sanitizeSegment', () => {
  it('deja pasar caracteres válidos', () => {
    expect(sanitizeSegment('my-server_1')).toBe('my-server_1');
  });

  it('reemplaza / y espacios por _', () => {
    expect(sanitizeSegment('my/server name')).toBe('my_server_name');
  });
});

describe('mcpToolName', () => {
  it('genera nombre con prefijo mcp__', () => {
    expect(mcpToolName('filesystem', 'read_file')).toBe('mcp__filesystem__read_file');
  });

  it('sanitiza segmentos con caracteres especiales y los marca con hash', () => {
    expect(mcpToolName('my/server', 'read file')).toMatch(
      /^mcp__my_server_[0-9a-f]{6}__read_file_[0-9a-f]{6}$/,
    );
  });

  it('dos originales que sanitizan igual no colisionan', () => {
    expect(mcpToolName('a.b', 't')).not.toBe(mcpToolName('a_b', 't'));
    expect(mcpToolName('s', 'x y')).not.toBe(mcpToolName('s', 'x_y'));
    expect(mcpToolName('s', 'x y')).not.toBe(mcpToolName('s', 'x/y'));
  });

  it('es estable: el mismo par da siempre el mismo nombre', () => {
    expect(mcpToolName('my server', 'a.b')).toBe(mcpToolName('my server', 'a.b'));
  });

  it('un segmento vacío también lleva hash', () => {
    expect(mcpToolName('s', '')).toMatch(/^mcp__s___[0-9a-f]{6}$/);
  });

  it('recorta a 64 caracteres con hash del par original', () => {
    const long = 'get_' + 'x'.repeat(80);
    const a = mcpToolName('chrome-devtools', long);
    const b = mcpToolName('chrome-devtools', long + '_2');
    expect(a).toHaveLength(MCP_TOOL_NAME_MAX);
    expect(b).toHaveLength(MCP_TOOL_NAME_MAX);
    expect(a).not.toBe(b);
    expect(a.startsWith('mcp__chrome-devtools__get_xxx')).toBe(true);
  });

  it('cumple el regex ^[a-zA-Z0-9_-]+$ en todos los casos', () => {
    for (const [s, t] of [
      ['chrome-devtools', 'navigate_page'],
      ['my server', 'tool.with.dots'],
      ['ñandú', 'ümlaut'],
      ['s', 'y'.repeat(100)],
    ] as const) {
      const name = mcpToolName(s, t);
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(name.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX);
    }
  });
});

describe('parseMcpToolName', () => {
  it('parsea un nombre válido', () => {
    expect(parseMcpToolName('mcp__filesystem__read_file')).toEqual({
      server: 'filesystem',
      tool: 'read_file',
    });
  });

  it('devuelve null si no tiene prefijo mcp__', () => {
    expect(parseMcpToolName('read_file')).toBeNull();
  });

  it('devuelve null si sólo hay un segmento tras el prefijo', () => {
    expect(parseMcpToolName('mcp__onlyone')).toBeNull();
  });

  it('maneja tools con __ en el nombre', () => {
    const result = parseMcpToolName('mcp__server__tool__with__underscores');
    expect(result).toEqual({ server: 'server', tool: 'tool__with__underscores' });
  });
});

// ---------------------------------------------------------------------------
// flattenContent
// ---------------------------------------------------------------------------

describe('flattenContent', () => {
  it('aplana bloques text', () => {
    expect(
      flattenContent([
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ]),
    ).toBe('hello\nworld');
  });

  it('inserta placeholder para image y audio, con tamaño', () => {
    expect(flattenContent([{ type: 'image', mimeType: 'image/png' }])).toBe('[image: image/png]');
    expect(flattenContent([{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }])).toBe(
      '[audio: audio/wav, 3 bytes]',
    );
  });

  it('incluye el texto de un recurso embebido', () => {
    expect(
      flattenContent([
        { type: 'resource', resource: { uri: 'file:///foo.txt', text: 'hola\nmundo' } },
      ]),
    ).toBe('[resource: file:///foo.txt]\nhola\nmundo');
  });

  it('describe un recurso binario sin volcarlo', () => {
    expect(
      flattenContent([
        {
          type: 'resource',
          resource: { uri: 'file:///b.bin', mimeType: 'application/pdf', blob: 'AAAAAA==' },
        },
      ]),
    ).toBe('[resource: file:///b.bin, application/pdf, binary, 4 bytes]');
  });

  it('describe un resource_link', () => {
    expect(flattenContent([{ type: 'resource_link', uri: 'file:///l', name: 'log' }])).toBe(
      '[resource link: file:///l (log)]',
    );
  });

  it('inserta placeholder genérico para tipos desconocidos', () => {
    expect(flattenContent([{ type: 'hologram' }])).toBe('[hologram]');
  });

  it('sin bloques recurre a structuredContent', () => {
    expect(flattenContent([], { a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('tolera un content ausente o mal formado', () => {
    expect(flattenContent(undefined)).toBe('');
    expect(flattenContent('texto suelto')).toBe('');
    expect(flattenContent([null, 3, { type: 'text', text: 'ok' }])).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// buildMcpTool
// ---------------------------------------------------------------------------

function makeClient(status: McpServerClient['status'] = 'connected'): McpServerClient {
  return {
    name: 'filesystem',
    status,
    tools: [],
    connect: vi.fn(),
    callTool: vi.fn(),
    ping: vi.fn(),
    close: vi.fn(),
    reconnect: vi.fn(),
    toolTimeout: 120000,
  } as unknown as McpServerClient;
}

const sampleTool: McpToolInfo = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

const baseCtx = {
  signal: new AbortController().signal,
  cwd: '/tmp',
  // Config completa desde el schema: un objeto parcial deja de ser un
  // `StratumConfig` válido cada vez que el schema gana una clave.
  config: StratumConfigSchema.parse({
    tools: { confirmDestructive: false, destructivePatterns: [] },
    memory: { autoExtract: false },
  }),
};

describe('buildMcpTool', () => {
  it('genera el nombre correcto', () => {
    const tool = buildMcpTool(makeClient(), sampleTool);
    expect(tool.name).toBe('mcp__filesystem__read_file');
  });

  it('propaga la descripción', () => {
    const tool = buildMcpTool(makeClient(), sampleTool);
    expect(tool.description).toBe('Read a file');
  });

  it('rawParameters contiene el JSON Schema original', () => {
    const tool = buildMcpTool(makeClient(), sampleTool);
    expect(tool.rawParameters).toEqual(sampleTool.inputSchema);
  });

  it('toToolSchemas usa rawParameters directamente', () => {
    const registry = new ToolRegistry();
    registry.register(buildMcpTool(makeClient(), sampleTool));
    const schemas = registry.toToolSchemas();
    expect(schemas[0]!.function.parameters).toEqual(sampleTool.inputSchema);
  });

  it('devuelve XML de no disponible cuando el server está disconnected', async () => {
    const tool = buildMcpTool(makeClient('disconnected'), sampleTool);
    const result = await tool.execute({}, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('<tool_error>');
      expect(result.error).toContain("MCP server 'filesystem'");
      expect(result.recoverable).toBe(true);
    }
  });

  it('devuelve XML con "reconnecting..." cuando el server está reconectando', async () => {
    const tool = buildMcpTool(makeClient('reconnecting'), sampleTool);
    const result = await tool.execute({}, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('reconnecting...');
    }
  });

  it('propaga el resultado exitoso del server', async () => {
    const client = makeClient('connected');
    vi.mocked(client.callTool).mockResolvedValue({
      content: [{ type: 'text', text: 'file contents' }],
      isError: false,
    });
    const tool = buildMcpTool(client, sampleTool);
    const result = await tool.execute({ path: '/foo.txt' }, baseCtx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toBe('file contents');
  });

  it('devuelve ok:false cuando el server responde con isError:true', async () => {
    const client = makeClient('connected');
    vi.mocked(client.callTool).mockResolvedValue({
      content: [{ type: 'text', text: 'File not found' }],
      isError: true,
    });
    const tool = buildMcpTool(client, sampleTool);
    const result = await tool.execute({ path: '/missing.txt' }, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('File not found');
  });

  it('captura excepciones de callTool y las devuelve como ok:false', async () => {
    const client = makeClient('connected');
    vi.mocked(client.callTool).mockRejectedValue(new Error('connection lost'));
    const tool = buildMcpTool(client, sampleTool);
    const result = await tool.execute({}, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('connection lost');
  });

  it('el server no conectado no cuenta como fallo de la tool', async () => {
    const tool = buildMcpTool(makeClient('reconnecting'), sampleTool);
    const result = await tool.execute({}, baseCtx);
    expect(result).toMatchObject({ ok: false, countsAsFailure: false });
  });

  it('usa el toolTimeout del server como timeout de la tool y de la llamada', async () => {
    const client = makeClient('connected');
    (client as unknown as { toolTimeout: number }).toolTimeout = 4321;
    vi.mocked(client.callTool).mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
    const tool = buildMcpTool(client, sampleTool);
    expect(tool.timeout).toBe(4321);
    await tool.execute({}, baseCtx);
    expect(client.callTool).toHaveBeenCalledWith('read_file', {}, baseCtx.signal, 4321);
  });

  it('un cierre de conexión a mitad avisa de que la acción pudo hacerse', async () => {
    const client = makeClient('connected');
    vi.mocked(client.callTool).mockRejectedValue(
      new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
    );
    const result = await buildMcpTool(client, sampleTool).execute({}, baseCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('closed the connection');
      expect(result.error).toContain('may or may not have been performed');
    }
  });

  it('un error sin detalles y un resultado vacío se describen', async () => {
    const client = makeClient('connected');
    vi.mocked(client.callTool).mockResolvedValueOnce({ content: [], isError: true });
    vi.mocked(client.callTool).mockResolvedValueOnce({ content: [] });
    const tool = buildMcpTool(client, sampleTool);
    const err = await tool.execute({}, baseCtx);
    const ok = await tool.execute({}, baseCtx);
    expect(err.ok).toBe(false);
    if (!err.ok) expect(err.error).toContain('without details');
    expect(ok).toEqual({ ok: true, output: '(the tool returned no content)' });
  });

  it('un nombre renombrado lleva el original en la descripción', () => {
    const tool = buildMcpTool(makeClient(), { ...sampleTool, name: 'read.file' });
    expect(tool.name).toMatch(/^mcp__filesystem__read_file_[0-9a-f]{6}$/);
    expect(tool.description).toContain('(MCP tool "filesystem/read.file")');
  });
});
