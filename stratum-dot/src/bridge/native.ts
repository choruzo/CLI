/**
 * La frontera con el lado nativo (Rust). Es **todo** lo que el webview puede
 * pedir: una lista corta de funciones tipadas, cada una con su comando de
 * Tauri. No hay una función genérica para enviar un método cualquiera del
 * protocolo, y el webview nunca ve el token del canal, la ruta del pipe ni el
 * `endpoint.json`: conectar, autenticar y suscribirse es cosa de Rust
 * (`crates/dot-link`).
 *
 * Aprobar tampoco pasa credenciales por aquí: el webview pide **qué** resolver
 * (`approve`, `deny`, `answerQuestions`, `decidePlan`) y el broker nativo lo
 * hace con su propia conexión. Desbloquearlo abre otra ventana, donde se
 * teclea la clave; de ella aquí solo llega el estado (`ApproverStatus`).
 *
 * Y pedir no es resolver (M9): aprobar, «para la sesión», enviar respuestas y
 * aprobar un plan abren una **confirmación nativa** —otra ventana, que el
 * webview no controla— y solo se envían si la persona confirma allí. La frase
 * de una confirmación con nombre se teclea en esa ventana, no aquí.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ProtocolGrantMinutes } from '../protocol';

/** Estado de la conexión con el daemon (`ConnectionState` en `dot-link/src/state.rs`). */
export type ConnectionState =
  | { kind: 'starting' }
  | { kind: 'daemon-starting' }
  | { kind: 'connecting' }
  | {
      kind: 'connected';
      serverVersion: string;
      serverPlatform: string;
      protocol: number;
      capabilities: string[];
      features: string[];
    }
  | { kind: 'reconnecting'; attempt: number }
  | {
      kind: 'incompatible';
      clientProtocol: number;
      daemonProtocol: number | null;
      daemonVersion: string | null;
    }
  | { kind: 'error'; message: string };

/** Por qué está bloqueada la autoridad de aprobar (`LockReason` en `dot-link/src/approver.rs`). */
export type ApproverLockReason = 'initial' | 'manual' | 'expired' | 'connection-lost' | 'daemon-changed';

/**
 * Estado del broker de aprobador (`ApproverStatus`). Es lo único que el
 * webview sabe de la autoridad de aprobar: ni la clave, ni nada derivado.
 */
export type ApproverStatus =
  | { kind: 'locked'; reason: ApproverLockReason }
  | { kind: 'unlocking' }
  /** `expiresAt`: ms Unix, del reloj local. Solo para enseñarlo. */
  | { kind: 'ready'; expiresAt: number }
  | { kind: 'unavailable'; reason: 'not-connected' | 'no-approver-key' }
  | { kind: 'error'; message: string };

/** Vistas que el lado nativo puede pedir que se abran (la bandeja). */
export type DotView = 'human-input';

/**
 * Lo que llega del lado nativo. `snapshot` y `events` traen DTOs del protocolo
 * sin validar (`unknown`): quien los recibe los pasa por `protocol/apply.ts`.
 */
export type DotEvent =
  | { type: 'connection'; state: ConnectionState }
  /** `unfollowed`: sesiones vivas que Dot no sigue (ya sigue 64): la lista es parcial. */
  | { type: 'sessions'; sessionIds: string[]; unfollowed?: number }
  | { type: 'snapshot'; sessionId: string; snapshot: unknown }
  | { type: 'events'; sessionId: string; events: unknown[] }
  | { type: 'approver'; status: ApproverStatus }
  | { type: 'open-view'; view: DotView }
  /**
   * M16 — la ventana recibió el foco poco después de la notificación de una
   * rutina: abrir la sesión de esa rutina (solo se selecciona). Nunca resuelve nada.
   */
  | { type: 'open-session'; sessionId: string };

export interface AppInfo {
  dotVersion: string;
  /** Versión del protocolo que habla este Dot. */
  protocol: number;
  /** Si hay bandeja, cerrar la ventana la oculta; si no, sale de Dot. */
  trayAvailable: boolean;
}

/**
 * `unknown`: algo que cambia estado salió y no hubo respuesta —no se sabe si se
 * aplicó, y no se reenvía—. `no-answer`: una consulta sin respuesta (repetirla
 * es seguro). `not-confirmed`: la persona no confirmó en la ventana nativa (la
 * canceló, caducó, o la solicitud o la autoridad cambiaron); no salió nada, y
 * `reason` dice por qué (`cancelled`, `expired`, `locked`, `resolved-elsewhere`…).
 */
export type CommandErrorKind = 'invalid' | 'not-sent' | 'unknown' | 'no-answer' | 'rejected' | 'not-confirmed';

const ERROR_KINDS: readonly CommandErrorKind[] = [
  'invalid',
  'not-sent',
  'unknown',
  'no-answer',
  'rejected',
  'not-confirmed',
];

/** Por qué no se pudo dar una orden (`CommandError` en `state.rs`). */
export interface CommandError {
  kind: CommandErrorKind;
  code: string | null;
  reason: string | null;
  message: string;
}

export function toCommandError(err: unknown): CommandError {
  if (typeof err === 'object' && err !== null && 'kind' in err && 'message' in err) {
    const e = err as Record<string, unknown>;
    return {
      kind: ERROR_KINDS.includes(e.kind as CommandErrorKind) ? (e.kind as CommandErrorKind) : 'unknown',
      code: typeof e.code === 'string' ? e.code : null,
      reason: typeof e.reason === 'string' ? e.reason : null,
      message: String(e.message),
    };
  }
  return { kind: 'unknown', code: null, reason: null, message: typeof err === 'string' ? err : 'Unexpected error.' };
}

/**
 * Lo que se puede pedir al abrir una sesión. Todo opcional: lo que falte lo
 * decide el daemon. No hay variables de entorno, ni se puede: el entorno de
 * una sesión del daemon es el del daemon.
 */
export interface OpenSessionRequest {
  cwd?: string;
  agent?: string;
  provider?: string;
  model?: string;
}

/** M16 — topes opcionales de una rutina (`ProtocolRoutineLimits`). */
export interface RoutineLimitsInput {
  maxIterations?: number;
  timeoutMinutes?: number;
}

/** M16 — los campos de `routines.add`, uno a uno. El lado nativo los valida y arma la petición. */
export interface NewRoutineInput {
  name: string;
  schedule: string;
  prompt: string;
  model?: string;
  enabled?: boolean;
  limits?: RoutineLimitsInput;
}

/**
 * M16 — qué cambia `routines.update`; lo que no se nombra no se toca. Quitar el
 * modelo o los topes es `clearModel` / `clearLimits` (el `null` del contrato).
 */
export interface RoutinePatchInput {
  name?: string;
  schedule?: string;
  prompt?: string;
  model?: string;
  clearModel?: boolean;
  enabled?: boolean;
  limits?: RoutineLimitsInput;
  clearLimits?: boolean;
}

/** M16 — el aviso del sistema al terminar una rutina. El lado nativo acota el texto. */
export interface RoutineNotification {
  title: string;
  body: string;
  /** La sesión que se abre si la ventana recibe el foco enseguida. */
  sessionId: string;
}

/** Una respuesta a una pregunta del agente (`ProtocolQuestionAnswer`). */
export interface QuestionAnswerInput {
  question: string;
  answer: string;
  optionId?: string;
}

/** Cuánto espera a una persona, para la bandeja. Solo un contador. */
export interface PendingCounts {
  approvals: number;
  questions: number;
  plans: number;
}

export interface NativeBridge {
  /**
   * La interfaz está lista. El estado de la conexión y una foto de cada sesión
   * llegan a continuación por `onEvent` (no en la respuesta: así no hay dos
   * fuentes que puedan llegar desordenadas).
   */
  attach(): Promise<AppInfo>;
  /** Volver a empezar: descubrir, arrancar el daemon si hace falta, conectar. */
  retry(): Promise<void>;
  /** Qué sesión se mira (la única que recibe el texto según se genera). */
  focusSession(sessionId: string | null): Promise<void>;
  /** Pedir una foto nueva de una sesión. */
  resyncSession(sessionId: string): Promise<void>;
  pauseRun(sessionId: string, runId?: string): Promise<string>;
  resumeRun(sessionId: string, runId?: string): Promise<string>;
  cancelRun(sessionId: string, runId?: string): Promise<string>;
  steerRun(sessionId: string, text: string): Promise<string>;
  /**
   * Abre una sesión alojada en el daemon. Devuelve el resultado **sin validar**
   * (`protocol/results.ts`); la sesión llega después por `onEvent`.
   */
  openSession(request: OpenSessionRequest): Promise<unknown>;
  /** Un mensaje: un run nuevo de esa sesión. Resultado sin validar. */
  startRun(sessionId: string, input: string): Promise<unknown>;
  listAgents(cwd?: string): Promise<unknown>;
  listModels(): Promise<unknown>;
  /** M14 — estado de la caja del asistente. Resultado sin validar. */
  boxStatus(): Promise<unknown>;
  /**
   * M14 — arrancar la caja: la crea, o la recrea si quedó desfasada. La primera
   * vez el daemon construye su imagen: puede tardar minutos. Sin validar.
   */
  boxStart(): Promise<unknown>;
  /** M14 — pararla. Su home se conserva. Borrarla no se puede desde Dot. */
  boxStop(): Promise<unknown>;
  /** M15 — la pantalla de la caja ahora, para verla en solo lectura. Sin validar. */
  boxScreen(): Promise<unknown>;
  /** M16 — las rutinas del asistente. Resultado sin validar. */
  routinesList(): Promise<unknown>;
  /** M16 — crear una rutina. Sin respuesta, `unknown`: no se repite. */
  routinesAdd(input: NewRoutineInput): Promise<unknown>;
  /** M16 — cambiar una rutina (solo el parche). */
  routinesUpdate(routineId: string, patch: RoutinePatchInput): Promise<unknown>;
  /** M16 — borrar una rutina **y su sesión**. */
  routinesRemove(routineId: string): Promise<unknown>;
  /** M16 — dispararla ya, también deshabilitada. */
  routinesRun(routineId: string): Promise<unknown>;
  /**
   * M17 — revocar una concesión vigente. Solo resta autoridad: va por la
   * conexión principal, sin confirmación nativa. Sin respuesta, `unknown`: no se repite.
   */
  grantsRevoke(sessionId: string, grantId: string): Promise<unknown>;
  /** M16 — notificación del sistema (texto plano; sin acciones). */
  notifyRoutine(notification: RoutineNotification): Promise<void>;
  /** Estado de la autoridad de aprobar. Los cambios llegan por `onEvent` (`approver`). */
  approverStatus(): Promise<ApproverStatus>;
  /** Abre la ventana nativa de desbloqueo. La clave se teclea allí: aquí no pasa. */
  unlockApprovals(): Promise<void>;
  /** Suelta la autoridad. Lo pendiente sigue pendiente. */
  lockApprovals(): Promise<void>;
  /**
   * Pide aprobar una solicitud de esa sesión. Abre la confirmación nativa y
   * solo se envía (una vez) si la persona confirma allí; si la solicitud pide
   * frase, se teclea allí. `forSession` = `allow-all` (solo esa sesión).
   * Resuelve cuando el daemon lo acepta: lo que cambie llega por eventos.
   */
  approve(
    sessionId: string,
    approvalId: string,
    opts: { forSession: boolean; grantMinutes?: ProtocolGrantMinutes },
  ): Promise<void>;
  /** Directo, sin confirmación: es lo que pasa cuando nadie contesta. */
  deny(sessionId: string, approvalId: string): Promise<void>;
  /** Con respuestas, confirmación nativa; `null` omite la tanda (directo): el agente sigue con supuestos. */
  answerQuestions(sessionId: string, requestId: string, answers: QuestionAnswerInput[] | null): Promise<void>;
  /** Aprobar el plan tal cual pide confirmación nativa; rechazarlo, no. */
  decidePlan(sessionId: string, requestId: string, decision: 'approve' | 'reject'): Promise<void>;
  /** Para la bandeja: cuánto se enseña pendiente. */
  setAttention(counts: PendingCounts): Promise<void>;
  hideWindow(): Promise<void>;
  /** Cierra Dot. El daemon y las sesiones siguen. */
  quit(): Promise<void>;
  onEvent(handler: (event: DotEvent) => void): Promise<() => void>;
}

/** Canal único nativo → interfaz: mantiene el orden entre fotos, eventos y estado. */
export const DOT_EVENT = 'dot://event';

export const tauriBridge: NativeBridge = {
  attach: () => invoke<AppInfo>('dot_attach'),
  retry: () => invoke('dot_retry'),
  focusSession: (sessionId) => invoke('dot_focus_session', { sessionId }),
  resyncSession: (sessionId) => invoke('dot_resync_session', { sessionId }),
  pauseRun: (sessionId, runId) => invoke<string>('dot_pause_run', { sessionId, runId: runId ?? null }),
  resumeRun: (sessionId, runId) => invoke<string>('dot_resume_run', { sessionId, runId: runId ?? null }),
  cancelRun: (sessionId, runId) => invoke<string>('dot_cancel_run', { sessionId, runId: runId ?? null }),
  steerRun: (sessionId, text) => invoke<string>('dot_steer_run', { sessionId, text }),
  openSession: (request) =>
    invoke<unknown>('dot_open_session', {
      cwd: request.cwd ?? null,
      agent: request.agent ?? null,
      provider: request.provider ?? null,
      model: request.model ?? null,
    }),
  startRun: (sessionId, input) => invoke<unknown>('dot_start_run', { sessionId, input }),
  listAgents: (cwd) => invoke<unknown>('dot_list_agents', { cwd: cwd ?? null }),
  listModels: () => invoke<unknown>('dot_list_models'),
  boxStatus: () => invoke<unknown>('dot_box_status'),
  boxStart: () => invoke<unknown>('dot_box_start'),
  boxStop: () => invoke<unknown>('dot_box_stop'),
  boxScreen: () => invoke<unknown>('dot_box_screen'),
  routinesList: () => invoke<unknown>('dot_routines_list'),
  routinesAdd: (input) =>
    invoke<unknown>('dot_routines_add', {
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      model: input.model ?? null,
      enabled: input.enabled ?? null,
      maxIterations: input.limits?.maxIterations ?? null,
      timeoutMinutes: input.limits?.timeoutMinutes ?? null,
    }),
  routinesUpdate: (routineId, patch) => invoke<unknown>('dot_routines_update', { routineId, patch }),
  routinesRemove: (routineId) => invoke<unknown>('dot_routines_remove', { routineId }),
  routinesRun: (routineId) => invoke<unknown>('dot_routines_run', { routineId }),
  grantsRevoke: (sessionId, grantId) => invoke<unknown>('dot_grants_revoke', { sessionId, grantId }),
  notifyRoutine: (n) => invoke('dot_notify_routine', { title: n.title, body: n.body, sessionId: n.sessionId }),
  approverStatus: () => invoke<ApproverStatus>('dot_approver_status'),
  unlockApprovals: () => invoke('dot_approver_unlock'),
  lockApprovals: () => invoke('dot_approver_lock'),
  approve: (sessionId, approvalId, opts) =>
    invoke('dot_approve', { sessionId, approvalId, forSession: opts.forSession, grantMinutes: opts.grantMinutes ?? null }),
  deny: (sessionId, approvalId) => invoke('dot_deny', { sessionId, approvalId }),
  answerQuestions: (sessionId, requestId, answers) =>
    invoke('dot_answer_questions', { sessionId, requestId, answers }),
  decidePlan: (sessionId, requestId, decision) => invoke('dot_decide_plan', { sessionId, requestId, decision }),
  setAttention: (counts) => invoke('dot_set_attention', { ...counts }),
  hideWindow: () => invoke('dot_hide'),
  quit: () => invoke('dot_quit'),
  onEvent: (handler) => listen<DotEvent>(DOT_EVENT, (e) => handler(e.payload)),
};
