import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeSegment,
  mcpToolName,
  parseMcpToolName,
  flattenContent,
  buildMcpTool,
} from './bridge.js';
import type { McpServerClient, McpToolInfo } from './client.js';
import { ToolRegistry } from '../registry.js';

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

  it('sanitiza segmentos con caracteres especiales', () => {
    expect(mcpToolName('my/server', 'read file')).toBe('mcp__my_server__read_file');
  });

  it('cumple el regex ^[a-zA-Z0-9_-]+$', () => {
    const name = mcpToolName('chrome-devtools', 'navigate_page');
    expect(/^[a-zA-Z0-9_-]+$/.test(name)).toBe(true);
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

  it('inserta placeholder para image', () => {
    expect(flattenContent([{ type: 'image', mimeType: 'image/png' }])).toBe('[image: image/png]');
  });

  it('inserta placeholder para resource', () => {
    expect(flattenContent([{ type: 'resource', uri: 'file:///foo' }])).toBe(
      '[resource: file:///foo]',
    );
  });

  it('inserta placeholder genérico para tipos desconocidos', () => {
    expect(flattenContent([{ type: 'audio' }])).toBe('[audio]');
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
  config: {
    tools: {
      confirmDestructive: false,
      bashTimeout: 30000,
      webSearch: { backend: 'meta' as const, apiKey: '', tavilyApiKey: '', maxResults: 10 },
      destructivePatterns: [],
    },
    mcp: { servers: [], heartbeatInterval: 30000 },
    memory: {
      projectFile: '',
      globalFile: '',
      decisionsFile: '',
      vectorDb: '',
      embeddingModel: '',
      retrievalTopK: 5,
      embeddingWarmup: false,
    },
    agent: {
      maxIterations: 50,
      maxToolRetries: 3,
      toolErrorFormat: 'xml' as const,
      compressionKeepRounds: 6,
      compressionThreshold: 0.8,
    },
  },
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
});
