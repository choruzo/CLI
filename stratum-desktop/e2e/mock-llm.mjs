/**
 * Servidor OpenAI-compatible de mentira para la suite E2E (D7). Responde en
 * streaming SSE como llama.cpp: razonamiento en `reasoning_content`, texto en
 * `content` y tool calls fragmentadas. Qué responde depende del último
 * mensaje de la conversación, así cada test elige su guion con lo que escribe.
 *
 * Guiones (por el texto del usuario):
 * - «genera un informe» → `write_file` en outputs/informe.md y luego lo confirma.
 * - «lee el adjunto»    → `read_file` del primer adjunto y luego cita su contenido.
 * - «despacio»          → texto lento (para detener la respuesta).
 * - cualquier otro      → razona un poco y saluda.
 */
import { createServer } from 'node:http';

export const MODEL = 'e2e-model';
export const GREETING = 'Hola desde el modelo de pruebas.';
export const REASONING = 'El usuario saluda. Respondo con un saludo breve.';
export const REPORT_PATH = 'outputs/informe.md';
export const REPORT_BODY = '# Informe\n\nGenerado por la suite E2E de Stratum.\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** Trocea un texto como lo haría un tokenizador: por palabras con su espacio. */
function pieces(text) {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => p.text ?? '').join('');
  return '';
}

/** Guion de la respuesta: lista de chunks con su retraso. */
export function script(messages) {
  const last = messages[messages.length - 1];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const said = textOf(lastUser).toLowerCase();
  const steps = [];
  const say = (text, delay = 25) => {
    for (const p of pieces(text)) steps.push({ delay, delta: { content: p } });
  };
  const think = (text) => {
    for (const p of pieces(text)) steps.push({ delay: 30, delta: { reasoning_content: p } });
  };
  const call = (name, args) => {
    const json = JSON.stringify(args);
    const mid = Math.floor(json.length / 2);
    steps.push({
      delay: 20,
      delta: {
        tool_calls: [
          { index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: json.slice(0, mid) } },
        ],
      },
    });
    steps.push({ delay: 20, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] } });
    steps.push({ delay: 10, delta: {}, finish: 'tool_calls' });
  };

  if (last?.role === 'tool') {
    const result = textOf(last);
    if (said.includes('genera un informe')) {
      say(`He dejado el informe en ${REPORT_PATH}.`);
    } else if (said.includes('lee el adjunto')) {
      // read_file devuelve «N: línea»: se cita la primera.
      const first = /^\s*1:\s?(.*)$/m.exec(result)?.[1] ?? result.slice(0, 80);
      say(`El adjunto dice: ${first.trim()}`);
    } else {
      say('Hecho.');
    }
    steps.push({ delay: 5, delta: {}, finish: 'stop' });
    return steps;
  }

  if (said.includes('genera un informe')) {
    think('Tengo que escribir el informe en outputs.');
    call('write_file', { path: REPORT_PATH, content: REPORT_BODY });
    return steps;
  }
  if (said.includes('lee el adjunto')) {
    const path = /(inputs\/[^\s)]+)/.exec(textOf(lastUser))?.[1] ?? 'inputs/nota.txt';
    call('read_file', { path });
    return steps;
  }
  if (said.includes('despacio')) {
    // Un silencio inicial: da tiempo a ver el indicador de espera.
    steps.push({ delay: 2_000, delta: {} });
    for (let i = 1; i <= 200; i++) steps.push({ delay: 150, delta: { content: `${i} ` } });
    steps.push({ delay: 5, delta: {}, finish: 'stop' });
    return steps;
  }
  think(REASONING);
  say(GREETING);
  steps.push({ delay: 5, delta: {}, finish: 'stop' });
  return steps;
}

/** Arranca el servidor en un puerto libre de 127.0.0.1. */
export function startMockLlm() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'e2e' }] }));
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
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
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: null }))}\n\n`);
      for (const step of script(body.messages ?? [])) {
        if (closed) return;
        await sleep(step.delay);
        res.write(`data: ${JSON.stringify(chunk(step.delta, step.finish ?? null))}\n\n`);
      }
      if (body.stream_options?.include_usage) {
        res.write(
          `data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// `node e2e/mock-llm.mjs [puerto]`: servidor suelto para probar a mano.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  startMockLlm().then(({ baseUrl }) => console.log(`mock LLM en ${baseUrl}`));
}
