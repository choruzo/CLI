import type { StratumConfig } from '../config/schema.js';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { ToolSchema } from '../providers/base.js';
import { StreamBuffer } from '../providers/openai-compatible.js';
import type { AgentEvent, Message, ToolCallReady, ToolContext, RunOptions } from './types.js';
import type { ToolRegistry, DispatchResult } from '../tools/registry.js';
import { ToolDispatcher } from '../tools/registry.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fix #5: 4 intentos totales = 3 retries con delays 1s/2s/4s (spec 12.3)
async function* streamWithRetry(
  provider: IProvider,
  request: CompletionRequest,
  maxAttempts = 4,
): AsyncGenerator<OpenAIStreamChunk> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await delay(1000 * Math.pow(2, attempt - 1));
    try {
      const gen = provider.complete(request);
      const first = await gen.next();
      if (first.done) return;
      yield first.value;
      yield* gen;
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// Fix #4: respeta toolErrorFormat de config (spec 12.3)
function formatToolError(
  toolName: string,
  error: string,
  format: 'xml' | 'json' = 'xml',
  suggestion?: string,
): string {
  const hint =
    suggestion ?? 'Review the error above and adjust the tool call parameters accordingly.';
  if (format === 'json') {
    return JSON.stringify({ tool: toolName, error, suggestion: hint });
  }
  return `<tool_error>\n  <tool>${toolName}</tool>\n  <error>${error}</error>\n  <suggestion>${hint}</suggestion>\n</tool_error>`;
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
    // Fix #3: pasa maxToolRetries al dispatcher para aplicarlo en sesión
    this.dispatcher = new ToolDispatcher(registry, config.agent.maxToolRetries);
    this.contextManager = new ContextManager(contextWindow, config.agent.compressionKeepRounds);
  }

  async *run(opts?: RunOptions): AsyncGenerator<AgentEvent> {
    const signal = opts?.signal ?? new AbortController().signal;
    const tools: ToolSchema[] = this.registry.toToolSchemas();
    const fmt = this.config.agent.toolErrorFormat;

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
      // Fix #2: rastrear parse errors del buffer para inject & recover (spec 12.3)
      type ParseError = {
        type: 'tool_error';
        id: string;
        name: string;
        error: string;
        recoverable: boolean;
      };
      const parseErrors: ParseError[] = [];
      const toolArgBuffers = new Map<string, string>(); // id → args raw acumulados
      let fatalError: string | null = null;

      try {
        for await (const chunk of streamWithRetry(this.provider, request)) {
          if (signal.aborted) break;
          for (const ev of buffer.feed(chunk)) {
            if (ev.type === 'text_delta') {
              assistantText += ev.delta;
              yield ev;
            } else if (ev.type === 'tool_call_start') {
              toolArgBuffers.set(ev.id, ev.input_so_far);
              yield ev;
            } else if (ev.type === 'tool_call_ready') {
              toolArgBuffers.delete(ev.id);
              readyCalls.push(ev);
              yield ev;
            } else if (ev.type === 'tool_error') {
              parseErrors.push(ev as ParseError);
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

      // Fix #1: error fatal → done con 'stop' (spec 12.1 solo permite stop/max_iterations/cancelled)
      if (fatalError !== null) {
        yield { type: 'error', message: fatalError, fatal: true };
        yield { type: 'done', stopReason: 'stop' };
        return;
      }

      // Construir mensaje del asistente incluyendo tanto calls válidas como las que fallaron parse
      const assistantMsg: Message = {
        role: 'assistant',
        content: assistantText || null,
      };

      const allToolCalls = [
        ...readyCalls.map((rc) => ({
          id: rc.id,
          type: 'function' as const,
          function: { name: rc.name, arguments: JSON.stringify(rc.input) },
        })),
        ...parseErrors.map((pe) => ({
          id: pe.id,
          type: 'function' as const,
          function: { name: pe.name, arguments: toolArgBuffers.get(pe.id) ?? '' },
        })),
      ];

      if (allToolCalls.length > 0) {
        assistantMsg.tool_calls = allToolCalls;
      }
      this.messages.push(assistantMsg);

      // Parar solo cuando no hay ningún tool call (ni válido ni con parse error)
      if (readyCalls.length === 0 && parseErrors.length === 0) {
        yield { type: 'done', stopReason: 'stop' };
        return;
      }

      // Inyectar parse errors al historial para que el LLM pueda recuperarse
      for (const pe of parseErrors) {
        this.messages.push({
          role: 'tool',
          tool_call_id: pe.id,
          name: pe.name,
          content: formatToolError(
            pe.name,
            pe.error,
            fmt,
            'Ensure the tool call arguments are valid JSON.',
          ),
        });
      }

      // Despachar tool calls con JSON válido
      if (readyCalls.length > 0) {
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
              content: formatToolError(res.toolName, res.result.error, fmt, undefined),
            });
          }
        }
      }
    }

    yield { type: 'done', stopReason: 'max_iterations' };
  }

  getContextUsage(): { used: number; max: number; pct: number } {
    return this.contextManager.usage(this.messages);
  }
}
