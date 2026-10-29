import type {
  ProtocolApproval,
  ProtocolApprovalDecision,
  ProtocolInteractionStatus,
  ProtocolJob,
  ProtocolMemoryEvent,
  ProtocolChatMessage,
  ProtocolPlan,
  ProtocolPlanRequest,
  ProtocolPlanStep,
  ProtocolQuestionAnswer,
  ProtocolQuestionRequest,
  ProtocolResolver,
  ProtocolRun,
  ProtocolSession,
  ProtocolSubagent,
  ProtocolTodo,
  ProtocolToolCall,
  Timestamp,
} from './model.js';

/**
 * Eventos de una sesión. Hay dos clases, y la diferencia es de contrato:
 *
 * **De estado** (`ProtocolStateEvent`). Cuentan algo que ocurrió. Cada uno lleva
 * un `seq` **monótono y sin huecos por sesión** — nunca hay un contador global:
 * la sesión A va 1, 2, 3 y la B va 1, 2, 3. Lo asigna el anfitrión de la sesión.
 * Son los que se pueden reenviar tras una reconexión (`sinceSeq`) y por los que
 * un cliente detecta que se ha perdido algo.
 *
 * **Volátiles** (`ProtocolVolatileEvent`): el texto del modelo según se genera.
 * No tienen `seq`: llevan `after`, el `seq` del último evento de estado previo.
 * El emisor puede **agruparlos** (varios fragmentos en un `text`), el transporte
 * puede **descartarlos** si un cliente va lento, y **no se reenvían** tras una
 * reconexión. Nadie está obligado a guardar cada fragmento: lo perdido se
 * recupera con un snapshot (`partial`) o con el `message.completed` que cierra
 * cada bloque de texto, que sí es de estado y trae el texto entero.
 */

export interface StateEventData {
  'session.opened': { session: ProtocolSession };
  /** Cambió algo del resumen: estado, modelo, perfil, read-only, contexto, tokens. */
  'session.updated': { session: ProtocolSession };
  'session.closed': { reason: 'closed' | 'host-exit' | 'server-shutdown' };
  // Que el anfitrión se fue no es un evento: el daemon no numera, y lo cuenta
  // con una foto (`state: 'detached'`, `host.connected: false`). §14.3.

  'run.started': { run: ProtocolRun };
  /** Cambio de estado dentro del run (`running` ↔ `waiting_approval` ↔ `paused`…). */
  'run.updated': { run: ProtocolRun };
  'run.completed': { run: ProtocolRun };
  'run.failed': { run: ProtocolRun };
  'run.cancelled': { run: ProtocolRun };

  /** Cierra un bloque de texto del asistente: el texto completo, haya o no llegado por fragmentos. */
  'message.completed': { text: string };

  'tool.started': { call: ProtocolToolCall };
  'tool.completed': { call: ProtocolToolCall };
  'tool.failed': { call: ProtocolToolCall; recoverable: boolean };
  /** El runtime no dejó ejecutar la llamada. */
  'tool.blocked': {
    call: ProtocolToolCall;
    source: 'preflight' | 'read-only' | 'environment' | 'toolset' | 'plan' | 'steering' | 'plugin';
  };

  'subagent.started': { subagent: ProtocolSubagent };
  'subagent.completed': { subagent: ProtocolSubagent };

  'memory.read': { memory: ProtocolMemoryEvent };
  'memory.write': { memory: ProtocolMemoryEvent };

  'context.compressed': { tokensBefore: number; tokensAfter: number; roundsCompressed: number };
  'todo.updated': { items: ProtocolTodo[]; stale: number };
  'plan.proposed': { request: ProtocolPlanRequest };
  'plan.resolved': {
    requestId: string;
    decision: 'approve' | 'reject';
    plan?: ProtocolPlan;
    /** Ausente = `resolved`. `expired` y `cancelled` llevan `decision: 'reject'`. */
    status?: ProtocolInteractionStatus;
    resolvedBy?: ProtocolResolver;
  };
  'plan.step_updated': { stepId: string; status: ProtocolPlanStep['status'] };

  'job.started': { job: ProtocolJob };
  'job.ended': { job: ProtocolJob };

  /** Un mensaje del usuario quedó en cola con el turno en curso. Sin su texto. */
  'steering.queued': { id: string; chars: number };
  /** Un punto seguro del loop entregó al modelo lo que había en cola. */
  'steering.delivered': { ids: string[]; jobs: number };

  'approval.requested': { approval: ProtocolApproval };
  'approval.resolved': {
    approvalId: string;
    status: 'approved' | 'denied' | 'expired' | 'cancelled';
    decision?: ProtocolApprovalDecision;
    resolvedBy?: ProtocolResolver;
  };
  'question.requested': { request: ProtocolQuestionRequest };
  'question.resolved': {
    requestId: string;
    /** `null` = se omitió: el agente sigue con supuestos. */
    answers: ProtocolQuestionAnswer[] | null;
    /** Ausente = `resolved`. `expired` y `cancelled` llevan `answers: null`. */
    status?: ProtocolInteractionStatus;
    resolvedBy?: ProtocolResolver;
  };

  warning: { message: string };
  error: { message: string; fatal: boolean };
}

export type StateEventType = keyof StateEventData;

export interface VolatileEventData {
  /** Fragmento (o varios agrupados) del texto del asistente. */
  'message.delta': { text: string };
  /** Fragmento del razonamiento del modelo. Nunca entra en el historial. */
  'reasoning.delta': { text: string };
}

export type VolatileEventType = keyof VolatileEventData;

export type ProtocolEventType = StateEventType | VolatileEventType;

/** Tabla en tiempo de ejecución de la clase de cada evento. */
export const EVENT_CLASS: Readonly<Record<ProtocolEventType, 'state' | 'volatile'>> = {
  'session.opened': 'state',
  'session.updated': 'state',
  'session.closed': 'state',
  'run.started': 'state',
  'run.updated': 'state',
  'run.completed': 'state',
  'run.failed': 'state',
  'run.cancelled': 'state',
  'message.completed': 'state',
  'tool.started': 'state',
  'tool.completed': 'state',
  'tool.failed': 'state',
  'tool.blocked': 'state',
  'subagent.started': 'state',
  'subagent.completed': 'state',
  'memory.read': 'state',
  'memory.write': 'state',
  'context.compressed': 'state',
  'todo.updated': 'state',
  'plan.proposed': 'state',
  'plan.resolved': 'state',
  'plan.step_updated': 'state',
  'job.started': 'state',
  'job.ended': 'state',
  'steering.queued': 'state',
  'steering.delivered': 'state',
  'approval.requested': 'state',
  'approval.resolved': 'state',
  'question.requested': 'state',
  'question.resolved': 'state',
  warning: 'state',
  error: 'state',
  'message.delta': 'volatile',
  'reasoning.delta': 'volatile',
};

/**
 * Eventos que también recibe una suscripción de resumen (`overview`): lo justo
 * para pintar qué sesiones hay, en qué están y qué esperan de alguien.
 */
export const OVERVIEW_EVENT_TYPES: readonly StateEventType[] = [
  'session.opened',
  'session.updated',
  'session.closed',
  'run.started',
  'run.updated',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'approval.requested',
  'approval.resolved',
  'question.requested',
  'question.resolved',
  'plan.proposed',
  'plan.resolved',
];

interface EventBase {
  sessionId: string;
  /** Epoch ms en el reloj del anfitrión. */
  at: Timestamp;
  runId?: string;
  /** El evento es de un subagente de ese run. */
  subagentId?: string;
}

export type ProtocolStateEvent = {
  [T in StateEventType]: EventBase & {
    type: T;
    /** Monótono y sin huecos **dentro de su sesión**. Empieza en 1. */
    seq: number;
    data: StateEventData[T];
  };
}[StateEventType];

export type ProtocolVolatileEvent = {
  [T in VolatileEventType]: EventBase & {
    type: T;
    /** `seq` del último evento de estado de la sesión anterior a este. No es un `seq` propio. */
    after: number;
    data: VolatileEventData[T];
  };
}[VolatileEventType];

export type ProtocolEvent = ProtocolStateEvent | ProtocolVolatileEvent;

export function isStateEvent(event: ProtocolEvent): event is ProtocolStateEvent {
  return EVENT_CLASS[event.type] === 'state';
}

/**
 * Foto del estado vivo de una sesión. Es lo que **sustituye** a los eventos
 * que un cliente no vio: quien la recibe reemplaza lo que tenía, no lo fusiona,
 * y sigue desde `seq`.
 */
export interface ProtocolSessionSnapshot {
  session: ProtocolSession;
  /** `seq` del último evento de estado incluido en la foto. */
  seq: number;
  /** Run en curso, o el último si la sesión está parada. */
  run: ProtocolRun | null;
  /** Lo que el modelo lleva generado en el bloque abierto, que ningún `message.completed` ha cerrado. */
  partial: { text: string; reasoning: string };
  toolCalls: ProtocolToolCall[];
  subagents: ProtocolSubagent[];
  todos: ProtocolTodo[];
  jobs: ProtocolJob[];
  approvals: ProtocolApproval[];
  questions: ProtocolQuestionRequest[];
  plans: ProtocolPlanRequest[];
  /**
   * La conversación de la sesión, **de todos sus runs**, acotada
   * (`TRANSCRIPT_LIMITS`): lo más antiguo se descarta primero. El bloque que
   * el asistente tiene abierto no está aquí: está en `partial`.
   */
  messages: ProtocolChatMessage[];
  /** Se descartaron entradas antiguas: `messages` no empieza en el principio. */
  messagesTruncated: boolean;
}

/** Foto de conjunto para una suscripción de resumen. */
export interface ProtocolOverviewSnapshot {
  /** Sesiones vivas (también las `detached`). */
  sessions: ProtocolSession[];
  approvals: ProtocolApproval[];
  questions: ProtocolQuestionRequest[];
  plans: ProtocolPlanRequest[];
}
