import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatible, withCacheBreakpoints } from './openai-compatible.js';
import { ProviderRouter, cacheCapabilitiesOf } from './router.js';
import { resolveCacheCapabilities, type CacheCapabilities } from './cache.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { OpenAIStreamChunk } from './base.js';
import type { Message } from '../agent/types.js';

// Servidor real: lo que se comprueba es el cuerpo exacto que sale hacia el backend.

let server: Server | undefined;
let lastBody: Record<string, unknown> = {};

async function serve(lines: string[]): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const line of lines) res.write(`data: ${line}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  server?.closeAllConnections?.();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const TEXT = JSON.stringify({
  choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
});

const MESSAGES: Message[] = [
  { role: 'system', content: 'You are Stratum.' },
  { role: 'user', content: 'lee el fichero' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'c1', content: '1: hola' },
];

async function send(
  baseUrl: string,
  cache: CacheCapabilities | undefined,
  sessionId: string | undefined = 'sess_1',
): Promise<OpenAIStreamChunk[]> {
  const client = new OpenAICompatible(baseUrl, 'key', 'm', { cache });
  const chunks: OpenAIStreamChunk[] = [];
  for await (const chunk of client.complete({
    messages: MESSAGES,
    stream: true,
    model: 'm',
    sessionId,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('OpenAICompatible — lo que la caché añade a la petición', () => {
  it('sin capacidades, la petición no lleva nada extra', async () => {
    await send(await serve([TEXT]), undefined);
    expect(lastBody).not.toHaveProperty('prompt_cache_key');
    expect(lastBody).not.toHaveProperty('session_id');
    expect(lastBody.messages).toEqual(MESSAGES);
  });

  it('un backend OpenAI-compatible cualquiera tampoco: nada se asume', async () => {
    await send(await serve([TEXT]), resolveCacheCapabilities('unknown'));
    expect(Object.keys(lastBody).sort()).toEqual(['messages', 'model', 'stream', 'stream_options']);
    expect(lastBody.messages).toEqual(MESSAGES);
  });

  it('prompt_cache_key solo con cacheKey, y lleva el id de sesión', async () => {
    await send(await serve([TEXT]), resolveCacheCapabilities('openai'));
    expect(lastBody.prompt_cache_key).toBe('sess_1');
    expect(lastBody).not.toHaveProperty('session_id');
  });

  it('session_id solo con sessionAffinity', async () => {
    await send(await serve([TEXT]), resolveCacheCapabilities('sglang', { sessionAffinity: true }));
    expect(lastBody.session_id).toBe('sess_1');
    expect(lastBody).not.toHaveProperty('prompt_cache_key');
  });

  it('sin id de sesión no se manda ninguna de las dos', async () => {
    const caps = resolveCacheCapabilities('openai', { sessionAffinity: true });
    const client = new OpenAICompatible(await serve([TEXT]), 'key', 'm', { cache: caps });
    for await (const _ of client.complete({ messages: MESSAGES, stream: true, model: 'm' })) {
      /* consumir */
    }
    expect(lastBody).not.toHaveProperty('prompt_cache_key');
    expect(lastBody).not.toHaveProperty('session_id');
  });

  it('explicitBreakpoints marca el system y el último mensaje con texto, sin tocar el historial', async () => {
    const before = JSON.stringify(MESSAGES);
    await send(
      await serve([TEXT]),
      resolveCacheCapabilities('litellm', { explicitBreakpoints: true }),
    );
    const sent = lastBody.messages as Array<Record<string, unknown>>;
    const marked = { type: 'ephemeral' };
    expect(sent[0]!.content).toEqual([
      { type: 'text', text: 'You are Stratum.', cache_control: marked },
    ]);
    expect(sent[3]!.content).toEqual([{ type: 'text', text: '1: hola', cache_control: marked }]);
    // Los de en medio viajan como siempre.
    expect(sent[1]).toEqual(MESSAGES[1]);
    expect(sent[2]).toEqual(MESSAGES[2]);
    expect(JSON.stringify(MESSAGES)).toBe(before);
  });

  it('un chunk solo con timings de llama.cpp llega al loop', async () => {
    const chunks = await send(
      await serve([TEXT, JSON.stringify({ timings: { cache_n: 900, prompt_n: 100 } })]),
      undefined,
    );
    expect(chunks.at(-1)?.timings).toEqual({ cache_n: 900, prompt_n: 100 });
  });
});

describe('withCacheBreakpoints', () => {
  it('como mucho dos marcas, y nunca en un assistant ni en un mensaje vacío', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'tarea' },
      { role: 'assistant', content: 'respuesta' },
    ];
    const out = withCacheBreakpoints(messages) as Array<{ content: unknown }>;
    expect(Array.isArray(out[0]!.content)).toBe(true);
    expect(Array.isArray(out[1]!.content)).toBe(true);
    expect(out[2]!.content).toBe('respuesta');
    expect(JSON.stringify(out).match(/cache_control/g)).toHaveLength(2);
  });

  it('con solo el system, una marca', () => {
    const out = withCacheBreakpoints([{ role: 'system', content: 'sys' }]);
    expect(JSON.stringify(out).match(/cache_control/g)).toHaveLength(1);
  });
});

describe('capacidades de caché por provider', () => {
  const config = StratumConfigSchema.parse({
    provider: {
      default: 'local',
      providers: {
        local: { type: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', model: 'm' },
        openai: { type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'm' },
        gateway: {
          type: 'openai-compatible',
          baseUrl: 'http://localhost:4000/v1',
          model: 'claude',
          cache: { explicitBreakpoints: true },
        },
        sglang: {
          type: 'openai-compatible',
          baseUrl: 'http://gpu-box:30000/v1',
          model: 'm',
          cache: { sessionAffinity: true },
        },
      },
    },
  });

  it('se infieren del backend y la config las ajusta', () => {
    const providers = config.provider!.providers;
    expect(cacheCapabilitiesOf(providers.local!)).toMatchObject({
      automaticPrefix: true,
      cacheKey: false,
    });
    expect(cacheCapabilitiesOf(providers.openai!).cacheKey).toBe(true);
    expect(cacheCapabilitiesOf(providers.gateway!).explicitBreakpoints).toBe(true);
    expect(cacheCapabilitiesOf(providers.sglang!)).toMatchObject({
      automaticPrefix: true,
      sessionAffinity: true,
    });
  });

  it('el router expone las del provider activo y siguen al cambio de provider', () => {
    const router = new ProviderRouter(config);
    expect(router.cacheCapabilities.cacheKey).toBe(false);
    router.switchProvider('openai');
    expect(router.cacheCapabilities.cacheKey).toBe(true);
  });

  it('la sección cache no admite claves desconocidas', () => {
    expect(() =>
      StratumConfigSchema.parse({
        provider: {
          default: 'x',
          providers: {
            x: {
              type: 'openai-compatible',
              baseUrl: 'http://localhost:8080/v1',
              cache: { cacheKeys: true },
            },
          },
        },
      }),
    ).toThrow();
  });
});
