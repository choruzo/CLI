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

/**
 * Una skill disponible para un agente (`skills.list`): la definición que ve el
 * índice del prompt, sin ruta ni cuerpo — un cliente no lee ficheros.
 */
export interface ProtocolSkill {
  name: string;
  description: string;
  scope: 'builtin' | 'user' | 'project';
  presets: ('coding' | 'assistant')[];
}

export interface ProtocolModel {
  provider: string;
  id: string;
  /** `null` si el backend no la declara. */
  contextWindow: number | null;
  /** El que usa una sesión abierta sin pedir provider ni modelo (config global). */
  default?: boolean;
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
  /**
   * Desde qué cliente se inició la sesión (`core.hello` de quien la abrió o la
   * aloja como par). **Solo procedencia**: no decide quién la ve, la conduce ni
   * aprueba nada, y no cambia al traspasarla (M12). Ausente en sesiones de un
   * anfitrión anterior a M12.
   */
  origin?: ClientKind;
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
  /** `input` es solo el principio: la entrada era más larga. */
  inputTruncated?: boolean;
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
// La conversación
// ---------------------------------------------------------------------------

interface MessageBase {
  /** Estable: sale del `seq` del evento que lo creó. */
  id: string;
  /** Run al que pertenece; vacío si su evento no lo traía. */
  runId: string;
  at: Timestamp;
}

/**
 * Una entrada de la conversación de una sesión, tal como la ve una persona:
 * lo que escribió, lo que contestó el asistente, qué tools usó y cómo acabó un
 * turno que no terminó bien. **No es el historial del agente** (ese se comprime
 * y lleva resultados de tools) **ni la traza**: es una vista acotada, redactada
 * por el anfitrión, que se rehace igual desde los eventos (`applyTranscriptEvent`).
 *
 * Lo que no lleva, a sabiendas: el razonamiento, lo que dicen los subagentes,
 * la salida de las tools y el texto de un mensaje de *steering* (el protocolo
 * no lo transporta). De una tool viaja la misma `description` que en
 * `ProtocolToolCall` —el resumen de la llamada que da el anfitrión, ya
 * redactado—, más corta: no sus parámetros completos.
 */
export type ProtocolChatMessage =
  /** Entrada de un turno. `truncated`: el texto es solo el principio. */
  | (MessageBase & { kind: 'user'; text: string; truncated?: boolean })
  /** Un bloque de texto cerrado del asistente. */
  | (MessageBase & { kind: 'assistant'; text: string; truncated?: boolean })
  /** Una llamada a una tool del agente principal. Sin su salida. */
  | (MessageBase & {
      kind: 'tool';
      callId: string;
      name: string;
      /** Descripción legible, ya redactada y recortada. */
      description: string;
      target?: string;
      state: ProtocolToolCall['state'];
    })
  /** Un turno que no terminó bien. `text`: el error, si lo hay. */
  | (MessageBase & { kind: 'outcome'; status: 'failed' | 'cancelled'; text: string });

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

/**
 * Quién resolvió algo. Sin datos del proceso ni credenciales: la vía por la que
 * llegó la decisión y, si fue un cliente remoto, lo que **declaró** ser.
 *
 *  - `local`: la persona delante del proceso que aloja la sesión (su terminal).
 *  - `remote`: un cliente con la capacidad `approve`, a través del servidor.
 *  - `timeout`: nadie contestó a tiempo. Equivale a denegar / omitir / rechazar.
 *  - `policy`: no había a quién preguntar, y se resolvió sin preguntar.
 */
export interface ProtocolResolver {
  kind: 'local' | 'remote' | 'timeout' | 'policy';
  /** Solo con `remote`. No es una identidad verificada. */
  client?: ClientKind;
  /** Solo con `remote`: la conexión del servidor que la resolvió. */
  connectionId?: number;
  at: Timestamp;
}

/** Cómo terminó una pregunta o un plan pendientes. */
export type ProtocolInteractionStatus = 'resolved' | 'expired' | 'cancelled';

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

// ---------------------------------------------------------------------------
// M13 — la caja
// ---------------------------------------------------------------------------

/**
 * `unavailable`: no hay runtime de contenedores (o no responde, o hay un
 * contenedor con su nombre que no creó Stratum); `absent`: nunca se creó o se
 * borró con `box.reset`.
 */
export type ProtocolBoxState = 'unavailable' | 'absent' | 'stopped' | 'running';

export interface ProtocolBoxStatus {
  name: string;
  state: ProtocolBoxState;
  runtime: 'podman' | 'docker' | null;
  /** Con `unavailable`: por qué, para personas. */
  reason?: string;
  image: string;
  /** Salida a la red. */
  network: boolean;
  /** Existe con otra imagen o ajustes: `box.start` la recrea sin borrar su home. */
  outdated: boolean;
  /** `exec` admite `container:<name>` en las sesiones. */
  enabled: boolean;
  /** Carpeta del anfitrión que la caja ve en `/exchange`. */
  exchangeDir: string;
}

// ---------------------------------------------------------------------------
// M11 — conversación duradera, contexto activo y memoria de sesión
// ---------------------------------------------------------------------------

/** Límites de `sessions.history`: una página cabe siempre en un mensaje. */
export const HISTORY_LIMITS = {
  /** Mensajes de una página. */
  pageMessages: 100,
  /** Bytes de una página serializada: lo antiguo de la página se deja para la siguiente. */
  pageBytes: 768 * 1024,
} as const;

/**
 * Una página de la conversación **guardada** de una sesión: los mismos
 * `ProtocolChatMessage` (mismos ids) que la foto, también los que la foto ya no
 * lleva. En orden cronológico; `hasMore` dice si hay anteriores.
 */
export interface ProtocolHistoryPage {
  messages: ProtocolChatMessage[];
  hasMore: boolean;
  /** Mensajes guardados en total. */
  total: number;
}

/** Topes del contexto activo por capa, en tokens. */
export interface ProtocolContextBudgets {
  recent: number;
  sessionMemory: number;
  projectMemory: number;
  globalMemory: number;
  /** Fracción del presupuesto de entrada a partir de la que se compacta. */
  compactAt: number;
  /** Fracción que se busca tras compactar. */
  target: number;
}

/**
 * Lo que recibiría el modelo ahora, por capas, en tokens **estimados**
 * (`estimated: true`): no es un `usage` del backend.
 */
export interface ProtocolContextBreakdown {
  window: number;
  reserveOutput: number;
  usableInput: number;
  input: number;
  system: number;
  tools: number;
  globalMemory: number;
  projectMemory: number;
  sessionMemory: number;
  recent: number;
  activeMessages: number;
  estimated: boolean;
  budgets: ProtocolContextBudgets;
}

export interface ProtocolConversationStats {
  /** Mensajes de la conversación para personas guardados (los de `sessions.history`). */
  storedMessages: number;
  /** Mensajes del historial del agente guardados. */
  storedAgentMessages: number;
  /** Mensajes de la conversación en el contexto activo. */
  activeMessages: number;
  compactions: number;
  lastCompactionAt: Timestamp | null;
  /** Por qué se aplazó la última compactación, si se aplazó. */
  lastCompactionError: string | null;
  compacting: boolean;
}

export type ProtocolMemoryItemKind =
  | 'fact'
  | 'decision'
  | 'constraint'
  | 'preference'
  | 'task'
  | 'result'
  | 'entity';

export interface ProtocolSessionMemoryStats {
  /** ¿Compacta esta sesión a su memoria de sesión? */
  enabled: boolean;
  version: number;
  updatedAt: Timestamp | null;
  hasSummary: boolean;
  /** Entradas vigentes por clase. */
  items: Record<ProtocolMemoryItemKind, number>;
}

/** `sessions.context`: observabilidad del contexto de una sesión. */
export interface ProtocolContextReport {
  sessionId: string;
  /** `null` si la sesión está recuperada pero aún sin montar (sin su primer turno). */
  context: ProtocolContextBreakdown | null;
  conversation: ProtocolConversationStats | null;
  memory: ProtocolSessionMemoryStats | null;
}

/** Una entrada de la memoria de sesión, con su procedencia. */
export interface ProtocolMemoryItem {
  id: string;
  kind: ProtocolMemoryItemKind;
  key: string;
  text: string;
  status: 'active' | 'superseded' | 'done' | 'conflict';
  /** Ids de las entradas del historial del agente de las que sale (hasta 50). */
  sources: string[];
  supersedes?: string;
  supersededBy?: string;
  updatedAt: Timestamp;
}

/**
 * `sessions.memory`: la memoria de **esa** sesión. Es contexto derivado de la
 * conversación: puede contener lo que contenía la conversación.
 */
export interface ProtocolSessionMemory {
  version: number;
  updatedAt: Timestamp | null;
  summary: {
    text: string;
    sourceCount: number;
    firstSource: string | null;
    lastSource: string | null;
  } | null;
  items: ProtocolMemoryItem[];
  sourceCursor: string | null;
}
