/**
 * Modelo de guion para `stratum eval --mock`: un servidor OpenAI-compatible en
 * loopback que contesta a la petición n con el paso n del guion del escenario.
 * Con él la trayectoria es reproducible y lo que se mide es el runtime (guardas,
 * políticas, recuperación), no el modelo.
 *
 * El `usage` que devuelve se deriva del tamaño real de la petición (caracteres
 * / 4): no son tokens de verdad, pero un prompt de sistema que crece entre dos
 * versiones se ve en la comparación.
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

export function startMockLlm(script: readonly ScriptStep[]): Promise<MockLlm> {
  let requests = 0;

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
      const prompt = approxTokens(raw.length);
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
          },
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
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
