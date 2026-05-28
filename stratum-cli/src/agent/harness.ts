import type { StratumConfig } from '../config/schema.js';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { ToolSchema } from '../providers/base.js';
import { StreamBuffer } from '../providers/openai-compatible.js';
import type {
  AgentEvent,
  Message,
  ToolCallReady,
  ToolContext,
  RunOptions,
} from './types.js';
import type { ToolRegistry, DispatchResult } from '../tools/registry.js';
import { ToolDispatcher } from '../tools/registry.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function* streamWithRetry(
  provider: IProvider,
  request: CompletionRequest,
  maxRetries = 3,
): AsyncGenerator<OpenAIStreamChunk> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) await delay(1000 * Math.pow(2, attempt - 1));
    try {
      const gen = provider.complete(request);
      const first = await gen.next();
      if (first.done) return;
      yield first.value;
      yield* gen;
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function formatXmlError(tool: string, error: string): string {
  return `<tool_error>\n  <tool>${tool}</tool>\n  <error>${error}</error>\n</tool_error>`;
}

export class ContextManager {
  constructor(
    private readonly contextWindow: number,
    private readonly keepRounds: number,
  ) {}

  estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (msg.content) chars += msg.content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += tc.function.name.length + tc.function.arguments.length;
        }
      }
    }
    return Math.ceil(chars / 3.5);
  }

  usage(messages: Message[]): { used: number; max: number; pct: number } {
    const used = this.estimateTokens(messages);
    const max = this.contextWindow;
    const pct = Math.round((used / max) * 100);
    return { used, max, pct };
  }

  // Stub — compression implemented in Hito 2
  maybeCompress(_messages: Message[]): void {}
}

export class ReactLoop {
  private readonly dispatcher: ToolDispatcher;
  private readonly contextManager: ContextManager;

  constructor(
    private readonly provider: IProvider,
    private readonly registry: ToolRegistry,
    private readonly messages: Message[],
    private readonly config: StratumConfig,
    private readonly model: string,
    contextWindow: number,
  ) {
    this.dispatcher = new ToolDispatcher(registry);
    this.contextManager = new ContextManager(
      contextWindow,
      config.agent.compressionKeepRounds,
    );
  }

  async *run(opts?: RunOptions): AsyncGenerator<AgentEvent> {
    const signal = opts?.signal ?? new AbortController().signal;
    const tools: ToolSchema[] = this.registry.toToolSchemas();

    for (let iter = 0; iter < this.config.agent.maxIterations; iter++) {
      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }

      this.contextManager.maybeCompress(this.messages);

      const request: CompletionRequest = {
        messages: this.messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        model: this.model,
        signal,
      };

      const buffer = new StreamBuffer();
      let assistantText = '';
      const readyCalls: ToolCallReady[] = [];
      let fatalError: string | null = null;

      try {
        for await (const chunk of streamWithRetry(this.provider, request, 3)) {
          if (signal.aborted) break;
          for (const ev of buffer.feed(chunk)) {
            if (ev.type === 'text_delta') {
              assistantText += ev.delta;
              yield ev;
            } else if (ev.type === 'tool_call_start') {
              yield ev;
            } else if (ev.type === 'tool_call_ready') {
              readyCalls.push(ev);
              yield ev;
            } else if (ev.type === 'tool_error') {
              yield ev;
            } else {
              yield ev;
            }
          }
        }
      } catch (err) {
        fatalError = err instanceof Error ? err.message : String(err);
      }

      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }

      if (fatalError !== null) {
        yield { type: 'error', message: fatalError, fatal: true };
        yield { type: 'done', stopReason: 'error' };
        return;
      }

      // Build assistant message for history
      const assistantMsg: Message = {
        role: 'assistant',
        content: assistantText || null,
      };
      if (readyCalls.length > 0) {
        assistantMsg.tool_calls = readyCalls.map(rc => ({
          id: rc.id,
          type: 'function',
          function: {
            name: rc.name,
            arguments: JSON.stringify(rc.input),
          },
        }));
      }
      this.messages.push(assistantMsg);

      if (readyCalls.length === 0) {
        yield { type: 'done', stopReason: 'stop' };
        return;
      }

      // Dispatch tools
      const ctx: ToolContext = {
        signal,
        cwd: process.cwd(),
        config: this.config,
        allowDestructive: opts?.allowDestructive,
      };

      const results: DispatchResult[] = await this.dispatcher.dispatch(readyCalls, ctx);

      for (const res of results) {
        if (res.result.ok) {
          yield {
            type: 'tool_result',
            id: res.callId,
            name: res.toolName,
            result: res.result.output,
            durationMs: res.durationMs,
          };
          this.messages.push({
            role: 'tool',
            tool_call_id: res.callId,
            name: res.toolName,
            content: res.result.output,
          });
        } else {
          yield {
            type: 'tool_error',
            id: res.callId,
            name: res.toolName,
            error: res.result.error,
            recoverable: res.result.recoverable,
          };
          this.messages.push({
            role: 'tool',
            tool_call_id: res.callId,
            name: res.toolName,
            content: formatXmlError(res.toolName, res.result.error),
          });
        }
      }
    }

    yield { type: 'done', stopReason: 'max_iterations' };
  }

  getContextUsage(): { used: number; max: number; pct: number } {
    return this.contextManager.usage(this.messages);
  }
}
