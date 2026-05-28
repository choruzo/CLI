import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition, ToolContext, ToolResult, ToolCallReady } from '../agent/types.js';
import type { ToolSchema } from '../providers/base.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toToolSchemas(): ToolSchema[] {
    return this.list().map((tool) => {
      const full = zodToJsonSchema(tool.schema, {
        $refStrategy: 'none',
        target: 'jsonSchema7',
      }) as Record<string, unknown>;
      const { $schema: _unused, ...parameters } = full;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: parameters as Record<string, unknown>,
        },
      } satisfies ToolSchema;
    });
  }
}

export interface DispatchResult {
  callId: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

export class ToolDispatcher {
  private readonly toolFailureCounts = new Map<string, number>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly maxToolRetries: number = 3,
  ) {}

  async dispatch(calls: ToolCallReady[], ctx: ToolContext): Promise<DispatchResult[]> {
    if (calls.length === 0) return [];
    if (calls.length === 1) {
      return [await this.dispatchOne(calls[0]!, ctx)];
    }

    const hasSerializedCall = calls.some((c) => {
      const tool = this.registry.get(c.name);
      return tool?.serialized === true;
    });

    if (hasSerializedCall) {
      const results: DispatchResult[] = [];
      for (const call of calls) {
        results.push(await this.dispatchOne(call, ctx));
      }
      return results;
    }

    const settled = await Promise.allSettled(calls.map((call) => this.dispatchOne(call, ctx)));

    return settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const call = calls[i]!;
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: String((r as PromiseRejectedResult).reason),
          recoverable: true,
        },
        durationMs: 0,
      };
    });
  }

  private recordFailure(name: string): void {
    this.toolFailureCounts.set(name, (this.toolFailureCounts.get(name) ?? 0) + 1);
  }

  private async dispatchOne(call: ToolCallReady, ctx: ToolContext): Promise<DispatchResult> {
    const start = Date.now();
    const tool = this.registry.get(call.name);

    if (!tool) {
      return {
        callId: call.id,
        toolName: call.name,
        result: { ok: false, error: `Tool "${call.name}" not found`, recoverable: false },
        durationMs: Date.now() - start,
      };
    }

    // Fix #3: bloquear tool que superó maxToolRetries fallos en la sesión (spec 12.3)
    const failCount = this.toolFailureCounts.get(call.name) ?? 0;
    if (failCount >= this.maxToolRetries) {
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: `Tool "${call.name}" has failed ${failCount} times this session and is disabled.`,
          recoverable: false,
        },
        durationMs: Date.now() - start,
      };
    }

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      this.recordFailure(call.name);
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: `Invalid parameters: ${parsed.error.message}`,
          recoverable: true,
        },
        durationMs: Date.now() - start,
      };
    }

    const timeoutMs = tool.timeout ?? 30000;
    try {
      const result = await Promise.race([
        tool.execute(parsed.data, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Tool "${call.name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      if (!result.ok) this.recordFailure(call.name);
      return { callId: call.id, toolName: call.name, result, durationMs: Date.now() - start };
    } catch (err) {
      this.recordFailure(call.name);
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
          recoverable: true,
        },
        durationMs: Date.now() - start,
      };
    }
  }
}
