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

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  config: StratumConfig;
  allowDestructive?: boolean;
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
}
