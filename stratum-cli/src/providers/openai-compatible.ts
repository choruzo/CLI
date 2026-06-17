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

export class StreamBuffer {
  private toolBuffers = new Map<number, ToolBuffer>();

  feed(chunk: OpenAIStreamChunk): AgentEvent[] {
    const events: AgentEvent[] = [];
    const choice = chunk.choices[0];
    if (!choice) return events;

    const delta = choice.delta;

    if (delta?.content) {
      events.push({ type: 'text_delta', delta: delta.content });
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
