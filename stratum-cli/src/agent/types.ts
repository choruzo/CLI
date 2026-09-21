import type { ZodTypeAny } from 'zod';
import type { StratumConfig } from '../config/schema.js';
import type { IProvider } from '../providers/base.js';
import type {
  DestructiveDecision,
  Plan,
  QuestionAnswer,
  QuestionItem,
  SubagentResult,
  TokenStatus,
} from './events.js';

// Tipos del evento y de sus datos: viven en `events.ts` (sin dependencias, lo
// importa el webview de Stratum Desktop) y se re-exportan desde aquí.
export type {
  AgentEvent,
  DecisionEntry,
  DestructiveDecision,
  Plan,
  PlanStep,
  PlanStepStatus,
  QuestionAnswer,
  QuestionItem,
  QuestionOption,
  SubagentResult,
  SubagentStatus,
  TodoItem,
  TodoStatus,
  TokenStatus,
} from './events.js';

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
/**
 * Cómo puede usarse un perfil (Hito 15). `subagent` (default): solo se delega
 * (`delegate_task`, `@perfil`, `run --delegate`). `primary`: solo como agente
 * principal (`/agent`, `run --agent`). `all`: ambas.
 */
export type ProfileMode = 'primary' | 'subagent' | 'all';

/** De dónde salió un perfil (Hito 15): para `/agents` y `stratum agents list`. */
export interface ProfileSource {
  scope: 'builtin' | 'global' | 'project';
  /** Fichero del perfil. Ausente en el builtin. */
  path?: string;
}

export interface AgentProfile {
  name: string;
  /** Cuándo usar el perfil (Hito 15). Alimenta el índice `# Agent profiles`. */
  description?: string;
  /** Default `subagent` cuando se omite (ver `profileMode`). */
  mode?: ProfileMode;
  source?: ProfileSource;
  /**
   * El frontmatter declaró `budget` (Hito 15). `budget` siempre llega relleno
   * con defaults, así que sin esto no se puede avisar de que como agente
   * principal el presupuesto del perfil no se aplica.
   */
  budgetDeclared?: boolean;
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

// ---------------------------------------------------------------------------
// Hito 13 — Contabilidad de tokens con estado explícito (P3 de `gentle-pi`)
// ---------------------------------------------------------------------------

export interface TokenAccounting {
  status: TokenStatus;
  /** Solo presente con `status: 'reported'`. Nunca se estima. */
  tokens?: number;
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

export interface ConfirmRequest {
  callId: string;
  toolName: string;
  description: string;
}

export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  config: StratumConfig;
  /** Id de la sesión activa, cuando lo hay. Lo usa el log de auditoría SSH (§12.14). */
  sessionId?: string;
  allowDestructive?: boolean;
  destructivePolicy?: DestructivePolicy;
  confirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
}

export type ToolResult =
  | { ok: true; output: string }
  | {
      ok: false;
      error: string;
      recoverable: boolean;
      /**
       * Hito 16 — `false` si el error no es un fallo de la tool sino un resultado
       * legítimo de lo que ejecutó (un `grep` sin coincidencias sale con 1). No
       * consume reintento (§12.3) ni rompe la racha de fallos. Default `true`.
       */
      countsAsFailure?: boolean;
      /** Hito 16 — la operación llegó a ejecutarse (el write-log la sigue contando). */
      executed?: boolean;
    };

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodTypeAny;
  destructive?: boolean;
  serialized?: boolean;
  timeout?: number;
  rawParameters?: Record<string, unknown>;
  /**
   * Veto inapelable (Hito 11, capa 1 y 3-blocked de las guardas). El dispatcher
   * lo evalúa ANTES de la fase de confirmación: devolver un `ToolResult` de
   * error aborta la call sin preguntar al usuario y sin que `--allow-destructive`
   * ni el allow-all de sesión puedan levantarlo. `null` = la call sigue su curso.
   */
  preflight?(params: unknown, ctx: ToolContext): ToolResult | null;
  isDestructive?(params: unknown, ctx: ToolContext): boolean;
  /**
   * Hito 16 — serialización decidida por llamada (`exec` en local sí, en un
   * host remoto no). Se suma a `serialized`; si lanza, la llamada se serializa.
   */
  isSerialized?(params: unknown, ctx: ToolContext): boolean;
  /**
   * Hito 16 — la tool resuelve por sí misma cuando se cancela (mata su proceso
   * y devuelve un resultado `cancelled`). El dispatcher no compite con el abort
   * y solo impone una red de seguridad de unos segundos.
   */
  structuredCancellation?: boolean;
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolCallReady {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Id de la sesión activa; se propaga al `ToolContext` para la auditoría SSH. */
  sessionId?: string;
  allowDestructive?: boolean;
  destructivePolicy?: DestructivePolicy;
  onConfirmDestructive?: (req: ConfirmRequest) => Promise<DestructiveDecision>;
  compressionMode?: 'normal' | 'conservative';
  mode?: AgentMode;
  onApprovePlan?: (plan: Plan) => Promise<PlanDecision>;
  /**
   * Gate de la tool `question` (Hito 2.5, F7). El loop la intercepta, pausa y
   * espera aquí las respuestas del usuario. `null` = no hay usuario disponible
   * (CI/piped sin TTY) o el usuario omitió la tanda: el loop se lo dice al
   * agente para que continúe con supuestos razonables. Sin callback → `null`.
   */
  onAskQuestions?: (questions: QuestionItem[]) => Promise<QuestionAnswer[] | null>;
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
  /**
   * Tope de tokens acumulados para este run (Hito 8B, best-effort). Solo se aplica
   * si el backend devuelve `usage`; si no, se ignora y el control recae en
   * `maxIterations` + `timeoutMs` (§12.16). Lo usan los subagentes con su
   * `budget.maxTokens`. Al superarse, el loop cierra con `stopReason: 'budget_tokens'`.
   */
  maxTokens?: number;
  /**
   * Persistencia de subagentes (Hito 8B, §12.16). El loop padre la invoca al
   * lanzar un `delegate_task` (sin `result` → marca `running`) y de nuevo al
   * terminar (con `result` → estado terminal). Permite detectar en `resume`
   * subagentes cuya ejecución quedó a medias (`running` → `interrupted`).
   */
  onSubagentPersist?: (rec: SubagentPersist) => void;
}

/** Registro que el loop padre pasa a `onSubagentPersist` (Hito 8B). */
export interface SubagentPersist {
  id: string;
  profile: string;
  task: string;
  /** Ausente al arrancar (marca `running`); presente al terminar (estado terminal). */
  result?: SubagentResult;
}
