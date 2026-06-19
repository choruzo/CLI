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
  // Hito 7 - Plan & Execute
  | { type: 'plan_proposed'; plan: Plan }
  | { type: 'plan_step_update'; stepId: string; status: PlanStepStatus }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; stopReason: 'stop' | 'max_iterations' | 'cancelled' | 'error' };

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped';

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
  status: PlanStepStatus;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export type PlanDecision = { decision: 'approve'; plan: Plan } | { decision: 'reject' };

export type AgentMode = 'normal' | 'plan' | 'execute';

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

export type DestructivePolicy = 'ask' | 'allow' | 'deny';

export type DestructiveDecision = 'approve' | 'deny' | 'allow-all';

export interface ConfirmRequest {
  callId: string;
  toolName: string;
  description: string;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  config: StratumConfig;
  allowDestructive?: boolean;
  destructivePolicy?: DestructivePolicy;
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
  rawParameters?: Record<string, unknown>;
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
  destructivePolicy?: DestructivePolicy;
  onConfirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
  compressionMode?: 'normal' | 'conservative';
  mode?: AgentMode;
  onApprovePlan?: (plan: Plan) => Promise<PlanDecision>;
  plan?: Plan;
  onPlanPersist?: (plan: Plan, done: boolean) => void;
  /** Cuando true, el plan fue inyectado como preámbulo de reanudación; el loop no lo re-inyecta. */
  isResumePlan?: boolean;
}
