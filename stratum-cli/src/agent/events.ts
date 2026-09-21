/**
 * `AgentEvent` y los tipos de datos que viajan dentro de él. Sin imports a
 * propósito: Stratum Desktop importa este fichero desde el webview (vía
 * `desktop/protocol.ts`), que no puede arrastrar tipos de Node, de Zod ni de la
 * config. `agent/types.ts` lo re-exporta todo, así que el resto del core sigue
 * importando de allí.
 */

export type AgentEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string; input_so_far: string }
  | { type: 'tool_call_ready'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: string; durationMs: number }
  | {
      type: 'tool_error';
      id: string;
      name: string;
      error: string;
      recoverable: boolean;
      /** Hito 16 — la tool llegó a ejecutar (un comando que salió ≠ 0, se truncó o se canceló). */
      executed?: boolean;
    }
  | { type: 'memory_retrieved'; decisions: DecisionEntry[] }
  | { type: 'thinking'; text: string }
  | { type: 'warning'; message: string }
  | {
      type: 'context_compressed';
      tokensBefore: number;
      tokensAfter: number;
      roundsCompressed: number;
    }
  // Hito 2.5 (F7) — tanda única de preguntas al usuario (tool `question`)
  | { type: 'questions_asked'; questions: QuestionItem[] }
  | { type: 'questions_answered'; answers: QuestionAnswer[] | null }
  // Hito 11 — lista de tareas del turno (tool `todo`). `stale` son los turnos
  // transcurridos con tareas abiertas y sin que el modelo tocara la lista.
  | { type: 'todo_updated'; items: TodoItem[]; stale: number }
  // Hito 7 - Plan & Execute
  | { type: 'plan_proposed'; plan: Plan }
  | { type: 'plan_step_update'; stepId: string; status: PlanStepStatus }
  // Hito 8 - Multi-agent (8A: delegación mínima)
  | { type: 'subagent_started'; subagentId: string; profile: string; task: string }
  | { type: 'subagent_progress'; subagentId: string; note: string }
  | { type: 'subagent_completed'; subagentId: string; result: SubagentResult }
  // Hito 8C — re-emite cada AgentEvent del loop hijo, etiquetado con su subagentId,
  // para que la UI (árbol vivo <AgentTree>, inspector /subagents) desanide sus tool
  // calls bajo el nodo del subagente. El `event` nunca es a su vez un subagent_event
  // (profundidad = 1: los subagentes no delegan).
  | { type: 'subagent_event'; subagentId: string; event: AgentEvent }
  | { type: 'error'; message: string; fatal: boolean }
  | {
      type: 'done';
      stopReason: 'stop' | 'max_iterations' | 'cancelled' | 'error' | 'budget_tokens';
    };

/** Respuesta del usuario a una confirmación destructiva (§12.5; por el canal de Desktop en 15.4). */
export type DestructiveDecision = 'approve' | 'deny' | 'allow-all';

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

/** Mismo vocabulario de estado que los pasos de plan, para no duplicarlo (Hito 11). */
export type TodoStatus = PlanStepStatus;

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

// ---------------------------------------------------------------------------
// Hito 2.5 (F7) — Tool `question`: tanda única de preguntas al usuario
// ---------------------------------------------------------------------------

/**
 * Opción de respuesta cerrada. El `id` es un **token opaco** (§3 de la
 * investigación `gentle-pi`): quien resuelve el gate devuelve el token, no la
 * etiqueta ni el ordinal, y el loop resuelve la etiqueta desde este mismo
 * envelope. Así una etiqueta parecida, un reordenamiento o un `2` tecleado de
 * más nunca se confunden con una elección.
 */
export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionItem {
  question: string;
  /** Opciones cerradas. Vacío/ausente → respuesta libre. */
  options?: QuestionOption[];
  /**
   * Texto libre admitido junto a las opciones. Opt-in explícito: con opciones y
   * sin este flag el dominio de respuesta son las opciones y nada más.
   */
  allowCustom?: boolean;
}

export interface QuestionAnswer {
  question: string;
  /** Respuesta del usuario, ya canonizada a la etiqueta cuando eligió opción. */
  answer: string;
  /** Token de la opción elegida. Ausente si respondió texto libre o la omitió. */
  optionId?: string;
}

// ---------------------------------------------------------------------------
// Hito 8 — Resultado de un subagente (§12.16)
// ---------------------------------------------------------------------------

export type SubagentStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded'
  | 'interrupted';

export interface SubagentResult {
  id: string;
  status: SubagentStatus;
  /** Resumen en lenguaje natural (lo que el padre realmente consume). */
  summary: string;
  filesChanged: { path: string; action: 'created' | 'modified' | 'deleted' }[];
  /** Ids de decisiones guardadas (§12.7), por trazabilidad. */
  decisions?: string[];
  usage: { iterations: number; tokens?: number; tokenStatus?: TokenStatus; durationMs: number };
  /** Presente si status !== 'completed'. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Hito 13 — Contabilidad de tokens con estado explícito (P3 de `gentle-pi`)
// ---------------------------------------------------------------------------

/**
 * Estado de una medición de tokens. La regla es no inventar nunca un valor que
 * el backend no dio: un número ausente y un número que este backend jamás va a
 * dar son situaciones distintas y se diagnostican distinto.
 *
 *  - `reported`    — el backend devolvió `usage`; `tokens` es un dato real.
 *  - `unavailable` — todavía no hay dato (ninguna request completa aún, o el
 *    stream se cortó antes del chunk final). Puede haberlo más adelante.
 *  - `unsupported` — se pidió `stream_options.include_usage`, hubo al menos una
 *    respuesta completa y nunca llegó `usage`: este backend no lo manda.
 */
export type TokenStatus = 'reported' | 'unavailable' | 'unsupported';

export interface DecisionEntry {
  id: string;
  title: string;
  content: string;
  type: string;
  tags: string[];
  importance: string;
  timestamp: string;
}
