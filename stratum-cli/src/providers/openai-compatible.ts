import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from './base.js';
import type { AgentEvent, Message } from '../agent/types.js';
import type { CacheCapabilities } from './cache.js';
import { getLogger } from '../logging/index.js';
import {
  ERROR_BODY_READ_LIMIT,
  ProviderError,
  httpError,
  networkError,
  safeOrigin,
  streamError,
  timeoutError,
} from './errors.js';

const log = getLogger('provider');

interface ToolBuffer {
  id: string;
  name: string;
  args: string;
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Longitud del sufijo de `text` que es prefijo de `tag` (un tag partido entre chunks). */
function partialTagSuffix(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) {
    if (tag.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

/**
 * Separa un bloque `<think>…</think>` al **principio** de la respuesta, que es
 * como lo mandan los backends que no extraen el razonamiento a
 * `reasoning_content` (Ollama con algunos modelos, llama.cpp con
 * `--reasoning-format none`). Solo al principio: un `<think>` a mitad de una
 * respuesta es texto del usuario (un ejemplo de código, por ejemplo), y una vez
 * cerrado el bloque todo lo demás pasa tal cual.
 */
export class ThinkTagSplitter {
  private mode: 'start' | 'think' | 'text' = 'start';
  private held = '';

  feed(chunk: string): { thinking: string; text: string } {
    if (this.mode === 'text') return { thinking: '', text: chunk };
    let pending = this.held + chunk;
    this.held = '';
    let thinking = '';

    if (this.mode === 'start') {
      const lead = pending.trimStart();
      if (lead.length === 0) {
        this.held = pending;
        return { thinking: '', text: '' };
      }
      if (lead.startsWith(THINK_OPEN)) {
        this.mode = 'think';
        pending = lead.slice(THINK_OPEN.length);
      } else if (THINK_OPEN.startsWith(lead)) {
        // `<thi` todavía puede ser el tag: se espera al siguiente chunk.
        this.held = pending;
        return { thinking: '', text: '' };
      } else {
        this.mode = 'text';
        return { thinking: '', text: pending };
      }
    }

    // mode === 'think'
    const close = pending.indexOf(THINK_CLOSE);
    if (close !== -1) {
      thinking = pending.slice(0, close);
      this.mode = 'text';
      // El salto que suele seguir al cierre no es parte de la respuesta.
      return { thinking, text: pending.slice(close + THINK_CLOSE.length).replace(/^\s+/, '') };
    }
    const keep = partialTagSuffix(pending, THINK_CLOSE);
    this.held = pending.slice(pending.length - keep);
    return { thinking: pending.slice(0, pending.length - keep), text: '' };
  }

  /** No retiene nada a la espera del siguiente chunk. */
  get idle(): boolean {
    return this.held.length === 0;
  }

  /** Fin del stream: lo retenido sale como lo que parecía ser. */
  flush(): { thinking: string; text: string } {
    const held = this.held;
    this.held = '';
    if (this.mode === 'think') return { thinking: held, text: '' };
    return { thinking: '', text: held };
  }

  reset(): void {
    this.mode = 'start';
    this.held = '';
  }
}

/**
 * Argumentos de una tool call → objeto. Vacío equivale a `{}` (backends que
 * mandan `""` para una tool sin parámetros); cualquier JSON que no sea un
 * objeto (`null`, un array, un número) es un error: el dispatcher y las
 * políticas leen `input.<campo>` y un `null` los hacía lanzar.
 */
export function parseToolArguments(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `Invalid JSON in tool arguments: ${raw}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `Tool arguments must be a JSON object, got: ${raw}` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export class StreamBuffer {
  private toolBuffers = new Map<number, ToolBuffer>();
  private think = new ThinkTagSplitter();

  feed(chunk: OpenAIStreamChunk): AgentEvent[] {
    const events: AgentEvent[] = [];
    const choice = chunk.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta;

    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) {
      events.push({ type: 'thinking', text: reasoning });
    }

    if (delta?.content) {
      const { thinking, text } = this.think.feed(delta.content);
      if (thinking) events.push({ type: 'thinking', text: thinking });
      if (text) events.push({ type: 'text_delta', delta: text });
    }

    // Tool calls o fin de la respuesta: lo retenido por si era un tag se suelta.
    if ((delta?.tool_calls?.length || choice.finish_reason) && !this.think.idle) {
      const { thinking, text } = this.think.flush();
      if (thinking) events.push({ type: 'thinking', text: thinking });
      if (text) events.push({ type: 'text_delta', delta: text });
    }

    for (const tc of delta?.tool_calls ?? []) {
      if (!this.toolBuffers.has(tc.index)) {
        const buf: ToolBuffer = {
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          args: '',
        };
        this.toolBuffers.set(tc.index, buf);
        events.push({
          type: 'tool_call_start',
          id: buf.id,
          name: buf.name,
          input_so_far: '',
        });
      }
      const buf = this.toolBuffers.get(tc.index)!;
      if (tc.id && !buf.id) buf.id = tc.id;
      if (tc.function?.name && !buf.name) buf.name = tc.function.name;
      if (tc.function?.arguments) buf.args += tc.function.arguments;

      events.push({
        type: 'tool_call_start',
        id: buf.id,
        name: buf.name,
        input_so_far: buf.args,
      });
    }

    // Cualquier `finish_reason` cierra las tool calls abiertas, no solo
    // `tool_calls`: varios backends (algunas versiones de Ollama y llama.cpp)
    // terminan una respuesta con tool calls con `stop`, y descartarlas dejaba
    // el turno acabado como si el modelo no hubiese pedido nada.
    if (choice.finish_reason) {
      events.push(...this.materialize(choice.finish_reason));
    }

    return events;
  }

  /**
   * Fin del stream (tras `[DONE]` o cuando el cuerpo se acaba). Suelta lo que
   * el splitter de `<think>` retenía y cierra las tool calls que ningún
   * `finish_reason` cerró — un backend que no lo manda, o una conexión cortada:
   * si los argumentos quedaron a medias, el parseo falla y el modelo recibe un
   * error recuperable en vez de perder la llamada en silencio.
   */
  finish(): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!this.think.idle) {
      const { thinking, text } = this.think.flush();
      if (thinking) events.push({ type: 'thinking', text: thinking });
      if (text) events.push({ type: 'text_delta', delta: text });
    }
    events.push(...this.materialize(null));
    return events;
  }

  private materialize(finishReason: string | null): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [, buf] of this.toolBuffers) {
      if (finishReason === 'length') {
        events.push({
          type: 'tool_error',
          id: buf.id,
          name: buf.name,
          error:
            'Tool call arguments were cut off: the response hit the output token limit ' +
            '(finish_reason "length"). Retry with shorter arguments (e.g. split a large ' +
            'write into several smaller edits).',
          recoverable: false,
        });
        continue;
      }
      const input = parseToolArguments(buf.args);
      if (input.ok) {
        events.push({ type: 'tool_call_ready', id: buf.id, name: buf.name, input: input.value });
      } else {
        events.push({
          type: 'tool_error',
          id: buf.id,
          name: buf.name,
          error: input.error,
          recoverable: false,
        });
      }
    }
    this.toolBuffers.clear();
    return events;
  }

  reset(): void {
    this.toolBuffers.clear();
    this.think.reset();
  }
}
/**
 * Timeouts del cliente (§12.3). Son de **inactividad**, no de duración total:
 * una respuesta larga que no para de llegar nunca se corta.
 *
 * - `headersMs`: hasta recibir las cabeceras HTTP. llama.cpp las manda al
 *   instante; un backend que ni contesta está caído o colgado.
 * - `idleMs`: sin recibir un solo byte del cuerpo. Cubre el procesado del
 *   prompt antes del primer token (llama.cpp tarda ~1 s por cada 1k tokens en
 *   GPU, mucho más en CPU) y los backends que no trocean las tool calls y las
 *   mandan enteras al final (Ollama con algunos modelos). Por eso es generoso.
 *
 * `0` desactiva cada uno.
 */
export interface ProviderTimeouts {
  headersMs: number;
  idleMs: number;
}

export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = {
  headersMs: 120_000,
  idleMs: 300_000,
};

export interface OpenAICompatibleOptions {
  timeouts?: Partial<ProviderTimeouts>;
  /** Qué admite el backend en caché de prompt. Sin ella, la petición no lleva nada extra. */
  cache?: CacheCapabilities;
}

type ContentPart = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Marcas `cache_control` para un backend con breakpoints explícitos (Anthropic
 * a través de una pasarela compatible): una al final del system prompt —el
 * prefijo que comparten todas las llamadas de la sesión— y otra en el último
 * mensaje `user`/`tool` con texto, para que la siguiente llamada reutilice la
 * conversación entera. Devuelve copias: el historial del agente no se toca.
 */
export function withCacheBreakpoints(messages: readonly Message[]): unknown[] {
  const mark = (m: Message): unknown => ({
    ...m,
    content: [
      { type: 'text', text: m.content ?? '', cache_control: { type: 'ephemeral' } },
    ] satisfies ContentPart[],
  });
  const markable = (m: Message | undefined): boolean =>
    !!m && typeof m.content === 'string' && m.content.length > 0;

  let last = -1;
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i]!;
    if ((m.role === 'user' || m.role === 'tool') && markable(m)) {
      last = i;
      break;
    }
  }
  return messages.map((m, i) =>
    (i === 0 && m.role === 'system' && markable(m)) || i === last ? mark(m) : m,
  );
}

/** Lee como mucho `limit` bytes del cuerpo y cancela el resto. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    // Sin esperar: con un cuerpo que no termina, `cancel()` podría colgar.
    void reader.cancel().catch(() => undefined);
  }
  return out;
}

/**
 * Temporizador de inactividad: `arm(ms, fase)` lo (re)inicia y, si vence,
 * aborta la petición con un `ProviderError` de timeout. `fired` dice si la
 * cancelación vino de aquí y no del usuario.
 */
class IdleWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly controller = new AbortController();
  fired: ProviderError | undefined;

  constructor(private readonly origin: string) {}

  arm(ms: number, phase: 'headers' | 'body'): void {
    this.clear();
    if (ms <= 0 || this.fired) return;
    this.timer = setTimeout(() => {
      this.fired = timeoutError(this.origin, ms, phase);
      this.controller.abort(this.fired);
    }, ms);
    // El temporizador no debe mantener vivo el proceso (`stratum run` al salir).
    this.timer.unref?.();
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class OpenAICompatible implements IProvider {
  private readonly timeouts: ProviderTimeouts;
  private readonly origin: string;
  private readonly cache: CacheCapabilities | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultModel: string,
    options: OpenAICompatibleOptions = {},
  ) {
    this.timeouts = { ...DEFAULT_PROVIDER_TIMEOUTS, ...options.timeouts };
    this.cache = options.cache;
    this.origin = safeOrigin(baseUrl);
  }

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this.cache?.explicitBreakpoints ? withCacheBreakpoints(req.messages) : req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    // Enrutado de caché: solo donde el backend lo declara. Un campo desconocido
    // hace que algunos servidores rechacen la petición entera.
    if (req.sessionId) {
      if (this.cache?.cacheKey) body['prompt_cache_key'] = req.sessionId;
      if (this.cache?.sessionAffinity) body['session_id'] = req.sessionId;
    }
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools;
      body['tool_choice'] = 'auto';
    }
    if (req.temperature !== undefined) {
      body['temperature'] = req.temperature;
    }

    // El apiKey nunca se registra: solo metadatos no sensibles del request.
    log.debug('request', {
      model: req.model,
      url,
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
      stream: true,
    });
    const endTimer = log.startTimer();

    const watchdog = new IdleWatchdog(this.origin);
    const signal = req.signal
      ? AbortSignal.any([req.signal, watchdog.controller.signal])
      : watchdog.controller.signal;

    // Un abort del usuario se propaga tal cual (el loop lo reconoce); uno del
    // watchdog se convierte en su `ProviderError`; el resto es un fallo de red.
    const translate = (err: unknown, phase: 'connect' | 'stream'): unknown => {
      if (req.signal?.aborted) return err;
      if (watchdog.fired) return watchdog.fired;
      if (err instanceof ProviderError) return err;
      return networkError(err, this.origin, phase);
    };

    try {
      watchdog.arm(this.timeouts.headersMs, 'headers');
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        throw translate(err, 'connect');
      }
      watchdog.arm(this.timeouts.idleMs, 'body');

      if (!response.ok) {
        let text = '';
        try {
          text = await readCapped(response.body, ERROR_BODY_READ_LIMIT);
        } catch {
          // Sin cuerpo legible el status basta.
        }
        if (req.signal?.aborted) throw req.signal.reason;
        const err = httpError(
          response.status,
          response.statusText,
          text,
          response.headers.get('content-type') ?? '',
          response.headers.get('retry-after'),
        );
        log.error('http error', {
          status: response.status,
          model: req.model,
          durationMs: endTimer(),
          retryable: err.retryable,
          body: err.message,
        });
        throw err;
      }

      if (!response.body) {
        log.error('empty response body', { model: req.model, status: response.status });
        throw new ProviderError('LLM API returned no response body', 'stream', true);
      }

      log.trace('response headers', { status: response.status, ttfbMs: endTimer() });

      // Cada bloque de bytes rearma el watchdog, antes de decodificar: un
      // comentario SSE de keep-alive (`: ping`) también cuenta como actividad.
      const idleMs = this.timeouts.idleMs;
      const keepAlive = new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
        transform(chunk, controller) {
          watchdog.arm(idleMs, 'body');
          controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
        },
      });

      const eventStream = response.body
        .pipeThrough(keepAlive)
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());

      let chunks = 0;
      let dropped = 0;
      let lastUsage: OpenAIStreamChunk['usage'];
      try {
        for await (const event of eventStream) {
          if (!('data' in event)) continue;
          const data = event.data.trim();
          if (data === '') continue;
          if (data === '[DONE]') break;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            dropped++;
            log.warn('malformed stream chunk dropped', {
              model: req.model,
              length: data.length,
              head: data.slice(0, 120),
            });
            req.onStreamWarning?.(
              `stream_chunk_dropped: el backend mandó un fragmento que no es JSON ` +
                `(${data.length} caracteres) y se descartó; si la respuesta llevaba una ` +
                'tool call, sus argumentos pueden llegar incompletos.',
            );
            continue;
          }
          if (!parsed || typeof parsed !== 'object') continue;
          const chunk = parsed as OpenAIStreamChunk & { error?: unknown };
          // llama.cpp, vLLM y LiteLLM mandan los errores a mitad de generación
          // como un evento `{"error": …}` sin `choices`. Antes se ignoraba y el
          // turno acababa vacío, como si el modelo no hubiese dicho nada.
          if (chunk.error) {
            throw streamError(chunk, this.origin);
          }
          // Yield tanto chunks con choices como el chunk final de usage (choices vacío)
          // (o los `timings` de llama.cpp, de donde sale lo reutilizado del KV cache)
          if (chunk.choices?.[0] || chunk.usage || chunk.timings) {
            chunks++;
            if (chunk.usage) lastUsage = chunk.usage;
            yield chunk;
          }
        }
      } catch (err) {
        throw translate(err, 'stream');
      }
      log.debug('response complete', {
        model: req.model,
        chunks,
        dropped,
        durationMs: endTimer(),
        promptTokens: lastUsage?.prompt_tokens,
        completionTokens: lastUsage?.completion_tokens,
        cachedTokens: lastUsage?.prompt_tokens_details?.cached_tokens,
      });
    } finally {
      watchdog.clear();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
