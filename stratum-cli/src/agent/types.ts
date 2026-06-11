import type { ZodTypeAny } from 'zod';
import type { StratumConfig } from '../config/schema.js';

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string; input_so_far: string }
  | { type: 'tool_call_ready'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: string; durationMs: number }
  | { type: 'tool_error'; id: string; name: string; error: string; recoverable: boolean }
  | { type: 'memory_retrieved'; decisions: DecisionEntry[] }
  | { type: 'thinking'; text: string }
  | { type: 'warning'; message: string }
  | {
      type: 'context_compressed';
      tokensBefore: number;
      tokensAfter: number;
      roundsCompressed: number;
    }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; stopReason: 'stop' | 'max_iterations' | 'cancelled' | 'error' };

export interface DecisionEntry {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  importance: string;
  timestamp: string;
}

export interface AssistantToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AssistantToolCall[];
  tool_call_id?: string;
  name?: string;
}

/**
 * Política de ejecución de tools destructivas (§12.5).
 * - 'ask'   → pausar y pedir confirmación via `confirmDestructive` (default)
 * - 'allow' → aprobar todas sin preguntar (--allow-destructive)
 * - 'deny'  → bloquear todas e inyectarlas como tool_error recuperable (--deny-destructive / CI)
 */
export type DestructivePolicy = 'ask' | 'allow' | 'deny';

/** Decisión del usuario ante una confirmación destructiva (§12 de la UI spec). */
export type DestructiveDecision = 'approve' | 'deny' | 'allow-all';

export interface ConfirmRequest {
  callId: string;
  toolName: string;
  /** Descripción legible de la operación (p. ej. el comando bash completo). */
  description: string;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  config: StratumConfig;
  allowDestructive?: boolean;
  /** Política efectiva para tools destructivas. Default: 'ask'. */
  destructivePolicy?: DestructivePolicy;
  /**
   * Callback de confirmación interactiva. Si la política es 'ask' y no hay
   * callback (modo piped/CI), el dispatcher se comporta como 'deny' (§12.5).
   */
  confirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string; recoverable: boolean };

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodTypeAny;
  destructive?: boolean;
  serialized?: boolean;
  timeout?: number;
  /**
   * Predicado dinámico: marca una llamada concreta como destructiva según sus
   * parámetros (p. ej. bash con `rm -rf`). Complementa al flag estático
   * `destructive`. Se evalúa con los parámetros ya validados por el schema.
   */
  isDestructive?(params: unknown, ctx: ToolContext): boolean;
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCallReady {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RunOptions {
  signal?: AbortSignal;
  allowDestructive?: boolean;
  /** Política para tools destructivas. Si se omite, se deriva de `allowDestructive`. */
  destructivePolicy?: DestructivePolicy;
  /** Callback de confirmación interactiva para la política 'ask'. */
  onConfirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
  /**
   * Modo de compresión de contexto (F6).
   * 'conservative' sube el umbral de compresión y conserva más rondas —
   * pensado para `/init`, donde el valor está en el contexto acumulado
   * durante la exploración y comprimirlo lo destruye.
   */
  compressionMode?: 'normal' | 'conservative';
}
