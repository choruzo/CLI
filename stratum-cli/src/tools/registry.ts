import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolCallReady,
  DestructiveDecision,
} from '../agent/types.js';
import type { ToolSchema } from '../providers/base.js';
import { truncateToolOutput } from './truncate.js';

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private disabledTools = new Set<string>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Elimina la tool del schema enviado al LLM para el resto de la sesión (spec 12.3). */
  disableForSession(name: string): void {
    this.disabledTools.add(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toToolSchemas(): ToolSchema[] {
    return this.list()
      .filter((tool) => !this.disabledTools.has(tool.name))
      .map((tool) => {
        // Tools MCP traen su propio JSON Schema — usarlo directamente para
        // evitar una conversión lossy (JSON Schema → Zod → JSON Schema).
        const parameters: Record<string, unknown> = tool.rawParameters
          ? tool.rawParameters
          : (() => {
              const full = zodToJsonSchema(tool.schema, {
                $refStrategy: 'none',
                target: 'jsonSchema7',
              }) as Record<string, unknown>;
              const { $schema: _unused, ...rest } = full;
              return rest;
            })();
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters,
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
  /** El usuario respondió `!` (allow-all): no volver a preguntar en esta sesión. */
  private allowAllDestructive = false;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly maxToolRetries: number = 3,
  ) {}

  async dispatch(calls: ToolCallReady[], ctx: ToolContext): Promise<DispatchResult[]> {
    if (calls.length === 0) return [];

    // -------------------------------------------------------------------
    // Fase de confirmación destructiva (§12.5 / UI §12).
    // Se resuelve secuencialmente ANTES de ejecutar nada (§12.9: nunca dos
    // prompts a la vez), así las aprobadas pueden correr en paralelo después.
    // -------------------------------------------------------------------
    const denied = new Map<string, ToolResult>();
    for (const call of calls) {
      const verdict = await this.confirmIfDestructive(call, ctx);
      if (verdict !== null) denied.set(call.id, verdict);
    }

    const approved = calls.filter((c) => !denied.has(c.id));

    const deniedResults: DispatchResult[] = calls
      .filter((c) => denied.has(c.id))
      .map((c) => ({
        callId: c.id,
        toolName: c.name,
        result: denied.get(c.id)!,
        durationMs: 0,
      }));

    const executed = await this.dispatchApproved(approved, ctx);

    // Mantener el orden original de las calls
    const byId = new Map<string, DispatchResult>();
    for (const r of [...deniedResults, ...executed]) byId.set(r.callId, r);
    return calls.map((c) => byId.get(c.id)!);
  }

  /**
   * Devuelve `null` si la call puede ejecutarse, o un ToolResult de error si
   * fue bloqueada (denegada por el usuario o por política).
   */
  private async confirmIfDestructive(
    call: ToolCallReady,
    ctx: ToolContext,
  ): Promise<ToolResult | null> {
    const tool = this.registry.get(call.name);
    if (!tool) return null; // dispatchOne reportará "not found"

    if (!ctx.config.tools.confirmDestructive) return null;

    const isDestructive =
      tool.destructive === true || (tool.isDestructive?.(call.input, ctx) ?? false);
    if (!isDestructive) return null;

    const policy = ctx.destructivePolicy ?? (ctx.allowDestructive === true ? 'allow' : 'ask');

    if (policy === 'allow' || this.allowAllDestructive) return null;

    const description = describeCall(call);

    if (policy === 'deny' || !ctx.confirmDestructive) {
      // --deny-destructive explícito, o modo piped/CI sin TTY (§12.5)
      return {
        ok: false,
        error:
          `Destructive operation blocked: ${description}. ` +
          'Destructive operations are not allowed in this session. Consider a non-destructive alternative.',
        recoverable: true,
      };
    }

    let decision: DestructiveDecision;
    try {
      decision = await ctx.confirmDestructive({
        callId: call.id,
        toolName: call.name,
        description,
      });
    } catch {
      decision = 'deny';
    }

    if (decision === 'allow-all') {
      this.allowAllDestructive = true;
      return null;
    }
    if (decision === 'approve') return null;

    return {
      ok: false,
      error: `User denied execution of: ${description}. Ask the user how to proceed or try a non-destructive alternative.`,
      recoverable: true,
    };
  }

  private async dispatchApproved(
    calls: ToolCallReady[],
    ctx: ToolContext,
  ): Promise<DispatchResult[]> {
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

    const failCount = this.toolFailureCounts.get(call.name) ?? 0;
    if (failCount >= this.maxToolRetries) {
      this.registry.disableForSession(call.name);
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: `Tool "${call.name}" has been disabled for this session after ${failCount} consecutive failures.`,
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

    // Timeout y cancelación: el signal derivado combina la cancelación del
    // usuario (Ctrl+C → ctx.signal) con el timeout de la tool, y se pasa a
    // execute() para que las tools bien portadas aborten su trabajo subyacente
    // (fetch, execa...). El Promise.race actúa de red de seguridad para tools
    // que ignoren el signal.
    const timeoutMs = tool.timeout ?? 30000;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () =>
        timeoutController.abort(new Error(`Tool "${call.name}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const combinedSignal = AbortSignal.any([ctx.signal, timeoutController.signal]);
    const execCtx: ToolContext = { ...ctx, signal: combinedSignal };

    try {
      const result = await Promise.race([
        tool.execute(parsed.data, execCtx),
        new Promise<never>((_, reject) => {
          combinedSignal.addEventListener(
            'abort',
            () => {
              const reason: unknown = combinedSignal.reason;
              reject(
                reason instanceof Error ? reason : new Error(`Tool "${call.name}" was cancelled`),
              );
            },
            { once: true },
          );
        }),
      ]);
      clearTimeout(timeoutId);
      if (!result.ok) this.recordFailure(call.name);
      // F4: truncar cualquier salida de tool antes de que entre al historial,
      // para proteger el contexto del modelo (cabeza 80% + cola 20%).
      const truncated: ToolResult = result.ok
        ? { ok: true, output: truncateToolOutput(result.output) }
        : { ...result, error: truncateToolOutput(result.error) };
      return {
        callId: call.id,
        toolName: call.name,
        result: truncated,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      clearTimeout(timeoutId);
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

/** Descripción legible de una tool call para el prompt de confirmación. */
export function describeCall(call: ToolCallReady): string {
  if (call.name === 'bash' && typeof call.input.command === 'string') {
    return `bash: ${call.input.command}`;
  }
  const compact = JSON.stringify(call.input);
  const summary = compact.length > 120 ? compact.slice(0, 117) + '...' : compact;
  return `${call.name}: ${summary}`;
}
