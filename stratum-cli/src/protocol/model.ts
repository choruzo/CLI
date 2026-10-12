import type { ClientKind } from './roles.js';

/**
 * DTOs del protocolo. Son un contrato propio: **no** son las clases ni los
 * tipos internos del runtime (`SessionHost`, `StratumAgent`, `StratumConfig`,
 * `ToolContext`, `DecisionRecord`…), y no se generan a partir de ellos. Quien
 * sirve el protocolo los construye campo a campo, de modo que el interior puede
 * cambiar sin romper a los clientes y al revés.
 *
 * Todo lo que hay aquí es serializable y sale del anfitrión **ya redactado**.
 * Ningún DTO lleva variables de entorno, config ni secretos.
 */

/** Tiempo en epoch ms. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Agentes y modelos
// ---------------------------------------------------------------------------

/** Un perfil de agente: la definición, no una sesión viva. */
export interface ProtocolAgent {
  name: string;
  description: string;
  mode: 'subagent' | 'primary' | 'all';
  origin: 'builtin' | 'global' | 'project';
  /** `null` = todas las tools. */
  allowedTools: string[] | null;
  provider?: string;
  model?: string;
}

export interface ProtocolModel {
  provider: string;
  id: string;
  /** `null` si el backend no la declara. */
  contextWindow: number | null;
}

// ---------------------------------------------------------------------------
// Sesiones y runs
// ---------------------------------------------------------------------------

export type ProtocolSessionState =
  /** Viva, sin turno en curso. */
  | 'idle'
  | 'running'
  /** Espera una aprobación, una respuesta o la decisión de un plan. */
  | 'waiting'
  | 'paused'
  /** Su anfitrión perdió la conexión: puede seguir viva, pero no se ve ni se gobierna. */
  | 'detached'
  /** Guardada, no viva. */
  | 'closed';

/** Dónde corre la sesión. */
export interface ProtocolSessionHostInfo {
  /** `daemon`: alojada en el servidor. `peer`: en el proceso de un cliente. */
  kind: 'daemon' | 'peer';
  client: ClientKind;
  connected: boolean;
}

export interface ProtocolContextUsage {
  used: number;
  max: number;
  pct: number;
  /** `true` si no hay `usage` real del backend y es una estimación. */
  estimated: boolean;
}

export interface ProtocolTokenUsage {
  /** `null` si el backend no lo reporta. Nunca se estima. */
  total: number | null;
  status: 'reported' | 'unavailable' | 'unsupported';
}

export interface ProtocolEnvironmentRef {
  name: string;
  tier: 'production' | 'staging' | 'development';
}

/**
 * Una conversación: persistente, y viva o no. Su id es también el de su traza.
 * No incluye el entorno con el que se abrió: `sessions.open.env` es de solo
 * entrada y no se devuelve por ningún camino.
 */
export interface ProtocolSession {
  id: string;
  /** Primera entrada del usuario, recortada y redactada. */
  title: string;
  cwd: string;
  host: ProtocolSessionHostInfo;
  state: ProtocolSessionState;
  /** Perfil principal activo, o `general`. */
  agent: string;
  provider: string;
  model: string;
  sessionProfile: string;
  readOnly: boolean;
  /** Último target donde algo se ejecutó: `local`, `ssh:<alias>`. */
  activeTarget: string;
  environment?: ProtocolEnvironmentRef;
  context: ProtocolContextUsage;
  tokens: ProtocolTokenUsage;
  currentRunId: string | null;
  /** `seq` del último evento de estado de la sesión; `0` si aún no hay ninguno. */
  seq: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type ProtocolRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** El proceso que lo alojaba murió con el run en marcha. */
  | 'interrupted';

export type ProtocolStopReason =
  | 'stop'
  | 'max_iterations'
  | 'cancelled'
  | 'error'
  | 'budget_tokens';

export interface ProtocolRunCounters {
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  /** Llamadas que el runtime no dejó ejecutar (veto, read-only, entorno, plan). */
  blocked: number;
  memoryReads: number;
  memoryWrites: number;
  subagents: number;
  jobs: number;
}

/** Un turno: de una entrada del usuario a su final. */
export interface ProtocolRun {
  id: string;
  sessionId: string;
  kind: 'run' | 'delegate';
  /** Entrada del turno, recortada y redactada. */
  input: string;
  mode: 'normal' | 'plan' | 'execute';
  status: ProtocolRunStatus;
  stopReason?: ProtocolStopReason;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  counters: ProtocolRunCounters;
  /** Presente si `status` es `failed`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Lo que ocurre dentro de un run
// ---------------------------------------------------------------------------

export interface ProtocolToolCall {
  id: string;
  runId: string;
  subagentId?: string;
  name: string;
  target?: string;
  state: 'pending' | 'running' | 'completed' | 'error' | 'blocked';
  /** Descripción legible de la llamada, ya redactada. */
  description: string;
  /** Salida o error, redactados y recortados. */
  output?: string;
  error?: string;
  startedAt: Timestamp;
  durationMs?: number;
}

export interface ProtocolSubagent {
  id: string;
  runId: string;
  profile: string;
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'interrupted';
  summary?: string;
  filesChanged?: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>;
  iterations?: number;
  durationMs?: number;
  error?: string;
}

/** Una decisión de la memoria, como la ve un cliente. */
export interface ProtocolDecision {
  id: string;
  title: string;
  type: string;
  tags: string[];
  importance: string;
  timestamp: string;
}

export interface ProtocolMemoryEvent {
  kind: 'read' | 'write' | 'forget';
  source: 'tool' | 'auto-extract' | 'user';
  decisions: Array<{ id: string; title: string }>;
  runId?: string;
  at: Timestamp;
}

export interface ProtocolJob {
  id: string;
  sessionId: string;
  /** Comando, redactado. */
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  exitCode?: number | null;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  /** `main` o el id del subagente dueño. */
  scope: string;
}

export interface ProtocolPlanStep {
  id: string;
  title: string;
  detail?: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

export interface ProtocolPlan {
  summary: string;
  steps: ProtocolPlanStep[];
}

export interface ProtocolTodo {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
}

// ---------------------------------------------------------------------------
// Decisiones humanas pendientes
// ---------------------------------------------------------------------------

/** Quién resolvió algo. Sin datos del proceso: solo lo que un cliente declaró ser. */
export interface ProtocolResolver {
  client: ClientKind;
  connectionId: number;
}

export type ProtocolApprovalDecision = 'approve' | 'deny' | 'allow-all';

/** Solicitud de aprobación de una operación (destructiva, de entorno o una host key). */
export interface ProtocolApproval {
  id: string;
  kind: 'tool' | 'host-key';
  sessionId: string;
  runId: string;
  subagentId?: string;
  tool: string;
  /** Qué se va a ejecutar, ya redactado. Los parámetros crudos no viajan. */
  description: string;
  reason?: string;
  target?: string;
  environment?: ProtocolEnvironmentRef;
  /** La exige una política de entorno: no admite `allow-all`. */
  forced: boolean;
  /**
   * Confirmación con nombre: para aprobar hay que teclear exactamente este
   * texto (el alias del target). Un cliente que no sepa pedirlo debe denegar.
   */
  confirmPhrase?: string;
  /** Dónde se puede resolver: `origin` = solo en el cliente que aloja la sesión. */
  resolvable: 'anywhere' | 'origin';
  requestedAt: Timestamp;
  /** `null` = no caduca. */
  expiresAt: Timestamp | null;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  decision?: ProtocolApprovalDecision;
  resolvedBy?: ProtocolResolver;
}

export interface ProtocolQuestionOption {
  /** Token opaco: la respuesta devuelve este id, no la etiqueta. */
  id: string;
  label: string;
}

export interface ProtocolQuestion {
  question: string;
  options?: ProtocolQuestionOption[];
  allowCustom?: boolean;
}

export interface ProtocolQuestionAnswer {
  question: string;
  answer: string;
  optionId?: string;
}

/** Tanda de preguntas del agente al usuario. */
export interface ProtocolQuestionRequest {
  id: string;
  sessionId: string;
  runId: string;
  questions: ProtocolQuestion[];
  requestedAt: Timestamp;
  expiresAt: Timestamp | null;
}

/** Plan propuesto, a la espera de decisión. */
export interface ProtocolPlanRequest {
  id: string;
  sessionId: string;
  runId: string;
  plan: ProtocolPlan;
  requestedAt: Timestamp;
  expiresAt: Timestamp | null;
}

// ---------------------------------------------------------------------------
// Estado del servidor y de la memoria
// ---------------------------------------------------------------------------

export interface ProtocolServerInfo {
  /** Versión de Stratum que sirve el protocolo. */
  version: string;
  platform: string;
}

export interface ProtocolServerStatus {
  server: ProtocolServerInfo;
  protocol: number;
  startedAt: Timestamp;
  clients: number;
  liveSessions: number;
  activeRuns: number;
  pendingApprovals: number;
}

export interface ProtocolMemoryStatus {
  decisions: number;
  /** Índice semántico disponible. */
  indexed: boolean;
  backend: 'sqlite-vec' | 'fallback' | 'none';
}
