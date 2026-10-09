/**
 * Modelo de guion para `stratum eval --mock`: un servidor OpenAI-compatible en
 * loopback que contesta a la petición n con el paso n del guion del escenario.
 * Con él la trayectoria es reproducible y lo que se mide es el runtime (guardas,
 * políticas, recuperación), no el modelo.
 *
 * El `usage` que devuelve se deriva del tamaño real de la petición (caracteres
 * / 4): no son tokens de verdad, pero un prompt de sistema que crece entre dos
 * versiones se ve en la comparación.
 *
 * También simula una **caché de prefijo** ideal, que es lo que hace medible el
 * prompt caching sin un backend real: `cached_tokens` es el prefijo más largo
 * que la petición comparte con alguna anterior de este mismo servidor, en el
 * orden en que un backend procesa el prompt (tools, system, conversación), y el
 * primer token tarda en proporción a lo que NO salió de caché. No modela ni
 * TTL, ni tamaño mínimo de prefijo, ni desalojos: es la cota de lo reutilizable.
 * Los prompts anteriores viven en memoria mientras dura el escenario.
 */
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { ScriptStep } from './scenario.js';

export const MOCK_MODEL = 'eval-mock';
const EXHAUSTED_TEXT = '[eval-mock] guion agotado: no hay respuesta prevista para esta petición.';

export interface MockLlm {
  baseUrl: string;
  /** Peticiones de chat recibidas. */
  requests(): number;
  close(): Promise<void>;
}

const approxTokens = (chars: number): number => Math.ceil(chars / 4);

/** Retardo simulado del procesado del prompt: ms por token no servido de caché. */
export const MOCK_MS_PER_UNCACHED_TOKEN = 0.03;
const MOCK_MAX_PROMPT_DELAY_MS = 400;

/** El prompt en el orden en que cuenta para el prefijo: tools, luego mensajes. */
export function renderPromptForCache(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const { tools, messages } = body as { tools?: unknown; messages?: unknown };
  const parts = [JSON.stringify(tools ?? [])];
  if (Array.isArray(messages)) for (const m of messages) parts.push(JSON.stringify(m));
  return parts.join('');
}

export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Prefijo más largo de `prompt` ya visto en alguna petición anterior. */
export function cachedPrefixLength(prompt: string, seen: readonly string[]): number {
  let best = 0;
  for (const prev of seen) best = Math.max(best, commonPrefixLength(prompt, prev));
  return best;
}

export function startMockLlm(script: readonly ScriptStep[]): Promise<MockLlm> {
  let requests = 0;
  const seenPrompts: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL }] }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const step: ScriptStep = script[requests] ?? { text: EXHAUSTED_TEXT };
      requests++;

      let rendered = '';
      try {
        rendered = renderPromptForCache(JSON.parse(raw));
      } catch {
        /* petición que no es JSON: sin caché que simular */
      }
      const prompt = approxTokens(raw.length);
      const cached = Math.min(Math.floor(cachedPrefixLength(rendered, seenPrompts) / 4), prompt);
      // Una petición que acaba en error no deja nada en caché.
      if (!step.error && rendered) seenPrompts.push(rendered);

      if (step.error) {
        res.writeHead(step.error.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.error.message } }));
        return;
      }

      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-eval',
          object: 'chat.completion.chunk',
          created: 0,
          model: MOCK_MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const delay = Math.min(
        (prompt - cached) * MOCK_MS_PER_UNCACHED_TOKEN,
        MOCK_MAX_PROMPT_DELAY_MS,
      );
      setTimeout(() => respond(), delay);

      const respond = (): void => {
        let out = 0;
        if (step.reasoning) {
          out += step.reasoning.length;
          res.write(chunk({ reasoning_content: step.reasoning }, null));
        }
        if (step.text) {
          out += step.text.length;
          res.write(chunk({ content: step.text }, null));
        }
        const calls = step.toolCalls ?? [];
        calls.forEach((call, index) => {
          const args = JSON.stringify(call.args);
          out += call.name.length + args.length;
          res.write(
            chunk(
              {
                tool_calls: [
                  {
                    index,
                    id: `call_${requests}_${index}`,
                    type: 'function',
                    function: { name: call.name, arguments: args },
                  },
                ],
              },
              null,
            ),
          );
        });
        res.write(chunk({}, calls.length > 0 ? 'tool_calls' : 'stop'));
        const completion = approxTokens(out);
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-eval',
            object: 'chat.completion.chunk',
            created: 0,
            model: MOCK_MODEL,
            choices: [],
            usage: {
              prompt_tokens: prompt,
              completion_tokens: completion,
              total_tokens: prompt + completion,
              prompt_tokens_details: { cached_tokens: cached },
            },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      };
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests: () => requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
