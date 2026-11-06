/**
 * La frontera con el lado nativo (Rust) para todo lo que es del daemon (M12).
 * Es **todo** lo que el webview puede pedir: una lista corta de funciones
 * tipadas, cada una con su comando de Tauri (`src-tauri/src/commands.rs`). No
 * hay una función genérica para enviar un método cualquiera del protocolo, y
 * el webview nunca ve el token del canal, la ruta del pipe ni el
 * `endpoint.json`: descubrir, arrancar el daemon, autenticar y suscribirse es
 * cosa de Rust (`dot_link`, el enlace compartido con Stratum Dot).
 *
 * Resolver lo pendiente es como en Stratum Dot: aquí solo se pide **qué**
 * resolver. La autoridad la pone el broker nativo (otra conexión), la clave se
 * teclea en otra ventana que este webview no ve, y lo sensible (aprobar,
 * responder, aprobar un plan) solo sale si la persona lo confirma en una
 * ventana nativa. Este fichero no recibe ni devuelve la clave.
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

/**
 * Lo que llega del lado nativo. `overview`, `snapshot` y los eventos traen DTOs
 * del protocolo **sin validar** (`unknown`): quien los recibe los pasa por el
 * contrato antes de usarlos.
 */
export type DesktopEvent =
  | { type: 'connection'; state: ConnectionState }
  /** Las sesiones vivas según el daemon. Sustituye. */
  | { type: 'sessions'; sessionIds: string[]; unfollowed?: number }
  /** Foto de conjunto: el estado operativo de todas, sin conversaciones. */
  | { type: 'overview'; overview: unknown }
  | { type: 'overview-events'; events: unknown[] }
  /** Foto de la sesión que se mira (la única que se sigue). */
  | { type: 'snapshot'; sessionId: string; snapshot: unknown }
  | { type: 'events'; sessionId: string; events: unknown[] }
  /** Estado de la autoridad de aprobar. Sin datos: ni la clave ni nada derivado. */
  | { type: 'approver'; status: ApproverStatus };

/** `ApproverStatus` de `dot-link/src/approver.rs`. */
export type ApproverStatus =
  | { kind: 'locked'; reason: string }
  | { kind: 'unlocking' }
  /** `expiresAt`: ms Unix (reloj local). */
  | { kind: 'ready'; expiresAt: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'error'; message: string };

export interface AppInfo {
  desktopVersion: string;
  /** Versión del protocolo que habla este cliente. */
  protocol: number;
}

/**
 * `unknown`: algo que cambia estado salió y no hubo respuesta —no se sabe si se
 * aplicó, y **no se reenvía**—. `no-answer`: una consulta sin respuesta
 * (repetirla es seguro). `not-sent`: no salió nada (sin conexión).
 * `not-confirmed`: lo sensible no se confirmó en la ventana nativa (`reason`
 * dice por qué: `cancelled`, `expired`, `resolved-elsewhere`…); no salió nada.
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

/** Una respuesta a una pregunta, como la espera el lado nativo (`QuestionAnswer`). */
export interface QuestionAnswerInput {
  question: string;
  answer: string;
  optionId?: string;
}

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
  return {
    kind: 'unknown',
    code: null,
    reason: null,
    message: typeof err === 'string' ? err : 'Error inesperado.',
  };
}

/** Preferencias de la app (`prefs.rs`), de solo lectura. */
export interface DesktopPrefs {
  notifications: { enabled: boolean; minSeconds: number };
  globalHotkey: string;
  updatesAutoCheck: boolean;
  workspacesRoot: string;
  maxFileBytes: number;
  maxWorkspaceBytes: number;
  configPath: string;
  warnings: string[];
  hotkeyError: string | null;
  /** Conversaciones de antes de M12 sin importar al daemon (`stratum desktop import`). */
  legacyConversations: number;
  /** Hay `imageGeneration` en la config global: `/imagen` disponible. */
  imageGeneration: boolean;
}

export interface NativeBridge {
  /** La interfaz está lista: lo que haya llega después por `onEvent`. */
  attach(): Promise<AppInfo>;
  /** Volver a empezar: descubrir, arrancar el daemon si hace falta, conectar. */
  retry(): Promise<void>;
  /** Qué sesión se mira: la única de la que se pide la conversación. */
  focusSession(sessionId: string | null): Promise<void>;
  resyncSession(sessionId: string): Promise<void>;
  pauseRun(sessionId: string, runId?: string): Promise<string>;
  resumeRun(sessionId: string, runId?: string): Promise<string>;
  cancelRun(sessionId: string, runId?: string): Promise<string>;
  /** `images`: rutas de imágenes que acompañan al mensaje (máx 5; vacío = ninguna). */
  steerRun(sessionId: string, text: string, images: string[]): Promise<string>;
  /** Conversación nueva con el asistente; sin elección, provider y modelo de la config. Resultado sin validar. */
  newChat(choice?: { provider: string; model: string }): Promise<unknown>;
  startRun(sessionId: string, input: string, images: string[]): Promise<unknown>;
  /** Guarda una imagen pegada (bytes) en `~/.stratum/images/` y devuelve su ruta absoluta. */
  savePastedImage(bytes: number[]): Promise<string>;
  listModels(): Promise<unknown>;
  /** Sin `provider`, el modelo es del provider actual de la sesión. */
  setModel(sessionId: string, model: string, provider?: string): Promise<unknown>;
  closeSession(sessionId: string): Promise<unknown>;
  history(sessionId: string, before?: string, limit?: number): Promise<unknown>;
  context(sessionId: string): Promise<unknown>;
  memory(sessionId: string): Promise<unknown>;
  /** `skills.list` del asistente (agente fijo en el lado nativo). */
  listSkills(): Promise<unknown>;
  /** La memoria global del asistente (`memory.decisions`); el agente lo fija el lado nativo. */
  memoryDecisions(query?: string): Promise<unknown>;
  /** Olvidar una decisión del asistente (`memory.forget`). */
  memoryForget(decisionId: string): Promise<unknown>;
  prefs(): Promise<DesktopPrefs>;
  openConfig(): Promise<void>;
  approverStatus(): Promise<ApproverStatus>;
  /** Abre la ventana nativa de desbloqueo: la clave se teclea allí, no aquí. */
  unlockApprovals(): Promise<void>;
  lockApprovals(): Promise<void>;
  /** Abre la confirmación nativa; resuelve solo si la persona confirma allí. */
  approve(sessionId: string, approvalId: string, opts: { forSession: boolean }): Promise<void>;
  deny(sessionId: string, approvalId: string): Promise<void>;
  /** `null` omite la tanda (directo); con respuestas, confirmación nativa. */
  answerQuestions(sessionId: string, requestId: string, answers: QuestionAnswerInput[] | null): Promise<void>;
  /** Aprobar pasa por la confirmación nativa; rechazar va directo. */
  decidePlan(sessionId: string, requestId: string, decision: 'approve' | 'reject'): Promise<void>;
  onEvent(handler: (event: DesktopEvent) => void): Promise<() => void>;
}

/** Canal único nativo → interfaz: mantiene el orden entre fotos, eventos y estado. */
export const DESKTOP_EVENT = 'desktop://event';

export const tauriBridge: NativeBridge = {
  attach: () => invoke<AppInfo>('desktop_attach'),
  retry: () => invoke('desktop_retry'),
  focusSession: (sessionId) => invoke('desktop_focus_session', { sessionId }),
  resyncSession: (sessionId) => invoke('desktop_resync_session', { sessionId }),
  pauseRun: (sessionId, runId) => invoke<string>('desktop_pause_run', { sessionId, runId: runId ?? null }),
  resumeRun: (sessionId, runId) => invoke<string>('desktop_resume_run', { sessionId, runId: runId ?? null }),
  cancelRun: (sessionId, runId) => invoke<string>('desktop_cancel_run', { sessionId, runId: runId ?? null }),
  steerRun: (sessionId, text, images) => invoke<string>('desktop_steer_run', { sessionId, text, images }),
  newChat: (choice) =>
    invoke<unknown>('desktop_new_chat', { provider: choice?.provider ?? null, model: choice?.model ?? null }),
  startRun: (sessionId, input, images) => invoke<unknown>('desktop_start_run', { sessionId, input, images }),
  savePastedImage: (bytes) => invoke<string>('desktop_save_pasted_image', { bytes }),
  listModels: () => invoke<unknown>('desktop_list_models'),
  setModel: (sessionId, model, provider) =>
    invoke<unknown>('desktop_set_model', { sessionId, model, provider: provider ?? null }),
  closeSession: (sessionId) => invoke<unknown>('desktop_close_session', { sessionId }),
  history: (sessionId, before, limit) =>
    invoke<unknown>('desktop_history', { sessionId, before: before ?? null, limit: limit ?? null }),
  context: (sessionId) => invoke<unknown>('desktop_context', { sessionId }),
  memory: (sessionId) => invoke<unknown>('desktop_memory', { sessionId }),
  listSkills: () => invoke<unknown>('desktop_list_skills'),
  memoryDecisions: (query) => invoke<unknown>('desktop_memory_decisions', { query: query ?? null }),
  memoryForget: (decisionId) => invoke<unknown>('desktop_memory_forget', { decisionId }),
  prefs: () => invoke<DesktopPrefs>('desktop_prefs'),
  openConfig: () => invoke('desktop_open_config'),
  approverStatus: () => invoke<ApproverStatus>('desktop_approver_status'),
  unlockApprovals: () => invoke('desktop_approver_unlock'),
  lockApprovals: () => invoke('desktop_approver_lock'),
  approve: (sessionId, approvalId, { forSession }) => invoke('desktop_approve', { sessionId, approvalId, forSession }),
  deny: (sessionId, approvalId) => invoke('desktop_deny', { sessionId, approvalId }),
  answerQuestions: (sessionId, requestId, answers) =>
    invoke('desktop_answer_questions', { sessionId, requestId, answers }),
  decidePlan: (sessionId, requestId, decision) => invoke('desktop_decide_plan', { sessionId, requestId, decision }),
  onEvent: (handler) => listen<DesktopEvent>(DESKTOP_EVENT, (e) => handler(e.payload)),
};
