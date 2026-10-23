import type { Capability, ClientKind, Role } from './roles.js';
import type {
  ProtocolAgent,
  ProtocolSkill,
  ProtocolApproval,
  ProtocolApprovalDecision,
  ProtocolContextReport,
  ProtocolDecision,
  ProtocolHistoryPage,
  ProtocolJob,
  ProtocolMemoryStatus,
  ProtocolModel,
  ProtocolPlan,
  ProtocolPlanRequest,
  ProtocolQuestionAnswer,
  ProtocolQuestionRequest,
  ProtocolResolver,
  ProtocolRun,
  ProtocolServerInfo,
  ProtocolServerStatus,
  ProtocolSession,
  ProtocolSessionMemory,
} from './model.js';
import type { ProtocolEvent, ProtocolOverviewSnapshot, ProtocolSessionSnapshot } from './events.js';
import type { HANDOFF_FORMAT } from './handoff.js';

/**
 * Métodos del protocolo: nombre, parámetros, resultado, capacidad que exigen y
 * si cambian algo. Esta es la única definición; los schemas (`schemas.ts`)
 * validan los mismos nombres y un test comprueba que no falta ninguno.
 */

/** Sin parámetros / sin resultado: un objeto vacío, para poder añadir campos después. */
export type Empty = Record<string, never>;

/**
 * Campo común de las peticiones que cambian algo. Reservado: identifica la
 * operación para que el servidor pueda reconocer un reenvío deliberado. En la
 * v1 el servidor puede ignorarlo; el cliente **nunca** reenvía por su cuenta
 * (ver `mutating`).
 */
export interface Mutation {
  operationId?: string;
}

// --- core -------------------------------------------------------------------

export interface HelloParams {
  /** Versión del protocolo que habla el cliente. */
  protocol: number;
  token: string;
  client: { kind: ClientKind; name: string; version: string };
  /** Roles que pide. El servidor contesta con las capacidades que concede. */
  roles: Role[];
  /** Extensiones opcionales que el cliente entiende. */
  features?: string[];
  /**
   * **De solo entrada.** Lo que acredita a quien pide el rol `approver`: una
   * clave que la persona teclea, que el servidor comprueba contra lo que tenga
   * configurado y que no guarda. El token del canal **no** basta para obtener
   * la capacidad `approve`. No se devuelve en ningún resultado, evento ni
   * error, y no se registra.
   */
  approverKey?: string;
}

/**
 * Extensión que el servidor anuncia en `core.hello.features` cuando tiene
 * configurada una forma de acreditar aprobadores: solo entonces una solicitud
 * pendiente puede resolverse desde otro cliente.
 */
export const FEATURE_REMOTE_APPROVALS = 'remote-approvals';

export interface HelloResult {
  protocol: number;
  server: ProtocolServerInfo;
  /** Identifica esta conexión en `resolvedBy` y en los logs. */
  connectionId: number;
  /** Capacidades concedidas: puede ser un subconjunto de lo pedido. */
  capabilities: Capability[];
  /** Extensiones opcionales que el servidor ofrece. */
  features: string[];
}

// --- sesiones ---------------------------------------------------------------

export interface SessionsListParams {
  /** `true`: solo vivas; `false`: solo guardadas; ausente: todas. */
  live?: boolean;
  limit?: number;
}

export interface SessionsOpenParams extends Mutation {
  /**
   * Directorio de la sesión: absoluto, existente y accesible para el servidor,
   * que es quien lo comprueba. Ausente: el directorio por defecto del servidor
   * (el *home* de su usuario).
   */
  cwd?: string;
  /**
   * **Reservado y de solo entrada.** Variables de entorno para la sesión. No
   * forma parte de `ProtocolSession`, no se devuelve en ningún resultado,
   * snapshot, evento ni error, y no se registra. La v1 no lo usa.
   */
  env?: Record<string, string>;
  /** Reanudar esta sesión guardada en lugar de crear una. */
  resume?: string;
  /** Perfil de agente principal. Ausente: ninguno (`general`). */
  agent?: string;
  /** Ausentes: los de la configuración que aplique a `cwd`. */
  provider?: string;
  model?: string;
  readOnly?: boolean;
  sessionProfile?: string;
}

/**
 * Cómo quedó un `sessions.detach`. `detached`: este traspaso la ha pasado al
 * daemon. `already-daemon`: ya la alojaba el daemon (no ha cambiado nada).
 */
export type DetachStatus = 'detached' | 'already-daemon';

/** Topes de `sessions.revert`: turnos de una vez y rutas por lista. */
export const REVERT_LIMITS = { turns: 100, paths: 200 } as const;

export interface SessionsRevertParams extends Mutation {
  sessionId: string;
  /** Cuántos de los últimos turnos con cambios se deshacen. Por defecto 1. */
  turns?: number;
  /** Solo calcular qué se haría: no toca nada. */
  dryRun?: boolean;
  /** Deshacer aunque haya rutas cambiadas después del último turno (se pisan). */
  force?: boolean;
}

/**
 * Qué haría (o hizo) deshacer esos turnos. Las listas son rutas relativas a la
 * raíz del proyecto, recortadas a `REVERT_LIMITS.paths` (`truncated`).
 */
export interface ProtocolRevertPlan {
  turns: number[];
  /** Existían antes del turno más antiguo: se restauran. */
  restore: string[];
  /** No existían: se borran. */
  remove: string[];
  /** Cambiadas después del último turno: deshacer las pisaría. */
  conflicts: string[];
  /** Tocadas por esos turnos pero sin copia (demasiado grandes): no se deshacen. */
  skipped: string[];
  truncated: boolean;
}

/**
 * Cómo quedó un `sessions.revert`. `planned`: era `dryRun`. `reverted`: hecho.
 * `conflicts`: no se tocó nada (falta `force`). `nothing`: no hay turnos que
 * deshacer (o la sesión no guarda copias). `failed`: falló a medias; `plan`
 * dice lo que sí se llegó a deshacer.
 */
export type RevertStatus = 'planned' | 'reverted' | 'conflicts' | 'nothing' | 'failed';

// --- runs -------------------------------------------------------------------

export interface RunsStartParams extends Mutation {
  sessionId: string;
  input: string;
  mode?: 'normal' | 'plan';
}

/** Cómo quedó un mensaje de steering. Solo `accepted` lo encola. */
export type SteerStatus = 'accepted' | 'not-accepting' | 'empty' | 'too-large';

/**
 * Cómo quedó una cancelación. `not-running`: no había turno en curso (ya había
 * terminado). Un `runId` que no es el vigente es `STALE_STATE`, y un anfitrión
 * par sin conexión, `UNAVAILABLE` con `reason: 'host-unavailable'`.
 */
export type CancelStatus = 'cancelled' | 'not-running';

/**
 * Cómo quedó una petición de pausa. La pausa es cooperativa: `requested` quiere
 * decir que el run dejará de empezar trabajo en su siguiente punto seguro, no
 * que ya esté parado — eso lo dice `run.status: 'paused'`, que publica su
 * anfitrión. Pedirla otra vez no es un error (`already-requested`,
 * `already-paused`). `not-running`: no hay run que pausar.
 */
export type PauseStatus = 'requested' | 'already-requested' | 'already-paused' | 'not-running';

/**
 * Cómo quedó una reanudación. `resumed`: estaba en pausa (o con la pausa
 * pedida, que se retira) y continúa, el mismo run. `not-paused`: hay un run,
 * pero no estaba en pausa. `not-running`: no hay run.
 */
export type ResumeStatus = 'resumed' | 'not-paused' | 'not-running';

// --- suscripciones ----------------------------------------------------------

export type SubscriptionScope =
  /** Qué sesiones hay y qué esperan: eventos de `OVERVIEW_EVENT_TYPES`. */
  | { kind: 'overview' }
  /** Todo lo de una sesión, incluidos los eventos volátiles. */
  | { kind: 'session'; sessionId: string; sinceSeq?: number; volatile?: boolean };

export interface EventsSubscribeResult {
  subscriptionId: string;
  /**
   * `replay`: los eventos de estado posteriores a `sinceSeq` llegan a
   * continuación. `snapshot`: el hueco no se puede cubrir (o no se pidió
   * `sinceSeq`) y llega primero una foto, que sustituye el estado del cliente.
   */
  mode: 'replay' | 'snapshot';
}

// --- anfitrión par ----------------------------------------------------------

export interface HostRegisterParams extends Mutation {
  /** Foto de la sesión: es la autoridad, y sustituye lo que el servidor tuviera de ella. */
  snapshot: ProtocolSessionSnapshot;
  /**
   * Pid del proceso que aloja la sesión. Solo sirve para que el servidor, si
   * pierde la conexión, distinga un anfitrión muerto de uno que puede volver.
   */
  pid?: number;
  /**
   * Para reclamar una sesión que el servidor ya conoce y quedó sin anfitrión:
   * el `claim` que devolvió su primer registro. Sin él, o con otro, no se puede.
   */
  claim?: string;
}

export interface HostRegisterResult {
  claim: string;
  /**
   * Época de propiedad que el servidor da a este anfitrión para esta sesión.
   * Va en cada `host.publish`: tras un traspaso la sesión tiene otra y lo que
   * publique con esta se rechaza (`STALE_STATE`, `stale-epoch`).
   */
  epoch: number;
}

export interface HostPublishParams {
  sessionId: string;
  /** La época que devolvió `host.register`. */
  epoch: number;
  /**
   * Foto autoritativa: sustituye el estado que el servidor tuviera. El
   * anfitrión la envía cuando perdió eventos (su cola se llenó). Los eventos
   * del mismo lote son posteriores a ella.
   */
  snapshot?: ProtocolSessionSnapshot;
  /** Lote en orden. Los de estado, con `seq` consecutivo por sesión. */
  events: ProtocolEvent[];
}

export interface HostResolveApprovalParams {
  sessionId: string;
  approvalId: string;
  decision: ProtocolApprovalDecision;
  /** Frase tecleada, si la solicitud lleva `confirmPhrase`. El anfitrión la comprueba. */
  phrase?: string;
  by: ProtocolResolver;
}

/**
 * Empieza a traspasar al servidor una sesión que aloja esta conexión (M10). El
 * anfitrión ya ha dejado de empezar trabajo nuevo y ha publicado todo hasta
 * `seq`; el contexto llega después en `chunks` trozos (`host.handoffChunk`).
 */
export interface HostHandoffBeginParams extends Mutation {
  sessionId: string;
  epoch: number;
  /** Último `seq` publicado: el servidor tiene que estar exactamente ahí. */
  seq: number;
  format: typeof HANDOFF_FORMAT;
  chunks: number;
  /** Longitud total del contexto serializado. */
  chars: number;
}

/** Una entrada de la tabla de métodos, como tipo. */
interface Spec<P, R> {
  params: P;
  result: R;
}

export interface ProtocolMethods {
  'core.hello': Spec<HelloParams, HelloResult>;
  'core.status': Spec<Empty, ProtocolServerStatus>;
  'core.shutdown': Spec<Mutation & { force?: boolean }, Empty>;

  'agents.list': Spec<{ cwd?: string }, { agents: ProtocolAgent[] }>;
  /**
   * Skills que vería una sesión nueva de ese agente: las de serie, de usuario
   * y del proyecto de `cwd` (obligatorio) para uno de código; solo las de
   * serie que declaran `assistant` para el asistente (sin `cwd`).
   */
  'skills.list': Spec<{ cwd?: string; agent?: string }, { skills: ProtocolSkill[] }>;
  'models.list': Spec<{ provider?: string }, { models: ProtocolModel[]; error?: string }>;

  'sessions.list': Spec<SessionsListParams, { sessions: ProtocolSession[] }>;
  'sessions.get': Spec<{ sessionId: string }, { snapshot: ProtocolSessionSnapshot }>;
  /** M11 — conversación guardada, de lo más reciente hacia atrás (`before`: el id del primero que ya se tiene). */
  'sessions.history': Spec<
    { sessionId: string; before?: string; limit?: number },
    ProtocolHistoryPage
  >;
  /** M11 — contexto activo por capas, conversación guardada y memoria de sesión (recuentos). */
  'sessions.context': Spec<{ sessionId: string }, { report: ProtocolContextReport }>;
  /** M11 — la memoria de sesión, con su procedencia. */
  'sessions.memory': Spec<{ sessionId: string }, { memory: ProtocolSessionMemory }>;
  'sessions.open': Spec<SessionsOpenParams, { session: ProtocolSession }>;
  'sessions.close': Spec<Mutation & { sessionId: string }, Empty>;
  'sessions.setModel': Spec<
    Mutation & { sessionId: string; model: string },
    { session: ProtocolSession }
  >;
  'sessions.setAgent': Spec<
    Mutation & { sessionId: string; agent: string | null },
    { session: ProtocolSession }
  >;
  'sessions.setReadOnly': Spec<
    Mutation & { sessionId: string; readOnly: boolean },
    { session: ProtocolSession }
  >;
  /**
   * Pasa una sesión de su anfitrión par al daemon, sin cambiar de id ni perder
   * contexto (M10). Lo hace el par: el servidor se lo pide y comprueba el
   * resultado. `BUSY`/`NOT_TRANSFERABLE` con el motivo si no se puede.
   */
  'sessions.detach': Spec<
    Mutation & { sessionId: string },
    { status: DetachStatus; session: ProtocolSession }
  >;
  /**
   * Deshace los ficheros de los últimos turnos de una sesión del daemon (UX-1).
   * Exige `approve`: pisa ficheros sin pasar por las aprobaciones del agente.
   * `BUSY` con un turno en curso; `UNAVAILABLE` (`peer-hosted`) en una sesión par.
   */
  'sessions.revert': Spec<
    SessionsRevertParams,
    { status: RevertStatus; plan: ProtocolRevertPlan | null }
  >;

  'runs.list': Spec<
    { sessionId?: string; active?: boolean; limit?: number },
    { runs: ProtocolRun[] }
  >;
  'runs.get': Spec<{ runId: string }, { run: ProtocolRun }>;
  'runs.start': Spec<RunsStartParams, { run: ProtocolRun }>;
  'runs.steer': Spec<Mutation & { sessionId: string; text: string }, { status: SteerStatus }>;
  'runs.pause': Spec<Mutation & { sessionId: string; runId?: string }, { status: PauseStatus }>;
  'runs.resume': Spec<Mutation & { sessionId: string; runId?: string }, { status: ResumeStatus }>;
  /** Con `runId`, solo cancela si ese sigue siendo el run en curso (`STALE_STATE` si no). */
  'runs.cancel': Spec<Mutation & { sessionId: string; runId?: string }, { status: CancelStatus }>;

  'approvals.list': Spec<
    { sessionId?: string },
    {
      approvals: ProtocolApproval[];
      questions: ProtocolQuestionRequest[];
      plans: ProtocolPlanRequest[];
    }
  >;
  /**
   * `sessionId` (opcional): la sesión a la que el cliente cree que pertenece la
   * solicitud. Si se da y no es la suya, `NOT_FOUND` y no se resuelve nada: un
   * id cruzado nunca resuelve la solicitud de otra sesión.
   */
  'approvals.resolve': Spec<
    Mutation & {
      sessionId?: string;
      approvalId: string;
      decision: ProtocolApprovalDecision;
      phrase?: string;
    },
    Empty
  >;
  'questions.answer': Spec<
    Mutation & { sessionId?: string; requestId: string; answers: ProtocolQuestionAnswer[] | null },
    Empty
  >;
  'plans.decide': Spec<
    Mutation & {
      sessionId?: string;
      requestId: string;
      decision: 'approve' | 'reject';
      plan?: ProtocolPlan;
    },
    Empty
  >;

  'jobs.list': Spec<{ sessionId: string }, { jobs: ProtocolJob[] }>;
  'jobs.cancel': Spec<Mutation & { sessionId: string; jobId: string }, Empty>;

  /**
   * Memoria de decisiones: la del proyecto de `cwd` o, sin `cwd`, la global
   * (la del asistente). Nunca las dos a la vez.
   */
  'memory.status': Spec<{ cwd?: string }, ProtocolMemoryStatus>;
  'memory.decisions': Spec<
    { cwd?: string; query?: string; limit?: number },
    { decisions: ProtocolDecision[] }
  >;

  'events.subscribe': Spec<{ scope: SubscriptionScope }, EventsSubscribeResult>;
  'events.unsubscribe': Spec<{ subscriptionId: string }, Empty>;
  'trace.subscribe': Spec<{ sessionId: string }, { subscriptionId: string }>;
  'trace.unsubscribe': Spec<{ subscriptionId: string }, Empty>;

  // Anfitrión par → servidor.
  'host.register': Spec<HostRegisterParams, HostRegisterResult>;
  'host.publish': Spec<HostPublishParams, Empty>;
  'host.unregister': Spec<Mutation & { sessionId: string }, Empty>;
  'host.handoffBegin': Spec<HostHandoffBeginParams, { handoffId: string }>;
  'host.handoffChunk': Spec<
    { sessionId: string; handoffId: string; index: number; data: string },
    Empty
  >;
  /**
   * Cierra el traspaso: el servidor monta la sesión con ese contexto y pasa a
   * ser su único anfitrión, o falla y el par sigue siéndolo. No hay término medio.
   */
  'host.handoffCommit': Spec<
    { sessionId: string; handoffId: string },
    { session: ProtocolSession; epoch: number }
  >;
  'host.handoffAbort': Spec<{ sessionId: string; handoffId: string }, Empty>;

  // Servidor → anfitrión par.
  'host.cancel': Spec<{ sessionId: string; runId?: string }, { status: CancelStatus }>;
  'host.pause': Spec<{ sessionId: string; runId?: string }, { status: PauseStatus }>;
  'host.resume': Spec<{ sessionId: string; runId?: string }, { status: ResumeStatus }>;
  'host.steer': Spec<{ sessionId: string; text: string }, { status: SteerStatus }>;
  'host.resolveApproval': Spec<HostResolveApprovalParams, Empty>;
  'host.answerQuestions': Spec<
    {
      sessionId: string;
      requestId: string;
      answers: ProtocolQuestionAnswer[] | null;
      by: ProtocolResolver;
    },
    Empty
  >;
  'host.decidePlan': Spec<
    {
      sessionId: string;
      requestId: string;
      decision: 'approve' | 'reject';
      plan?: ProtocolPlan;
      by: ProtocolResolver;
    },
    Empty
  >;
  /** Que el anfitrión traspase la sesión al servidor (lo pide `sessions.detach`). */
  'host.detach': Spec<{ sessionId: string }, { status: 'detached' }>;
}

export type MethodName = keyof ProtocolMethods;
export type MethodParams<M extends MethodName> = ProtocolMethods[M]['params'];
export type MethodResult<M extends MethodName> = ProtocolMethods[M]['result'];

export interface MethodInfo {
  /** Capacidad que exige. `null`: no exige ninguna (solo `core.hello`). */
  capability: Capability | null;
  /**
   * Cambia estado. Si la conexión cae después de enviar una petición así y
   * antes de recibir su respuesta, el resultado es **desconocido**: el cliente
   * lo dice y no la reenvía.
   */
  mutating: boolean;
  /** Quién la envía: el cliente al servidor, o el servidor a un anfitrión par. */
  direction: 'client-to-server' | 'server-to-host';
}

const read = (capability: Capability): MethodInfo => ({
  capability,
  mutating: false,
  direction: 'client-to-server',
});
const write = (capability: Capability): MethodInfo => ({
  capability,
  mutating: true,
  direction: 'client-to-server',
});
const toHost: MethodInfo = { capability: 'host', mutating: true, direction: 'server-to-host' };

export const METHODS: Readonly<Record<MethodName, MethodInfo>> = {
  'core.hello': { capability: null, mutating: false, direction: 'client-to-server' },
  'core.status': read('observe'),
  'core.shutdown': write('control'),

  'agents.list': read('observe'),
  'skills.list': read('observe'),
  'models.list': read('observe'),

  'sessions.list': read('observe'),
  'sessions.get': read('observe'),
  'sessions.history': read('observe'),
  'sessions.context': read('observe'),
  'sessions.memory': read('observe'),
  'sessions.open': write('control'),
  'sessions.close': write('control'),
  'sessions.setModel': write('control'),
  'sessions.setAgent': write('control'),
  'sessions.setReadOnly': write('control'),
  'sessions.detach': write('control'),
  // Pisa ficheros sin pasar por las aprobaciones: la autoridad es la de aprobar.
  'sessions.revert': write('approve'),

  'runs.list': read('observe'),
  'runs.get': read('observe'),
  'runs.start': write('control'),
  'runs.steer': write('control'),
  'runs.pause': write('control'),
  'runs.resume': write('control'),
  'runs.cancel': write('control'),

  'approvals.list': read('observe'),
  'approvals.resolve': write('approve'),
  'questions.answer': write('approve'),
  'plans.decide': write('approve'),

  'jobs.list': read('observe'),
  'jobs.cancel': write('control'),

  'memory.status': read('observe'),
  'memory.decisions': read('observe'),

  // Suscribirse solo cambia el estado de la propia conexión: se puede repetir.
  'events.subscribe': read('observe'),
  'events.unsubscribe': read('observe'),
  'trace.subscribe': read('observe'),
  'trace.unsubscribe': read('observe'),

  'host.register': write('host'),
  'host.publish': write('host'),
  'host.unregister': write('host'),
  'host.handoffBegin': write('host'),
  'host.handoffChunk': write('host'),
  'host.handoffCommit': write('host'),
  'host.handoffAbort': write('host'),

  'host.cancel': toHost,
  'host.pause': toHost,
  'host.resume': toHost,
  'host.steer': toHost,
  'host.resolveApproval': toHost,
  'host.answerQuestions': toHost,
  'host.decidePlan': toHost,
  'host.detach': toHost,
};

export function isMethodName(value: string): value is MethodName {
  return Object.prototype.hasOwnProperty.call(METHODS, value);
}

// --- notificaciones (sin respuesta) -----------------------------------------

export interface ProtocolNotifications {
  /** Eventos de una suscripción, en orden. Puede traer varios (agrupación). */
  events: { subscriptionId: string; events: ProtocolEvent[] };
  /** Foto de una sesión: sustituye el estado que el cliente tuviera de ella. */
  snapshot: { subscriptionId: string; snapshot: ProtocolSessionSnapshot };
  /** Foto de conjunto de una suscripción de resumen. */
  overview: { subscriptionId: string; overview: ProtocolOverviewSnapshot };
  /**
   * Registros de la traza de una sesión. `reset`: empieza de cero. El formato
   * de cada registro es el de la traza de Stratum (`format`), opaco para el
   * protocolo.
   */
  'trace.records': {
    subscriptionId: string;
    sessionId: string;
    reset: boolean;
    format: number;
    records: Array<Record<string, unknown>>;
  };
  /** El servidor va a cerrar la conexión y dice por qué. */
  goodbye: { reason: 'shutdown' | 'replaced' | 'protocol-error' | 'idle' };
}

export type NotificationName = keyof ProtocolNotifications;
export type NotificationParams<N extends NotificationName> = ProtocolNotifications[N];

export const NOTIFICATIONS: readonly NotificationName[] = [
  'events',
  'snapshot',
  'overview',
  'trace.records',
  'goodbye',
];

export function isNotificationName(value: string): value is NotificationName {
  return (NOTIFICATIONS as readonly string[]).includes(value);
}
