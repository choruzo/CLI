/**
 * Servidor OpenAI-compatible de mentira para manejar la TUI (`harness.mjs`).
 * Responde en streaming SSE como llama.cpp. Qué responde lo decide un guion:
 * una función que recibe la petición y devuelve los pasos de la respuesta.
 *
 * Guion por defecto (por el texto del último mensaje del usuario):
 * - «lista»    → `list_directory` de `.` y luego resume el resultado.
 * - «borra»    → `exec` que borra `victima.txt` (pide confirmación destructiva).
 * - «lento»    → doce palabras a 400 ms (para cancelar a mitad).
 * - «error401» → HTTP 401. «error500» → HTTP 500 (transitorio: se reintenta).
 * - otro       → razona un poco y saluda con markdown.
 *
 * Ojo: tras cancelar un turno, el siguiente input se fusiona con el `user`
 * anterior (nunca dos `user` seguidos), así que `said` lleva los dos textos.
 */
import { createServer } from 'node:http';

export const MODEL = 'mock-model';
export const GREETING = 'Hola desde el **mock**. Esto es `código` y una lista:\n\n- uno\n- dos\n';
export const SLOW_WORDS = 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pieces = (text) => text.match(/\S+\s*|\s+/g) ?? [];

/** Pasos de un guion. `delay` es la espera en ms antes de cada trozo. */
export const text = (value, delay = 20) =>
  pieces(value).map((p) => ({ delay, delta: { content: p } }));
export const reasoning = (value, delay = 20) =>
  pieces(value).map((p) => ({ delay, delta: { reasoning_content: p } }));
export const toolCall = (name, args, id = `call_${Math.random().toString(36).slice(2, 10)}`) => [
  {
    delay: 20,
    toolCall: true,
    delta: {
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  },
];
/** Respuesta HTTP de error en lugar de un stream. */
export const httpError = (status, message) => ({ status, message });

function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => p.text ?? '').join('');
  return '';
}

/** Guion por defecto: ver la cabecera del fichero. */
export function defaultScript({ said, last }) {
  if (said.includes('error401')) return httpError(401, 'Invalid API key');
  if (said.includes('error500')) return httpError(500, 'upstream exploded');
  if (last.role === 'tool') {
    const out = textOf(last).replace(/\s+/g, ' ').slice(0, 60);
    return text(`Hecho. Resultado de la tool recibido: ${out}`);
  }
  if (said.includes('lista')) return toolCall('list_directory', { path: '.' });
  if (said.includes('borra')) {
    const command = process.platform === 'win32' ? 'Remove-Item victima.txt' : 'rm victima.txt';
    return toolCall('exec', { command });
  }
  if (said.includes('lento')) return text(SLOW_WORDS, 400);
  return [...reasoning('Pienso un poco.'), ...text(GREETING)];
}

/**
 * Arranca el servidor en un puerto libre de 127.0.0.1.
 * `script({ body, messages, last, said, n })` devuelve pasos o `httpError()`.
 */
export function startMockLlm(script = defaultScript) {
  const requests = [];
  const chunk = (delta, finish = null) => ({
    id: 'chatcmpl-tui',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL }, { id: 'otro-modelo' }] }));
      return;
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    requests.push(body);
    const messages = body.messages ?? [];
    const last = messages[messages.length - 1] ?? {};
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const said = textOf(lastUser).toLowerCase();
    const plan = await script({ body, messages, last, said, n: requests.length });

    if (!Array.isArray(plan)) {
      res.writeHead(plan.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: plan.message } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    for (const step of plan) {
      await sleep(step.delay ?? 0);
      if (closed) return;
      res.write(`data: ${JSON.stringify(chunk(step.delta))}\n\n`);
    }
    const finish = plan.some((s) => s.toolCall) ? 'tool_calls' : 'stop';
    res.write(`data: ${JSON.stringify(chunk({}, finish))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Config mínima de `.stratumrc.json` que apunta al mock. */
export function mockConfig(baseUrl, extra = {}) {
  return {
    provider: {
      default: 'mock',
      providers: {
        mock: {
          type: 'openai-compatible',
          baseUrl,
          model: MODEL,
          apiKey: 'k',
          contextWindow: 32768,
        },
      },
    },
    // El extractor de decisiones haría peticiones extra al mock en background.
    memory: { autoExtract: false },
    ...extra,
  };
}
