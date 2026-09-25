import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from './base.js';
import type { AgentEvent } from '../agent/types.js';
import { getLogger } from '../logging/index.js';

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

export class StreamBuffer {
  private toolBuffers = new Map<number, ToolBuffer>();
  private think = new ThinkTagSplitter();

  feed(chunk: OpenAIStreamChunk): AgentEvent[] {
    const events: AgentEvent[] = [];
    const choice = chunk.choices[0];
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

    if (choice.finish_reason === 'tool_calls') {
      for (const [, buf] of this.toolBuffers) {
        try {
          const input = JSON.parse(buf.args) as Record<string, unknown>;
          events.push({ type: 'tool_call_ready', id: buf.id, name: buf.name, input });
        } catch {
          events.push({
            type: 'tool_error',
            id: buf.id,
            name: buf.name,
            error: `Invalid JSON in tool arguments: ${buf.args}`,
            recoverable: false,
          });
        }
      }
      this.toolBuffers.clear();
    }

    return events;
  }

  reset(): void {
    this.toolBuffers.clear();
    this.think.reset();
  }
}

export class OpenAICompatible implements IProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultModel: string,
  ) {}

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
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

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      log.error('http error', {
        status: response.status,
        model: req.model,
        durationMs: endTimer(),
        body: text.slice(0, 500),
      });
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    if (!response.body) {
      log.error('empty response body', { model: req.model, status: response.status });
      throw new Error('LLM API returned no response body');
    }

    log.trace('response headers', { status: response.status, ttfbMs: endTimer() });

    const eventStream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    let chunks = 0;
    let lastUsage: OpenAIStreamChunk['usage'];
    for await (const event of eventStream) {
      if ('data' in event) {
        if (event.data === '[DONE]') break;
        try {
          const chunk = JSON.parse(event.data) as OpenAIStreamChunk;
          // Yield tanto chunks con choices como el chunk final de usage (choices vacío)
          if (chunk.choices?.[0] || chunk.usage) {
            chunks++;
            if (chunk.usage) lastUsage = chunk.usage;
            yield chunk;
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
    log.debug('response complete', {
      model: req.model,
      chunks,
      durationMs: endTimer(),
      promptTokens: lastUsage?.prompt_tokens,
      completionTokens: lastUsage?.completion_tokens,
    });
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
