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
import type { NewProviderInput, SettingsChange, SettingsValue, SettingsView } from './settings';

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
  | { type: 'approver'; status: ApproverStatus }
  /**
   * Un lote de la traza de la sesión pedida con `traceSession`. Los registros
   * pasan sin interpretar (`unknown`): `reset` sustituye lo que se tuviera.
   */
  | { type: 'trace-records'; sessionId: string; reset: boolean; format: number; records: unknown[] }
  /** La traza pedida no se puede seguir (`code`/`reason` del daemon o del enlace). */
  | { type: 'trace-unavailable'; sessionId: string; code: string; reason: string | null };

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
  /**
   * De qué sesión se retransmite la traza (panel de trayectoria), o ninguna.
   * Solo una a la vez; al reconectar, el lado nativo la pide otra vez.
   */
  traceSession(sessionId: string | null): Promise<void>;
  pauseRun(sessionId: string, runId?: string): Promise<string>;
  resumeRun(sessionId: string, runId?: string): Promise<string>;
  cancelRun(sessionId: string, runId?: string): Promise<string>;
  /** `images`: rutas de imágenes que acompañan al mensaje (máx 5; vacío = ninguna). */
  steerRun(sessionId: string, text: string, images: string[]): Promise<string>;
  /** Conversación nueva con el asistente; sin elección, provider y modelo de la config. Resultado sin validar. */
  newChat(choice?: { provider: string; model: string }): Promise<unknown>;
  /** `opts.plan`: el run en modo plan (`runs.start` con `mode: 'plan'`). */
  startRun(
    sessionId: string,
    input: string,
    images: string[],
    opts?: { plan?: boolean },
  ): Promise<unknown>;
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
  /** M19 — mover un recuerdo a otra sección (`memory.reclassify`); el agente lo fija el lado nativo. */
  memoryMove(decisionId: string, section: string): Promise<unknown>;
  /** M19 fase 5 — las propuestas de dreaming pendientes (`memory.proposals`). */
  memoryProposals(): Promise<unknown>;
  /** M19 fase 5 — pedir una revisión (`memory.dream`): solo propone; gasta modelo. */
  memoryDream(force: boolean): Promise<unknown>;
  /** M19 fase 5 — aplicar una propuesta (`memory.applyProposal`): lo que cambia la memoria. */
  memoryApplyProposal(proposalId: string): Promise<unknown>;
  /** M19 fase 5 — rechazar una propuesta (`memory.rejectProposal`). */
  memoryRejectProposal(proposalId: string): Promise<unknown>;
  prefs(): Promise<DesktopPrefs>;
  openConfig(): Promise<void>;
  /** Los ajustes editables del `.stratumrc.json` global, con los secretos enmascarados. */
  settingsGet(): Promise<SettingsView>;
  /**
   * Cambia una clave. El nivel lo decide el lado nativo (`settings.rs`); el B abre
   * la ventana de confirmación y solo escribe si la persona confirma allí.
   */
  settingsSet(path: string, value: SettingsValue): Promise<SettingsChange>;
  /** Añade un provider (siempre con confirmación nativa). La clave no vuelve. */
  settingsAddProvider(provider: NewProviderInput): Promise<SettingsChange>;
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
  /** Modo código: el diálogo nativo de elegir una carpeta de proyecto; `null` si se cancela. */
  pickProjectFolder(): Promise<string | null>;
  /**
   * Modo código: una sesión del agente de código en `cwd` (absoluta y existente).
   * `agent` es un perfil de código (`assistant`/`companion` se rechazan sin enviar).
   * Resultado sin validar (`sessions.open`).
   */
  newCodeSession(opts: { cwd: string; agent?: string; provider?: string; model?: string }): Promise<unknown>;
  /** Modo código: los perfiles de agente (`agents.list`), con los del proyecto de `cwd`. */
  listAgents(cwd?: string): Promise<unknown>;
  /** Modo código: el perfil de agente de código de una sesión parada; `null` lo quita. */
  setAgent(sessionId: string, agent: string | null): Promise<unknown>;
  /** Modo código: solo lectura de una sesión parada (`sessions.setReadOnly`). */
  setReadOnly(sessionId: string, readOnly: boolean): Promise<unknown>;
  /** Modo código: el perfil de sesión de una sesión parada (`sessions.setProfile`). */
  setSessionProfile(sessionId: string, profile: string): Promise<unknown>;
  /** Modo código: cómo está montada la sesión (`sessions.inspect`); solo lectura. */
  inspectSession(sessionId: string): Promise<unknown>;
  /** Modo código: pregunta lateral (`sessions.ask`); nada entra en la conversación. */
  askSession(sessionId: string, question: string): Promise<unknown>;
  /** Modo código: los turnos que se pueden deshacer (`sessions.turns`); solo lectura. */
  sessionTurns(sessionId: string): Promise<unknown>;
  /** Modo código: pasa a job el comando en primer plano (`jobs.background`). */
  backgroundJobs(sessionId: string): Promise<unknown>;
  /** Modo código: las decisiones de la memoria del proyecto de esa sesión. */
  projectMemoryDecisions(sessionId: string, query?: string): Promise<unknown>;
  /** Modo código: olvidar una decisión de la memoria del proyecto de esa sesión. */
  projectMemoryForget(sessionId: string, decisionId: string): Promise<unknown>;
  /** Modo código: los `STRATUM.md` que ve esa sesión (`memory.documents`). */
  projectMemoryDocuments(sessionId: string): Promise<unknown>;
  /** Modo código: parar un job en segundo plano (`jobs.cancel`). */
  cancelJob(sessionId: string, jobId: string): Promise<unknown>;
  /** Modo código: los cambios del working tree del proyecto (`git.changes`). */
  gitChanges(sessionId: string): Promise<unknown>;
  /** Modo código: el diff de un fichero de `gitChanges` (`git.diff`), ya redactado. */
  gitDiff(sessionId: string, path: string): Promise<unknown>;
  /** Modo código: el navegador del agente de la sesión y su pestaña en JPEG (`browser.screen`). */
  browserScreen(sessionId: string): Promise<unknown>;
  /**
   * Modo código: mover ese navegador (`browser.navigate`), con la sesión en
   * reposo; `goto` solo a lo local o ya aprobado (aprobar no es de aquí).
   */
  browserNavigate(
    sessionId: string,
    action: 'goto' | 'back' | 'forward' | 'reload',
    url?: string,
  ): Promise<unknown>;
  /**
   * Modo código: qué haría deshacer los últimos `turns` (1–20) turnos
   * (`sessions.revert` con `dryRun`). No toca nada, pero exige las aprobaciones
   * desbloqueadas: el daemon solo lo calcula con la autoridad de aprobar.
   */
  revertPlan(sessionId: string, turns: number): Promise<unknown>;
  /**
   * Modo código: deshacer los ficheros de los últimos `turns` turnos. Abre la
   * confirmación nativa con el plan que lee el lado nativo del daemon; con
   * conflictos o sin nada que deshacer, no se abre y vuelve esa respuesta. Nunca fuerza.
   */
  revert(sessionId: string, turns: number): Promise<unknown>;
  onEvent(handler: (event: DesktopEvent) => void): Promise<() => void>;
}

/** Canal único nativo → interfaz: mantiene el orden entre fotos, eventos y estado. */
export const DESKTOP_EVENT = 'desktop://event';

export const tauriBridge: NativeBridge = {
  attach: () => invoke<AppInfo>('desktop_attach'),
  retry: () => invoke('desktop_retry'),
  focusSession: (sessionId) => invoke('desktop_focus_session', { sessionId }),
  resyncSession: (sessionId) => invoke('desktop_resync_session', { sessionId }),
  traceSession: (sessionId) => invoke('desktop_trace_session', { sessionId }),
  pauseRun: (sessionId, runId) => invoke<string>('desktop_pause_run', { sessionId, runId: runId ?? null }),
  resumeRun: (sessionId, runId) => invoke<string>('desktop_resume_run', { sessionId, runId: runId ?? null }),
  cancelRun: (sessionId, runId) => invoke<string>('desktop_cancel_run', { sessionId, runId: runId ?? null }),
  steerRun: (sessionId, text, images) => invoke<string>('desktop_steer_run', { sessionId, text, images }),
  newChat: (choice) =>
    invoke<unknown>('desktop_new_chat', { provider: choice?.provider ?? null, model: choice?.model ?? null }),
  startRun: (sessionId, input, images, opts) =>
    invoke<unknown>('desktop_start_run', { sessionId, input, images, plan: opts?.plan ?? null }),
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
  memoryMove: (decisionId, section) =>
    invoke<unknown>('desktop_memory_reclassify', { decisionId, section }),
  memoryProposals: () => invoke<unknown>('desktop_memory_proposals'),
  memoryDream: (force) => invoke<unknown>('desktop_memory_dream', { force }),
  memoryApplyProposal: (proposalId) =>
    invoke<unknown>('desktop_memory_apply_proposal', { proposalId }),
  memoryRejectProposal: (proposalId) =>
    invoke<unknown>('desktop_memory_reject_proposal', { proposalId }),
  prefs: () => invoke<DesktopPrefs>('desktop_prefs'),
  openConfig: () => invoke('desktop_open_config'),
  settingsGet: () => invoke<SettingsView>('desktop_settings_get'),
  settingsSet: (path, value) => invoke<SettingsChange>('desktop_settings_set', { path, value }),
  settingsAddProvider: (provider) => invoke<SettingsChange>('desktop_settings_add_provider', { provider }),
  approverStatus: () => invoke<ApproverStatus>('desktop_approver_status'),
  unlockApprovals: () => invoke('desktop_approver_unlock'),
  lockApprovals: () => invoke('desktop_approver_lock'),
  approve: (sessionId, approvalId, { forSession }) => invoke('desktop_approve', { sessionId, approvalId, forSession }),
  deny: (sessionId, approvalId) => invoke('desktop_deny', { sessionId, approvalId }),
  answerQuestions: (sessionId, requestId, answers) =>
    invoke('desktop_answer_questions', { sessionId, requestId, answers }),
  decidePlan: (sessionId, requestId, decision) => invoke('desktop_decide_plan', { sessionId, requestId, decision }),
  pickProjectFolder: () => invoke<string | null>('desktop_pick_project_folder'),
  newCodeSession: ({ cwd, agent, provider, model }) =>
    invoke<unknown>('desktop_new_code_session', {
      cwd,
      agent: agent ?? null,
      provider: provider ?? null,
      model: model ?? null,
    }),
  listAgents: (cwd) => invoke<unknown>('desktop_list_agents', { cwd: cwd ?? null }),
  setAgent: (sessionId, agent) => invoke<unknown>('desktop_set_agent', { sessionId, agent }),
  setReadOnly: (sessionId, readOnly) => invoke<unknown>('desktop_set_read_only', { sessionId, readOnly }),
  setSessionProfile: (sessionId, profile) =>
    invoke<unknown>('desktop_set_session_profile', { sessionId, profile }),
  inspectSession: (sessionId) => invoke<unknown>('desktop_inspect_session', { sessionId }),
  askSession: (sessionId, question) => invoke<unknown>('desktop_ask_session', { sessionId, question }),
  sessionTurns: (sessionId) => invoke<unknown>('desktop_session_turns', { sessionId }),
  backgroundJobs: (sessionId) => invoke<unknown>('desktop_background_jobs', { sessionId }),
  projectMemoryDecisions: (sessionId, query) =>
    invoke<unknown>('desktop_project_memory_decisions', { sessionId, query: query ?? null }),
  projectMemoryForget: (sessionId, decisionId) =>
    invoke<unknown>('desktop_project_memory_forget', { sessionId, decisionId }),
  projectMemoryDocuments: (sessionId) => invoke<unknown>('desktop_project_memory_documents', { sessionId }),
  cancelJob: (sessionId, jobId) => invoke<unknown>('desktop_cancel_job', { sessionId, jobId }),
  gitChanges: (sessionId) => invoke<unknown>('desktop_git_changes', { sessionId }),
  gitDiff: (sessionId, path) => invoke<unknown>('desktop_git_diff', { sessionId, path }),
  browserScreen: (sessionId) => invoke<unknown>('desktop_browser_screen', { sessionId }),
  browserNavigate: (sessionId, action, url) =>
    invoke<unknown>('desktop_browser_navigate', { sessionId, action, url: url ?? null }),
  revertPlan: (sessionId, turns) => invoke<unknown>('desktop_revert_plan', { sessionId, turns }),
  revert: (sessionId, turns) => invoke<unknown>('desktop_revert', { sessionId, turns }),
  onEvent: (handler) => listen<DesktopEvent>(DESKTOP_EVENT, (e) => handler(e.payload)),
};
