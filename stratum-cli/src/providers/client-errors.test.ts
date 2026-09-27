import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatible } from './openai-compatible.js';
import { ProviderError, describeErrorBody, parseRetryAfter, networkError } from './errors.js';
import type { OpenAIStreamChunk } from './base.js';

// Servidor HTTP real en proceso: el watchdog, los cortes y los códigos de
// error se prueban contra sockets de verdad, no contra un `fetch` simulado.

type Handler = (res: ServerResponse) => void;

let server: Server | undefined;
const openSockets = new Set<import('node:net').Socket>();

async function serve(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(res));
  });
  server.on('connection', (s) => {
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/v1`;
}

afterEach(async () => {
  for (const s of openSockets) s.destroy();
  openSockets.clear();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

function sse(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
}

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

async function drain(
  client: OpenAICompatible,
  extra: { signal?: AbortSignal; onStreamWarning?: (m: string) => void } = {},
): Promise<{ chunks: OpenAIStreamChunk[]; error?: unknown }> {
  const chunks: OpenAIStreamChunk[] = [];
  try {
    for await (const c of client.complete({ messages: [], stream: true, model: 'm', ...extra })) {
      chunks.push(c);
    }
    return { chunks };
  } catch (error) {
    return { chunks, error };
  }
}

describe('OpenAICompatible — errores HTTP', () => {
  it('un 400 con JSON de llama.cpp da el mensaje del backend y no es reintentable', async () => {
    const url = await serve((res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 400,
            message: 'request (200017 tokens) exceeds the available context size (40960 tokens)',
            type: 'exceed_context_size_error',
          },
        }),
      );
    });
    const { error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    expect(error).toBeInstanceOf(ProviderError);
    const pe = error as ProviderError;
    expect(pe.kind).toBe('http');
    expect(pe.retryable).toBe(false);
    expect(pe.details.status).toBe(400);
    expect(pe.message).toMatch(/^LLM API error 400 Bad Request: request \(200017 tokens\) exceeds/);
  });

  it('un 503 con Retry-After es reintentable y lleva la espera', async () => {
    const url = await serve((res) => {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
      res.end('{"error":{"message":"Loading model"}}');
    });
    const { error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    const pe = error as ProviderError;
    expect(pe.retryable).toBe(true);
    expect(pe.details.retryAfterMs).toBe(2000);
    expect(pe.message).toContain('Loading model');
  });

  it('una página HTML de un proxy no llega entera al mensaje', async () => {
    const url = await serve((res) => {
      res.writeHead(502, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body>${'x'.repeat(5000)}</body></html>`);
    });
    const { error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    const pe = error as ProviderError;
    expect(pe.retryable).toBe(true);
    expect(pe.message).toMatch(/respuesta HTML \(\d+ bytes\)/);
    expect(pe.message).not.toContain('xxxx');
  });

  it('un cuerpo de error que no termina no cuelga la petición', async () => {
    const url = await serve((res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      // Más del límite de lectura y sin `end()`.
      res.write('e'.repeat(80 * 1024));
    });
    const { error } = await drain(
      new OpenAICompatible(url, 'k', 'm', { timeouts: { idleMs: 2000 } }),
    );
    const pe = error as ProviderError;
    expect(pe.kind).toBe('http');
    expect(pe.details.status).toBe(500);
    expect(pe.message.length).toBeLessThan(700);
  });

  it('un secreto que el backend devuelve en el error sale redactado', async () => {
    const url = await serve((res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"invalid key sk-proj-abc123def456ghi789jkl"}}');
    });
    const { error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    expect((error as Error).message).not.toContain('abc123def456');
    expect((error as Error).message).toContain('[redacted:');
  });
});

describe('OpenAICompatible — timeouts de inactividad', () => {
  it('un backend que no manda cabeceras vence headersMs', async () => {
    const url = await serve(() => {
      /* nunca responde */
    });
    const t0 = Date.now();
    const { error } = await drain(
      new OpenAICompatible(url, 'k', 'm', { timeouts: { headersMs: 200 } }),
    );
    expect(Date.now() - t0).toBeLessThan(3000);
    const pe = error as ProviderError;
    expect(pe.kind).toBe('timeout');
    expect(pe.retryable).toBe(false);
    expect(pe.message).toMatch(/did not answer within/);
  });

  it('un stream que se para a mitad vence idleMs después de entregar lo recibido', async () => {
    const url = await serve((res) => {
      sse(res);
      res.write(chunk('hola'));
      // y se queda callado
    });
    const { chunks, error } = await drain(
      new OpenAICompatible(url, 'k', 'm', { timeouts: { idleMs: 300 } }),
    );
    expect(chunks).toHaveLength(1);
    expect((error as ProviderError).kind).toBe('timeout');
    expect((error as Error).message).toMatch(/sent nothing for/);
  });

  it('los keep-alive SSE cuentan como actividad', async () => {
    const url = await serve((res) => {
      sse(res);
      let n = 0;
      const timer = setInterval(() => {
        n++;
        if (n < 6) {
          res.write(': ping\n\n');
        } else {
          clearInterval(timer);
          res.write(chunk('fin'));
          res.end('data: [DONE]\n\n');
        }
      }, 100);
    });
    const { chunks, error } = await drain(
      new OpenAICompatible(url, 'k', 'm', { timeouts: { idleMs: 300 } }),
    );
    expect(error).toBeUndefined();
    expect(chunks).toHaveLength(1);
  });

  it('idleMs: 0 desactiva el watchdog', async () => {
    const url = await serve((res) => {
      sse(res);
      setTimeout(() => res.end(chunk('tarde') + 'data: [DONE]\n\n'), 400);
    });
    const { chunks, error } = await drain(
      new OpenAICompatible(url, 'k', 'm', { timeouts: { idleMs: 0, headersMs: 0 } }),
    );
    expect(error).toBeUndefined();
    expect(chunks).toHaveLength(1);
  });

  it('la cancelación del usuario se propaga como abort, no como timeout ni error de red', async () => {
    const url = await serve((res) => {
      sse(res);
      res.write(chunk('a'));
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const { error } = await drain(new OpenAICompatible(url, 'k', 'm'), { signal: ctrl.signal });
    expect(error).not.toBeInstanceOf(ProviderError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('OpenAICompatible — contenido del stream', () => {
  it('un chunk que no es JSON se descarta con aviso y el resto sigue', async () => {
    const url = await serve((res) => {
      sse(res);
      res.write(chunk('uno'));
      res.write('data: {"choices": [roto\n\n');
      res.write(chunk('dos'));
      res.end('data: [DONE]\n\n');
    });
    const warnings: string[] = [];
    const { chunks, error } = await drain(new OpenAICompatible(url, 'k', 'm'), {
      onStreamWarning: (m) => warnings.push(m),
    });
    expect(error).toBeUndefined();
    expect(chunks).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^stream_chunk_dropped:/);
  });

  it('un {"error": …} a mitad del stream es un error, no un turno vacío', async () => {
    const url = await serve((res) => {
      sse(res);
      res.write(chunk('empiezo'));
      res.end('data: {"error":{"message":"KV cache full","type":"server_error"}}\n\n');
    });
    const { chunks, error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    expect(chunks).toHaveLength(1);
    const pe = error as ProviderError;
    expect(pe.kind).toBe('stream');
    expect(pe.message).toContain('KV cache full');
  });

  it('un corte de conexión a mitad es un error de red de fase stream', async () => {
    const url = await serve((res) => {
      sse(res);
      res.write(chunk('a'));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const { chunks, error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    expect(chunks).toHaveLength(1);
    const pe = error as ProviderError;
    expect(pe.kind).toBe('network');
    expect(pe.message).toMatch(/was interrupted/);
  });
});

describe('OpenAICompatible — errores de red', () => {
  it('conexión rechazada: reintentable, con el código y sin la ruta de la URL', async () => {
    const url = await serve(() => {});
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const { error } = await drain(new OpenAICompatible(url, 'k', 'm'));
    const pe = error as ProviderError;
    expect(pe.kind).toBe('network');
    expect(pe.retryable).toBe(true);
    expect(pe.message).toMatch(
      /^LLM connection failed to http:\/\/127\.0\.0\.1:\d+: ECONNREFUSED$/,
    );
  });

  it('las credenciales de la baseUrl no aparecen en el mensaje', () => {
    const err = networkError(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
      'http://llm.local:8080',
      'connect',
    );
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('LLM connection failed to http://llm.local:8080: ENOTFOUND');
  });
});

describe('helpers de errores', () => {
  it('describeErrorBody: formatos de Ollama y texto plano', () => {
    expect(describeErrorBody('{"error":"model \\"x\\" not found"}')).toBe('model "x" not found');
    expect(describeErrorBody('upstream   connect\n error')).toBe('upstream connect error');
    expect(describeErrorBody('')).toBe('');
  });

  it('parseRetryAfter: segundos, fecha HTTP y basura', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter('pronto')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
