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
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
  | { type: 'sessions'; sessionIds: string[] }
  | { type: 'snapshot'; sessionId: string; snapshot: unknown }
  | { type: 'events'; sessionId: string; events: unknown[] }
  | { type: 'approver'; status: ApproverStatus }
  | { type: 'open-view'; view: DotView };

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
 * es seguro).
 */
export type CommandErrorKind = 'invalid' | 'not-sent' | 'unknown' | 'no-answer' | 'rejected';

const ERROR_KINDS: readonly CommandErrorKind[] = ['invalid', 'not-sent', 'unknown', 'no-answer', 'rejected'];

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
  /** Estado de la autoridad de aprobar. Los cambios llegan por `onEvent` (`approver`). */
  approverStatus(): Promise<ApproverStatus>;
  /** Abre la ventana nativa de desbloqueo. La clave se teclea allí: aquí no pasa. */
  unlockApprovals(): Promise<void>;
  /** Suelta la autoridad. Lo pendiente sigue pendiente. */
  lockApprovals(): Promise<void>;
  /**
   * Aprueba una solicitud de esa sesión, una vez. `phrase` es lo que tecleó la
   * persona si la solicitud pide frase; `forSession` = `allow-all` (solo esa
   * sesión). Resuelve cuando el daemon lo acepta: lo que cambie llega por eventos.
   */
  approve(sessionId: string, approvalId: string, opts: { phrase?: string; forSession: boolean }): Promise<void>;
  deny(sessionId: string, approvalId: string): Promise<void>;
  /** `null` omite la tanda: el agente sigue con supuestos. */
  answerQuestions(sessionId: string, requestId: string, answers: QuestionAnswerInput[] | null): Promise<void>;
  /** Aprueba el plan propuesto tal cual, o lo rechaza. */
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
  approverStatus: () => invoke<ApproverStatus>('dot_approver_status'),
  unlockApprovals: () => invoke('dot_approver_unlock'),
  lockApprovals: () => invoke('dot_approver_lock'),
  approve: (sessionId, approvalId, opts) =>
    invoke('dot_approve', { sessionId, approvalId, phrase: opts.phrase ?? null, forSession: opts.forSession }),
  deny: (sessionId, approvalId) => invoke('dot_deny', { sessionId, approvalId }),
  answerQuestions: (sessionId, requestId, answers) =>
    invoke('dot_answer_questions', { sessionId, requestId, answers }),
  decidePlan: (sessionId, requestId, decision) => invoke('dot_decide_plan', { sessionId, requestId, decision }),
  setAttention: (counts) => invoke('dot_set_attention', { ...counts }),
  hideWindow: () => invoke('dot_hide'),
  quit: () => invoke('dot_quit'),
  onEvent: (handler) => listen<DotEvent>(DOT_EVENT, (e) => handler(e.payload)),
};
