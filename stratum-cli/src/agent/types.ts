import type { ZodTypeAny } from 'zod';
import type { StratumConfig } from '../config/schema.js';
import type { IProvider } from '../providers/base.js';

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
  // Hito 8 - Multi-agent (8A: delegación mínima)
  | { type: 'subagent_started'; subagentId: string; profile: string; task: string }
  | { type: 'subagent_progress'; subagentId: string; note: string }
  | { type: 'subagent_completed'; subagentId: string; result: SubagentResult }
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

// ---------------------------------------------------------------------------
// Hito 8 — Multi-agente (§12.16)
// ---------------------------------------------------------------------------

/** Presupuesto de un subagente. maxIterations/timeoutMs son límites duros; maxTokens best-effort. */
export interface SubagentBudget {
  /** Tope de iteraciones del loop hijo (límite duro, siempre disponible). */
  maxIterations: number;
  /** Best-effort: solo si el backend devuelve usage; si no, se ignora (§12.16). */
  maxTokens?: number;
  /** Pared de tiempo → AbortSignal (límite duro, siempre disponible). */
  timeoutMs?: number;
}

/**
 * Perfil de agente (configuración, no clase). Cargado desde un fichero markdown
 * con frontmatter YAML en ~/.stratum/agents/ o <projectRoot>/.stratum/agents/.
 * El perfil `general` viene embebido por defecto.
 */
export interface AgentProfile {
  name: string;
  /**
   * Tools permitidas al subagente. `null` = hereda todas (salvo delegate_task,
   * filtrado por construcción para forzar profundidad = 1).
   */
  allowedTools: string[] | null;
  /** Provider (alias en .stratumrc.json) para el subagente. undefined = default. */
  provider?: string;
  /** Modelo para el subagente. undefined = el del provider. */
  model?: string;
  /** Política destructiva por defecto del perfil. undefined = hereda la del padre. */
  destructivePolicy?: DestructivePolicy;
  /** Presupuesto por defecto del perfil. */
  budget: SubagentBudget;
  /** Cuerpo del fichero del perfil: se inyecta envolviendo la task (no en system-prompt.ts). */
  systemPromptFragment: string;
}

export interface SubagentTask {
  id: string; // sub_YYYYMMDD_HHMMSS_<rnd>
  task: string;
  profile: string; // nombre de perfil resuelto
  context?: string[]; // rutas de ficheros (no contenidos)
  budget: SubagentBudget;
}

export type SubagentStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded'
  | 'interrupted';

/**
 * Forma mínima del router que el loop hijo necesita (la cumple `ProviderRouter`
 * estructuralmente). Permite inyectar un router de prueba en `runSubagent`.
 */
export interface SubagentRouter {
  getActive(): IProvider;
  readonly model: string;
  readonly providerName: string;
  readonly contextWindow: number;
  readonly hasFallback: boolean;
  advanceProvider(): { name: string; model: string } | null;
  switchModel(model: string): void;
}

export interface SubagentResult {
  id: string;
  status: SubagentStatus;
  /** Resumen en lenguaje natural (lo que el padre realmente consume). */
  summary: string;
  filesChanged: { path: string; action: 'created' | 'modified' | 'deleted' }[];
  /** Ids de decisiones guardadas (§12.7), por trazabilidad. */
  decisions?: string[];
  usage: { iterations: number; tokens?: number; durationMs: number };
  /** Presente si status !== 'completed'. */
  error?: string;
}

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
  /**
   * Override del tope de iteraciones para este run (Hito 8). Lo usan los
   * subagentes para aplicar el `maxIterations` de su presupuesto en vez del
   * global de config. Si se omite, se usa `config.agent.maxIterations`.
   */
  maxIterations?: number;
  /**
   * Factory de router para los subagentes que lance este turno (Hito 8). Cuando
   * se omite, `runSubagent` construye su propio `ProviderRouter` desde la config.
   * Punto de inyección para tests; en producción no se pasa.
   */
  makeSubagentRouter?: (profile: AgentProfile) => SubagentRouter;
}
