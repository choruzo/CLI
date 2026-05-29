import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from './base.js';
import type { AgentEvent } from '../agent/types.js';

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
      throw new Error(`LLM API error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error('LLM API returned no response body');
    }

    const eventStream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream());

    for await (const event of eventStream) {
      if ('data' in event) {
        if (event.data === '[DONE]') break;
        try {
          const chunk = JSON.parse(event.data) as OpenAIStreamChunk;
          // Yield tanto chunks con choices como el chunk final de usage (choices vacío)
          if (chunk.choices?.[0] || chunk.usage) yield chunk;
        } catch {
          // skip malformed chunks
        }
      }
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
