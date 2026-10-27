import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { IProvider } from '../providers/base.js';
import type {
  AgentEvent,
  AgentProfile,
  DiagnosticsProvider,
  Message,
  RunOptions,
  SubagentResult,
  TokenAccounting,
  TokenStatus,
  WorkspaceConfinement,
} from './types.js';
import { ReactLoop, ContextManager } from './harness.js';
import type { CompressionResult } from './harness.js';
import { emptyTurnUsage, sumUsage, type SessionUsageSnapshot, type TurnUsage } from './usage.js';
import {
  buildAgentProfilesBlock,
  buildSystemPrompt,
  findWorktreeRoot,
  type SystemPromptEnv,
} from './system-prompt.js';
import { prepareGuideIndex } from './guides.js';
import {
  ProfileLoader,
  describeProfile,
  isPrimaryCapable,
  type InvalidProfile,
  type ProfileWarning,
} from './profiles.js';
import { executeDelegations, resolveDelegationProfile } from './delegation.js';
import { generateSubagentId, serializeSubagentResult } from './subagent.js';
import { truncateToolOutput } from '../tools/truncate.js';
import { DELEGATE_TASK_TOOL } from '../tools/agent/delegate.js';
import { ChangeTracker } from './risk.js';
import { FileStateTracker } from '../tools/fs/file-state.js';
import { JobManager } from '../jobs/manager.js';
import { sessionSkills, type SkillRegistry } from '../skills/registry.js';
import { READ_SKILL_TOOL } from '../tools/skills/read-skill.js';
import { TodoList, rehydrateTodos } from './todo.js';
import { closeDanglingToolCalls, pushUserInput } from './cancel.js';
import { SIDE_QUESTION_TIMEOUT_MS, sideQuestionMessages } from './side-question.js';
import {
  RuntimeInbox,
  formatUndeliveredUserMessages,
  type SteeringEnqueueResult,
} from './inbox.js';
import { PauseController } from './pause.js';
import { SnapshotStore } from '../snapshots/store.js';
import type { RevertPlan, RevertResult } from '../snapshots/store.js';
import type { TurnRecord } from '../snapshots/registry.js';
import { formatFilesReverted } from '../snapshots/store.js';
import { TddLedger, rehydrateTdd } from './tdd.js';
import { TEST_EVIDENCE_TOOL } from '../tools/tdd.js';
import type { TodoItem } from './todo.js';
import { resolve as resolvePath, relative as relativePath, sep as pathSep } from 'path';
import { LspManager } from '../lsp/manager.js';
import { resolveLspServers } from '../lsp/presets.js';
import { formatDiagnostics } from '../lsp/format.js';
import { MemoryManager } from '../memory/manager.js';
import { assistantToolsetFilter, type PromptPreset } from './presets.js';
import { composeToolsetFilters } from '../tools/registry.js';
import {
  profileAllows,
  resolveSessionProfile,
  sessionProfileFilter,
  type InfraDetection,
  type SessionProfile,
} from './session-profile.js';
import {
  resolveEnvironment,
  targetOfCall,
  type ResolvedEnvironment,
} from '../tools/environments.js';
import { extractAndStore } from '../memory/extractor.js';
import type { TraceScope } from '../trace/recorder.js';
import { tracedCompletion } from '../trace/llm-call.js';
import { processSessionEnv, type SessionEnv } from '../runtime/session-env.js';
import { getLogger } from '../logging/index.js';
import type {
  ConversationStats,
  SessionConversation,
} from '../conversation/session-conversation.js';
import { resolveMemoryModels } from '../conversation/models.js';
import {
  applySessionMemoryBlock,
  charsToTokens,
  clipMemoryLayer,
  contextBreakdown,
  resolveContextBudget,
  tokensToChars,
  type ContextBreakdown,
  type ContextBudget,
} from './context-builder.js';
import type { SessionCompactor } from './harness.js';

const log = getLogger('agent');

export interface StratumAgentOptions {
  /**
   * Entorno de la sesión: directorio de trabajo y variables con las que lanza
   * procesos. Lo aporta quien aloja la sesión (`SessionHost`). Sin él se usa el
   * del proceso, que es lo que corresponde a una CLI de una sola sesión.
   */
  env?: SessionEnv;
  /** Mensajes iniciales para reanudar una sesión guardada (incluye el system prompt original). */
  initialMessages?: Message[];
  /**
   * Preámbulo de reanudación de plan (§12.6, Hito 7). Si se pasa, se inyecta
   * como mensaje de usuario tras el historial para que el agente continúe un
   * plan que quedó `in_progress` en una sesión previa.
   */
  resumePreamble?: string;
  /** Referencia al fichero de plan asociado a la sesión reanudada. */
  planRef?: string;
  /** Plan completo a reanudar (§12.6). Expuesto vía getResumePlan() para inicializar la UI. */
  resumePlan?: import('./types.js').Plan;
  /** Tarea original del plan reanudado (para re-persistir actualizaciones de pasos). */
  resumeTask?: string;
  /** ISO 8601 de creación del plan reanudado (preservado en las escrituras sucesivas). */
  resumeCreatedAt?: string;
  /** Proyecto donde vive el fichero del plan reanudado (el de la sesión, no el cwd). */
  resumePlanRoot?: string;
  /**
   * Perfil activo como agente principal en la sesión reanudada (Hito 15). Se
   * reaplica recomponiendo el system prompt; si el perfil ya no es válido, se
   * vuelve al prompt base y el aviso queda en `takeResumeNotice()`.
   */
  activeAgent?: string;
  /**
   * Loader de perfiles ya construido. Punto de inyección para tests: el de
   * producción lee `~/.stratum/agents` y los roots del cwd.
   */
  profileLoader?: ProfileLoader;
  /**
   * Preset del prompt y del toolset (Stratum Desktop D1). Default `coding`: la
   * CLI no cambia. `assistant` es el asistente del modo Chat — sin skills, sin
   * perfiles, sin `STRATUM.md` de proyecto y con el toolset de `ASSISTANT_TOOLS`.
   */
  promptPreset?: PromptPreset;
  /**
   * Workspace de la conversación (Stratum Desktop D2, solo con el preset
   * `assistant`). Confina las tools de fichero, añade el bloque `# Workspace`
   * al prompt y habilita las tools de `ASSISTANT_FILE_TOOLS`.
   */
  workspace?: WorkspaceConfinement;
  /**
   * Los ficheros del workspace anteriores a esta fecha (ISO) se purgaron por
   * retención (Stratum Desktop D3). El bloque `# Workspace` lo dice, para que
   * el agente no intente leer rutas que aparecen antes en el historial.
   */
  workspaceFilesExpiredAt?: string;
  /**
   * Hito 17 — arrancar en modo read-only (`--read-only`, sesión reanudada que
   * lo era). Se alterna después con `setReadOnly`.
   */
  readOnly?: boolean;
  /**
   * Hito 17 — perfil de sesión pedido (`--infra`, `--code`, `--profile`). Sin
   * él, `session.profile` de la config (default `auto`). Un nombre que no existe
   * cae a `auto` con aviso en `takeResumeNotice()`.
   */
  sessionProfile?: string;
  /**
   * Contadores de una sesión que continúa: en otro anfitrión (M10, traspaso al
   * daemon) o reanudada (`chat --resume`). Los tokens, solo si el backend los
   * había reportado: nunca se estiman.
   */
  usage?: SessionUsageSnapshot;
  /**
   * M11 — conversación duradera de la sesión: su `ConversationStore`, su
   * memoria de sesión y el estado de su contexto. Con ella el historial se
   * registra en el store, lo antiguo se compacta a la memoria de sesión (si
   * `memory.session.enabled`) y el contexto tiene presupuesto por capas. Con
   * `restore`, el historial activo se reconstruye desde el store en vez de
   * empezar vacío (sesión recuperada tras reiniciar el daemon).
   */
  conversation?: { conversation: SessionConversation; restore?: boolean };
  /**
   * UX-1 — id de sesión estable. Es la clave del índice y del registro de
   * turnos de `~/.stratum/snapshots/<id>/`: sin él los snapshots quedan
   * desactivados (no hay forma de no mezclar dos sesiones del mismo proyecto).
   */
  sessionId?: string;
  /**
   * UX-1 — `false` desactiva deshacer por turno en este agente. Lo usa
   * `stratum init`, que es una operación de un solo uso sobre el proyecto.
   */
  snapshots?: false;
  /**
   * UX-1 — home inyectable para el almacén de snapshots. Solo para tests: en
   * producción se usa el del proceso (nunca se escribe en el proyecto).
   */
  snapshotsHome?: string;
}

/** Lo que se sabe del contexto de una sesión: presupuesto, desglose y conversación. */
export interface ContextReport {
  budget: ContextBudget;
  breakdown: ContextBreakdown;
  /** `null` en una sesión sin `ConversationStore`. */
  conversation: ConversationStats | null;
  /** ¿Compacta esta sesión a la memoria de sesión? */
  sessionMemory: boolean;
}

/** Qué abrió un turno: una entrada al agente principal o una delegación directa (`@perfil`). */
export type AgentTurnKind = 'run' | 'delegate';

/**
 * Lo que ve un observador del agente (`StratumAgent.observe`). No es un
 * `AgentEvent` nuevo: los límites del turno no viajan por el generador, y
 * añadirlos al schema de eventos cambiaría lo que consumen las interfaces.
 */
export type AgentObservation =
  | { type: 'turn_started'; kind: AgentTurnKind; input: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'turn_ended'; kind: AgentTurnKind; stopReason: string | null };

export type AgentObserver = (observation: AgentObservation) => void;

export class StratumAgent {
  private messages: Message[];
  private currentLoop: ReactLoop | null = null;
  /** `ContextManager` de sesión (ver `getContextManager`). */
  private contextManager: ContextManager | null = null;
  private contextManagerKey = '';
  /** Trabajo en segundo plano en vuelo (extracción de memoria) y su cancelación. */
  private readonly background = new Set<Promise<void>>();
  private backgroundAbort = new AbortController();
  private readonly memoryManager: MemoryManager;
  /** Perfiles de subagente (Hito 8): descubiertos al arrancar, pasados al loop. */
  private readonly profiles: ProfileLoader;
  private _toolCallCount = 0;
  /**
   * Lista de tareas de la sesion (Hito 11). Vive aqui y no en el `ReactLoop`
   * porque el loop dura un solo turno y la deteccion de staleness cuenta turnos.
   */
  private readonly todos = new TodoList();
  /**
   * Write-log de la sesión (Hito 12). Vive aquí por la misma razón que la lista
   * de tareas: el loop dura un turno y el aviso mide el cambio acumulado.
   */
  private readonly changes = new ChangeTracker();
  /**
   * Evidencia del ciclo TDD (Hito 13). Igual que la lista de tareas: el ciclo
   * abarca varios turnos, así que el registro no puede vivir en el loop.
   */
  private readonly tdd = new TddLedger();
  /** Versión de cada fichero leída por el agente: protege `write_file` de pisar cambios ajenos. */
  private readonly fileState = new FileStateTracker();
  /**
   * Language servers de la sesión (UX-2b). Solo si `lsp.enabled` y hay
   * servidores: arranque perezoso, y un fallo desactiva el servidor para el
   * resto de la sesión sin romper nada.
   */
  private readonly lsp: LspManager | undefined;
  /** Lo que ve `ToolContext.diagnostics`: pide diagnósticos y los formatea. */
  private readonly diagnosticsProvider: DiagnosticsProvider | undefined;
  /**
   * Jobs en segundo plano de la sesión (`exec` con `background: true`). De
   * sesión, como la lista de tareas: un job sobrevive al turno que lo lanzó.
   * La UI se suscribe aquí para pintarlos. `undefined` si están desactivados o
   * en el preset `assistant` (Desktop no ofrece `exec`).
   */
  readonly jobs: JobManager | undefined;
  /**
   * Runtime Inbox de la sesión: lo que llega mientras el agente trabaja
   * (mensajes del usuario, finales de job). De sesión, como los jobs; la UI se
   * suscribe aquí para pintar lo pendiente.
   */
  readonly inbox = new RuntimeInbox();
  /**
   * Pausa cooperativa del run en curso. De sesión, como la inbox, y **la única**
   * autoridad de pausa: la consultan el loop del agente, los de sus subagentes
   * y el dispatcher. Quien aloja la sesión pide y retira la pausa aquí.
   */
  readonly pause = new PauseController();
  /** Observadores de la actividad del agente (`observe`). */
  private readonly observers = new Set<AgentObserver>();
  /**
   * Skills de la sesión (Hito 12): se descubren una vez y los hijos heredan el
   * mismo registro. Es además el conjunto cerrado que `read_skill` sirve.
   */
  private readonly skills: SkillRegistry | undefined;
  /** Índice `# Skills` del system prompt, renderizado de `skills`. */
  private readonly skillsBlock: string;
  /**
   * Contabilidad de tokens de la sesión (Hito 13). El `ReactLoop` vive un turno,
   * así que el acumulado se suma aquí. El estado se guarda aparte del número:
   * un 0 sin estado no distingue «no gastó nada» de «el backend no lo dice».
   */
  private _sessionTokens = 0;
  private _tokenStatus: TokenStatus = 'unavailable';
  /**
   * Uso por turno (UX-3): el del último turno cerrado y el acumulado de la
   * sesión. `_sessionTurns` cuenta turnos cerrados, aunque el backend no haya
   * reportado tokens: son turnos reales, con su tiempo y sus llamadas.
   */
  private _lastTurnUsage: TurnUsage | null = null;
  private _sessionUsage: TurnUsage = emptyTurnUsage();
  private _sessionTurns = 0;
  /** Ref al fichero de plan activo (Hito 7), para persistir el `planRef` de la sesión. */
  private _planRef: string | null = null;
  /** Plan reanudado (§12.6): expuesto una sola vez a la UI al init, luego se borra. */
  private _resumePlan: import('./types.js').Plan | null = null;
  private _resumeTask: string | null = null;
  private _resumeCreatedAt: string | null = null;
  private _resumePlanRoot: string | null = null;
  /**
   * Perfil activo como agente principal (Hito 15, `/agent <perfil>`). Cambia el
   * system prompt y restringe el toolset; no el provider ni el modelo.
   */
  private _activeProfile: AgentProfile | null = null;
  /** Aviso de un solo uso al reanudar con un perfil que ya no se puede activar. */
  private _resumeNotice: string | null = null;
  private readonly preset: PromptPreset;
  /** Hito 17 — modo read-only de la sesión (`/readonly`). */
  private _readOnly = false;
  /** Hito 17 — perfil de sesión (§10.5). `null` con el preset `assistant`. */
  private _sessionProfile: SessionProfile | null = null;
  private _sessionProfileRequest = 'auto';
  private _profileDetection: InfraDetection | null = null;
  /**
   * Hito 17 — último target sobre el que se ejecutó algo. Es el «contexto
   * activo» del badge de entorno: el accidente clásico es escribir bien el
   * comando en la ventana equivocada.
   */
  private _activeTarget = 'local';
  private readonly workspace: WorkspaceConfinement | undefined;
  private readonly workspaceFilesExpiredAt: string | undefined;
  /** Entorno de la sesión: el único origen del directorio de trabajo en esta clase. */
  private readonly env: SessionEnv;
  /** M11 — conversación duradera de la sesión, si la tiene. */
  private readonly conversation: SessionConversation | null;
  /** Caracteres de las capas de memoria global y de proyecto en el system prompt. */
  private memoryLayerChars = { global: 0, project: 0 };
  /**
   * UX-1 — almacén de snapshots de la sesión, abierto perezosamente en el
   * primer turno (`SnapshotStore.open` es async y hace I/O de git). `null` es
   * «deshacer no está disponible»: sin `sessionId`, con `snapshots: false`, sin
   * repo git o con el registro incompatible.
   */
  private snapshotStore: SnapshotStore | null = null;
  /**
   * Apertura en vuelo. Se cachea la promesa (no un flag «ya intentado») para
   * que dos llamadas concurrentes —un `runTurn` y un `getUndoableTurns` de la
   * UI— compartan el mismo `open` y ningún turno se quede sin snapshot.
   */
  private snapshotOpening?: Promise<SnapshotStore | null>;
  private readonly snapshotsEnabled: boolean;
  private readonly snapshotsSessionId: string | null;
  private readonly snapshotsHome: string | undefined;
  /** Texto `<files_reverted>` pendiente de anteponer a la siguiente entrada. */
  private revertNotice: string | null = null;

  constructor(
    private readonly config: StratumConfig,
    private readonly router: ProviderRouter,
    private readonly registry: ToolRegistry,
    options?: StratumAgentOptions,
  ) {
    this.env = options?.env ?? processSessionEnv();
    this.conversation = options?.conversation?.conversation ?? null;
    // UX-1: el almacén de snapshots necesita un id de sesión estable; sin él
    // deshacer queda desactivado en vez de mezclar turnos de dos sesiones.
    this.snapshotsEnabled = options?.snapshots !== false;
    this.snapshotsSessionId = options?.sessionId ?? null;
    this.snapshotsHome = options?.snapshotsHome;
    const cwd = this.env.cwd;
    this.preset = options?.promptPreset ?? 'coding';
    // El agente de código solo ve el proyecto; el asistente, solo lo global.
    this.memoryManager = new MemoryManager(
      config,
      cwd,
      this.preset === 'assistant' ? 'global' : 'project',
    );
    this.jobs =
      this.preset === 'coding' && config.tools.jobs.enabled ? new JobManager(config) : undefined;
    if (this.jobs) this.inbox.attachJobs(this.jobs);
    this.workspace = options?.workspace;
    this.workspaceFilesExpiredAt = options?.workspaceFilesExpiredAt;
    // UX-2b: language servers, solo si la config lo pide. La raíz es la misma
    // que ve el modelo como `cwd` (el workspace de Desktop, si lo hay).
    const lspRoot = this.workspace?.root ?? cwd;
    const lspServers = config.lsp.enabled ? resolveLspServers(config.lsp.servers) : [];
    const lsp =
      lspServers.length > 0
        ? new LspManager({
            servers: lspServers,
            cwd: lspRoot,
            timeoutMs: config.lsp.timeoutMs,
            startupTimeoutMs: config.lsp.startupTimeoutMs,
          })
        : undefined;
    this.lsp = lsp;
    this.diagnosticsProvider =
      lsp === undefined
        ? undefined
        : {
            diagnose: async (absPath, text, signal) => {
              const report = await lsp.diagnose(absPath, text, signal);
              if (report === null) return null;
              return formatDiagnostics(report, {
                maxDiagnostics: config.lsp.maxDiagnostics,
                severity: config.lsp.severity,
                // Igual que el nombre con el que el modelo llamó a la tool.
                displayPath: relativePath(lspRoot, absPath).split(pathSep).join('/'),
              });
            },
          };
    this._readOnly = options?.readOnly === true;
    // Hito 17: el perfil de sesión decide bloques del prompt, así que se
    // resuelve antes de componerlo. El asistente de Desktop no tiene perfil.
    if (this.preset === 'coding') {
      const applied = this.applySessionProfile(options?.sessionProfile);
      if (!applied.ok) {
        this._resumeNotice = `Perfil de sesión: ${applied.error} Se usa 'auto'.`;
        this.applySessionProfile('auto');
      }
    }
    // Perfiles de subagente desde la raíz del worktree git Y el cwd: la raíz del
    // worktree cubre la invocación desde un subdirectorio del repo (consistente
    // con el `<env>`); el cwd cubre el caso en que el proyecto npm vive en un
    // subdirectorio del repo (p.ej. `stratum-cli/.stratum/agents/`). El cwd gana
    // en conflictos por ser el más específico. Si coinciden, se carga una vez.
    this.profiles =
      options?.profileLoader ?? new ProfileLoader([findWorktreeRoot(cwd).worktree, cwd]);

    // Skills (Hito 12): mismos roots que los perfiles, más las de serie. El
    // índice entra en el system prompt; el cuerpo de cada skill se lee bajo
    // demanda con `read_skill`. La tabla materializada en disco es auditable y
    // sirve de caché: si el fingerprint no cambia, no se reescribe.
    // El asistente solo ve las de serie que declaran `assistant`: no trabaja
    // en un proyecto, y nunca materializa la tabla (escribiría en su carpeta).
    if (config.skills.enabled) {
      this.skills = sessionSkills(config, this.preset, cwd);
      this.skillsBlock = this.skills.promptBlock();
      if (this.preset === 'coding') {
        this.skills.writeRegistryFile(resolvePath(cwd, config.skills.registryFile));
      }
    } else {
      this.skills = undefined;
      this.skillsBlock = '';
    }
    // Sin ninguna skill que servir, `read_skill` sobra: su schema solo gastaría
    // contexto en cada petición.
    if (!this.skills || this.skills.entries.length === 0) {
      registry.disableForSession(READ_SKILL_TOOL);
    }

    if (options?.usage) this.restoreUsage(options.usage);
    if (options?.planRef) this._planRef = options.planRef;
    if (options?.resumePlan) {
      this._resumePlan = options.resumePlan;
      this._resumeTask = options.resumeTask ?? null;
      this._resumeCreatedAt = options.resumeCreatedAt ?? null;
      this._resumePlanRoot = options.resumePlanRoot ?? null;
    }

    if (this.conversation && options?.conversation?.restore) {
      // M11 — sesión recuperada: system prompt recompuesto aquí (entorno y
      // perfil de este proceso) + el contexto activo que había, desde el store.
      this.messages = [
        { role: 'system', content: this.buildSystemContent() },
        ...this.conversation.restoreActive(),
      ];
      this.todos.replace(rehydrateTodos(this.messages));
      this.tdd.replace(rehydrateTdd(this.messages, TEST_EVIDENCE_TOOL));
    } else if (options?.initialMessages && options.initialMessages.length > 0) {
      // Reanudar sesión: usar historial completo tal como fue guardado
      this.messages = [...options.initialMessages];
      // Hito 11: el estado de la lista viaja en el historial (cada tool result
      // lleva el snapshot completo), asi que reanudar no necesita store propio.
      this.todos.replace(rehydrateTodos(this.messages));
      this.tdd.replace(rehydrateTdd(this.messages, TEST_EVIDENCE_TOOL));
      // Reanudación de plan interrumpido (§12.6): inyectar el estado de los pasos.
      if (options.resumePreamble) {
        this.messages.push({ role: 'user', content: options.resumePreamble });
      }
      // El asistente nunca conserva el system prompt guardado: una sesión de
      // otro modo, de una versión anterior o editada a mano podría traer el
      // prompt de código (16.6). Se conserva el historial y se recompone el
      // system prompt desde el preset actual.
      if (this.preset === 'assistant') {
        this.messages = this.messages.filter((m) => m.role !== 'system');
        this.rebuildSystemPrompt();
      }
    } else {
      // Nueva sesión: construir system prompt con memoria del proyecto
      this.messages = [{ role: 'system', content: this.buildSystemContent() }];
    }

    // Hito 15: el system prompt guardado ya llevaba el bloque del perfil, pero
    // se recompone igualmente — el fichero del perfil pudo cambiar, y si ya no
    // se puede activar, dejar el bloque viejo sería mentirle al modelo sobre
    // qué tools tiene.
    if (options?.activeAgent) {
      const applied = this.setPrimaryProfile(options.activeAgent);
      if (!applied.ok) {
        this._resumeNotice =
          `No se pudo reactivar el perfil '${options.activeAgent}': ${applied.error} ` +
          'Se continúa con el agente por defecto.';
        this.rebuildSystemPrompt();
      }
    }

    // M11 — lo que trae la sesión (un traspaso, una recuperación) queda en el
    // store desde ya, y la memoria de sesión en el system prompt.
    if (this.conversation) {
      this.applySessionMemory();
      try {
        this.conversation.saveState(this.messages);
      } catch (err) {
        log.warn('conversation not recorded', { err });
      }
    }
  }

  /** ¿Compacta esta sesión a la memoria de sesión? */
  private get sessionMemoryEnabled(): boolean {
    return this.conversation !== null && this.config.memory.session.enabled;
  }

  /** Presupuesto del contexto para el modelo activo. */
  private contextBudget(): ContextBudget {
    return resolveContextBudget(this.config, this.router.contextWindow);
  }

  /** Pone la memoria de sesión vigente en el system prompt (idempotente). */
  private applySessionMemory(): void {
    if (!this.sessionMemoryEnabled || !this.conversation) return;
    const max = tokensToChars(this.contextBudget().sessionMemory);
    applySessionMemoryBlock(this.messages, this.conversation.renderMemory(max));
  }

  /** Tokens estimados de las definiciones de tools que se envían. */
  private toolSchemaChars(): number {
    try {
      return JSON.stringify(this.registry.toToolSchemas('normal')).length;
    } catch {
      return 0;
    }
  }

  /**
   * Lo que el `ContextManager` usa para compactar a la memoria de sesión. Los
   * modelos de memoria se resuelven en cada compactación: `same` sigue al
   * modelo que tenga la sesión en ese momento.
   */
  private sessionCompactor(): SessionCompactor | null {
    const conversation = this.conversation;
    if (!conversation || !this.sessionMemoryEnabled) return null;
    return {
      budget: () => this.contextBudget(),
      overheadTokens: () => Math.ceil(this.toolSchemaChars() / 3.5),
      record: (messages) => conversation.record(messages),
      compact: (chunk, tokens, signal, trace) =>
        conversation.compact({
          chunk,
          models: resolveMemoryModels(this.config, this.router),
          timeoutMs: this.config.memory.session.timeoutMs,
          tokensBefore: tokens.before,
          tokensAfter: tokens.after,
          ...(signal ? { signal } : {}),
          ...(trace ? { trace } : {}),
        }),
      applyMemory: (messages) => {
        const max = tokensToChars(this.contextBudget().sessionMemory);
        applySessionMemoryBlock(messages, conversation.renderMemory(max));
      },
      committed: (messages) => conversation.saveState(messages),
    };
  }

  /**
   * M11 — presupuesto, desglose del contexto que se enviaría ahora (tokens
   * **estimados**) y estado de la conversación. Para la observabilidad
   * (`sessions.context`): no decide nada.
   */
  getContextReport(): ContextReport {
    const budget = this.contextBudget();
    const toolsChars = this.toolSchemaChars();
    // `prompt_tokens` cuenta mensajes **y** tools; el factor del ContextManager
    // se calibró solo contra los mensajes. Para repartir por capas, el factor
    // sale de dividir entre los dos proxies, o las tools contarían dos veces.
    const sample = this.getContextManager().lastCalibration;
    const proxy = sample ? sample.proxyTokens + charsToTokens(toolsChars) : 0;
    const breakdown = contextBreakdown(this.messages, {
      budget,
      globalMemoryChars: this.memoryLayerChars.global,
      projectMemoryChars: this.memoryLayerChars.project,
      toolsChars,
      ratio: sample && proxy > 0 ? sample.promptTokens / proxy : 1,
    });
    return {
      budget,
      breakdown,
      conversation: this.conversation?.stats(breakdown.activeMessages) ?? null,
      sessionMemory: this.sessionMemoryEnabled,
    };
  }

  /**
   * Fracción de la ventana a la que se comprime en línea en un turno normal
   * (`agent.compressionThreshold`; `/init` la sube solo durante su turno). Con
   * memoria de sesión manda `budget.compactAt` sobre la entrada útil.
   */
  get compressionThreshold(): number {
    return this.config.agent.compressionThreshold;
  }

  /** La conversación duradera de la sesión, si la tiene (M11). */
  getConversation(): SessionConversation | null {
    return this.conversation;
  }

  /**
   * Mensaje del usuario con un turno en curso (*steering*). No cancela nada ni
   * llama al modelo: queda en la Runtime Inbox y el loop lo incorpora en su
   * siguiente punto seguro. Solo `accepted` guarda algo: `not-accepting` (no
   * hay turno, o ya ha dado su respuesta por terminada) es un turno nuevo con
   * `run()`, y `too-large` se le devuelve al usuario sin recortar ni enviar.
   *
   * Cancelar es otro camino: el `AbortSignal` del turno. Aquí no se interpreta
   * el texto.
   */
  enqueueUserMessage(text: string): SteeringEnqueueResult {
    return this.inbox.enqueueUserMessage(text);
  }

  /** ¿Hay un turno que incorporaría ahora un mensaje del usuario como steering? */
  get acceptsSteering(): boolean {
    return this.inbox.acceptsSteering;
  }

  /**
   * Observa la actividad del agente: el principio y el final de cada turno y
   * todos los `AgentEvent` que emiten `run()` y `runDelegate()`, **además** de
   * devolverlos a quien consume el generador. Es el punto único por el que un
   * anfitrión publica lo que ocurre en la sesión sin ser quien la conduce.
   *
   * Un observador no puede alterar el turno: se le llama de forma síncrona, su
   * valor de retorno se ignora y una excepción suya se registra y se descarta.
   * Devuelve la función que lo retira.
   */
  observe(observer: AgentObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private notify(observation: AgentObservation): void {
    for (const observer of this.observers) {
      try {
        observer(observation);
      } catch (err) {
        log.warn('agent observer failed', { type: observation.type, err });
      }
    }
  }

  /** Envuelve un turno para que los observadores lo vean entero, también si se abandona. */
  private async *observed(
    kind: AgentTurnKind,
    input: string,
    turn: AsyncGenerator<AgentEvent>,
    trace?: TraceScope,
  ): AsyncGenerator<AgentEvent> {
    // Desde aquí hay un run que pausar; la pausa es suya y termina con él.
    this.pause.begin();
    const untrace = this.tracePause(trace);
    this.notify({ type: 'turn_started', kind, input });
    let stopReason: string | null = null;
    try {
      for await (const event of turn) {
        if (event.type === 'done') stopReason = event.stopReason;
        this.notify({ type: 'event', event });
        yield event;
      }
    } finally {
      // Antes de dar el turno por cerrado: ninguna espera de pausa lo sobrevive.
      untrace();
      this.pause.end();
      this.notify({ type: 'turn_ended', kind, stopReason });
    }
  }

  /** La pausa del turno, en su traza: cuándo se pidió, se alcanzó y se retiró. */
  private tracePause(trace: TraceScope | undefined): () => void {
    if (!trace) return () => undefined;
    let requestedAt = 0;
    return this.pause.subscribe((state, previous) => {
      if (state === 'pause-requested') {
        requestedAt = Date.now();
        trace.runtime({ event: 'pause', phase: 'requested' });
      } else if (state === 'paused') {
        trace.runtime({ event: 'pause', phase: 'paused', waitMs: Date.now() - requestedAt });
      } else if (state === 'running' && previous !== 'idle') {
        trace.runtime({ event: 'pause', phase: 'resumed', waitMs: Date.now() - requestedAt });
      }
    });
  }

  run(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent> {
    return this.observed('run', input, this.runTurn(input, opts), opts?.trace);
  }

  private async *runTurn(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent> {
    // Steering que el turno anterior no llegó a entregar (se canceló o se
    // cortó): va delante de la petición nueva, que es su sitio en el tiempo.
    const undelivered = this.inbox.takeUndeliveredUserMessages(opts?.trace);
    if (undelivered.length > 0) {
      pushUserInput(this.messages, formatUndeliveredUserMessages(undelivered));
    }
    // UX-1: un deshacer hecho entre turnos se avisa aquí, delante de la
    // petición nueva (mismo sitio que el steering no entregado): el modelo no
    // puede seguir editando ficheros con la versión que ya no existe.
    const revertNotice = this.revertNotice;
    if (revertNotice) {
      this.revertNotice = null;
      pushUserInput(this.messages, revertNotice);
    }
    pushUserInput(this.messages, input);

    // Hito 6: reiniciar el estado de fallback en cada turno para que el provider
    // primario se reintente aunque haya fallado en un turno anterior.
    this.router.resetFallback();

    this.currentLoop = this.makeLoop();

    // UX-1: T0 del turno. Nunca lanza ni bloquea el turno si git falla.
    const snapshots = await this.openSnapshots();
    const trackedTurn = snapshots ? await snapshots.beginTurn() : null;

    let stopReason: string | null = null;
    const tracker = this.targetTracker();
    const trace = opts?.trace;
    trace?.turnStart(input, this.messages);
    this.inbox.beginTurn(trace);
    try {
      for await (const event of this.currentLoop.run(this.withSessionOptions(opts))) {
        if (event.type === 'tool_result') this._toolCallCount++;
        if (event.type === 'subagent_completed') this.addChildTokens(event.result);
        if (event.type === 'done') stopReason = event.stopReason;
        tracker(event);
        trace?.event(event);
        yield event;
      }
    } finally {
      // §12.12: un turno cancelado o abandonado a mitad no puede dejar tool
      // calls sin respuesta: el siguiente request al provider fallaría.
      closeDanglingToolCalls(this.messages);
      // M11 — el turno, entero, al store; y qué queda en el contexto activo.
      this.recordConversation();
      // Desde aquí un mensaje del usuario ya no es steering de este turno. Lo
      // que quedara sin entregar (turno cancelado o cortado) sigue en la inbox
      // y abre el turno siguiente.
      this.inbox.endTurn();
      trace?.turnEnd(stopReason);
      // UX-1: T1 en el finally, también si el loop lanzó (cancelación, error).
      // `finishTurn` nunca lanza: un fallo de git desactiva los snapshots.
      if (snapshots && trackedTurn) await snapshots.finishTurn(trackedTurn);
    }
    // Contabilidad de tokens (Hito 13): se consolida al cerrar el turno. Un
    // `unsupported` es pegajoso — si este backend no manda usage, no lo va a
    // mandar en el turno siguiente — pero `reported` siempre lo sobreescribe.
    const accounting = this.currentLoop.tokenAccounting;
    if (accounting.status === 'reported') {
      this._sessionTokens += accounting.tokens ?? 0;
      this._tokenStatus = 'reported';
    } else if (this._tokenStatus !== 'reported') {
      this._tokenStatus = accounting.status;
    }
    // UX-3: el desglose del turno se consolida en el mismo punto. Se guarda
    // aunque no traiga tokens (tiempos y número de llamadas son datos reales).
    const turnUsage = this.currentLoop.turnUsage;
    this._lastTurnUsage = turnUsage;
    this._sessionUsage = sumUsage(this._sessionUsage, turnUsage);
    this._sessionTurns++;
    this.currentLoop = null;

    // Extracción automática de decisiones en background (§9, detección
    // LLM-based). Fire-and-forget: nunca bloquea ni interrumpe la respuesta.
    if (stopReason === 'stop' && this.config.memory.autoExtract) {
      const extraction = this.maybeAutoExtract(trace).finally(() =>
        this.background.delete(extraction),
      );
      this.background.add(extraction);
    }
  }

  // -------------------------------------------------------------------------
  // UX-1 — deshacer por turno (puntos 5 y 7 del brief)
  // -------------------------------------------------------------------------

  /**
   * Abre el almacén la primera vez y cachea el resultado; si queda inactivo (sin
   * repo git, sin `sessionId`, registro de una versión más nueva) no se reintenta
   * en toda la sesión. Nunca lanza.
   */
  private async openSnapshots(): Promise<SnapshotStore | null> {
    if (!this.snapshotsEnabled || !this.snapshotsSessionId) return null;
    if (this.snapshotStore) return this.snapshotStore;
    this.snapshotOpening ??= this.openSnapshotsOnce();
    return this.snapshotOpening;
  }

  private async openSnapshotsOnce(): Promise<SnapshotStore | null> {
    if (!this.snapshotsSessionId) return null;
    try {
      const store = await SnapshotStore.open({
        cwd: this.env.cwd,
        sessionId: this.snapshotsSessionId,
        config: this.config.snapshots,
        ...(this.snapshotsHome ? { home: this.snapshotsHome } : {}),
      });
      this.snapshotStore = store.isActive() ? store : null;
      if (!this.snapshotStore) {
        log.debug('snapshots unavailable in this session', {
          reason: store.disabledReason ?? 'unknown',
        });
      }
    } catch (err) {
      this.snapshotStore = null;
      log.warn('snapshots unavailable in this session', { err });
    }
    return this.snapshotStore;
  }

  /**
   * Turnos con cambios que se pueden deshacer, el más reciente primero. Es
   * síncrono (la UI lo consulta al pintar): si el almacén todavía no se abrió
   * —ningún turno aún— devuelve [] y dispara la apertura en segundo plano.
   */
  getUndoableTurns(): TurnRecord[] {
    if (this.snapshotStore) return this.snapshotStore.getUndoableTurns();
    void this.openSnapshots();
    return [];
  }

  /**
   * Qué haría `revertTurns(count)`: rutas a restaurar, a borrar, conflictos
   * (tocadas por el usuario o por otra cosa después del último turno) y rutas
   * sin snapshot. Nunca lanza: sin almacén devuelve un plan vacío.
   */
  async planRevert(count = 1): Promise<RevertPlan> {
    const empty: RevertPlan = { turns: [], restore: [], remove: [], conflicts: [], skipped: [] };
    if (this.currentLoop) {
      log.warn('planRevert ignored: a turn is in progress');
      return empty;
    }
    const store = await this.openSnapshots();
    if (!store) return empty;
    return store.planRevert(count);
  }

  /**
   * Deshace los `count` últimos turnos. Rechaza con resultado (nunca excepción)
   * si hay un turno en curso o si hay conflictos sin `force`. Tras revertir deja
   * el aviso `<files_reverted>` para que abra el turno siguiente y olvida las
   * versiones vistas de esos ficheros (`FileStateTracker`), que ya no valen.
   */
  async revertTurns(count = 1, opts: { force?: boolean } = {}): Promise<RevertResult> {
    if (this.currentLoop) return { ok: false, reason: 'turn-in-progress' };
    const store = await this.openSnapshots();
    if (!store) return { ok: false, reason: 'disabled' };
    const result = await store.revertTurns(count, opts);
    if (result.ok) {
      // El registro guarda rutas relativas a la RAÍZ del worktree, no al cwd.
      const storeRoot = this.snapshotStore?.root ?? this.env.cwd;
      for (const path of [...result.restored, ...result.removed]) {
        this.fileState.forget(resolvePath(storeRoot, path));
      }
      this.revertNotice = formatFilesReverted(result.turns, result.restored, result.removed);
    }
    return result;
  }

  /** Registra el historial activo en el store y guarda el estado del contexto. Nunca lanza. */
  private recordConversation(): void {
    if (!this.conversation) return;
    try {
      this.conversation.saveState(this.messages);
    } catch (err) {
      // El store es la conversación duradera: que falle se registra, pero el turno sigue.
      log.error('conversation not recorded', { err });
    }
  }

  /** Lanza la extracción automática de decisiones. Best-effort, no lanza. */
  private async maybeAutoExtract(trace?: TraceScope): Promise<void> {
    try {
      await extractAndStore({
        provider: this.router.getActive(),
        providerName: this.router.providerName,
        model: this.config.memory.extractionModel ?? this.router.model,
        messages: this.getMessages(),
        memory: this.memoryManager.getDecisionMemory(),
        trace,
        cancelSignal: this.backgroundAbort.signal,
      });
    } catch {
      /* la memoria es auxiliar: un fallo nunca debe afectar a la sesión */
    }
  }

  /** ¿Hay trabajo en segundo plano en vuelo (la extracción de memoria)? */
  get hasBackgroundWork(): boolean {
    return this.background.size > 0;
  }

  /**
   * Corta el trabajo en segundo plano (la extracción de memoria en vuelo) y
   * espera a que se cierre. Para el apagado: sin esto, una llamada auxiliar a
   * medias quedaría en la traza abierta para siempre en vez de `cancelled`. No
   * hay que llamarlo si se quiere que la extracción termine.
   */
  async cancelBackgroundWork(): Promise<void> {
    this.backgroundAbort.abort();
    await Promise.allSettled([...this.background]);
    this.backgroundAbort = new AbortController();
  }

  /**
   * Cierra lo que no muere con el turno: hoy, los language servers (UX-2b).
   * Idempotente y nunca rechaza; el teardown de la sesión lo llama junto al del
   * resto de subsistemas (§12.12).
   */
  async dispose(): Promise<void> {
    await this.lsp?.dispose();
  }

  /**
   * Recarga la memoria del proyecto desde disco y reconstruye el system prompt.
   * Usado tras `/init` para que el STRATUM.md regenerado entre en el contexto.
   */
  reloadMemory(): void {
    this.memoryManager.reload();
    this.rebuildSystemPrompt();
  }

  /** Recompone `messages[0]` desde la config y el estado actuales (sin recargar memoria). */
  private rebuildSystemPrompt(): void {
    const newSystemContent = this.buildSystemContent();
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: newSystemContent };
    } else {
      this.messages.unshift({ role: 'system', content: newSystemContent });
    }
    // Recomponer el prompt no puede perder la memoria de sesión.
    this.applySessionMemory();
  }

  /**
   * Purga el historial conversacional dejando solo el system prompt (`/clear`
   * y `Ctrl+L`, UI §5.2). La sesión sigue viva — mismo `sessionId` — pero el
   * agente arranca la siguiente iteración con el contexto vacío.
   */
  /** Tareas vivas de la sesion (para inicializar la UI al reanudar). */
  getTodos(): TodoItem[] {
    return this.todos.snapshot;
  }

  clearHistory(): void {
    const system = this.messages[0]?.role === 'system' ? this.messages[0] : null;
    this.messages = system ? [system] : [];
    this.contextManager?.forgetLastUsage();
    this._toolCallCount = 0;
    this._planRef = null;
    this.inbox.clearUserMessages();
    this.todos.clear();
    this.tdd.clear();
    // El contexto activo queda vacío; la conversación sigue entera en el store.
    this.recordConversation();
  }

  /**
   * Sustituye el historial completo (`/sessions resume <id>` en caliente).
   * A diferencia de `clearHistory`, el system prompt viene dentro de los
   * mensajes cargados: se guardaron tal cual estaban en la sesión original.
   *
   * Los contadores de uso pasan a ser los de la sesión cargada (`usage`), o
   * cero si no los guardó: no se mezclan con los de la que había.
   */
  replaceHistory(
    messages: Message[],
    activeAgent?: string | null,
    readOnly?: boolean,
    usage?: SessionUsageSnapshot,
  ): string | null {
    this.messages = [...messages];
    this.inbox.clearUserMessages();
    this.contextManager?.forgetLastUsage();
    this.restoreUsage(usage);
    this._planRef = null;
    this.todos.replace(rehydrateTodos(this.messages));
    this.tdd.replace(rehydrateTdd(this.messages, TEST_EVIDENCE_TOOL));
    // Hito 17: cargar una sesión read-only nunca saca de read-only, y cargar
    // una que no lo era tampoco saca a la actual.
    if (readOnly) this._readOnly = true;

    const notice = this.reapplyPrimaryProfile(activeAgent);
    // El system prompt cargado es el de aquella sesión: si esta es read-only,
    // tiene que decirlo aunque aquella no lo fuera.
    if (this._readOnly) this.rebuildSystemPrompt();
    return notice;
  }

  /**
   * Añade un aviso de reanudación como mensaje de usuario, igual que hace
   * `resumePreamble` al construir. Para `/sessions resume` en caliente, que
   * carga el historial con `replaceHistory` sin recrear el agente.
   */
  appendResumePreamble(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }

  /** Hito 15 — reaplica el perfil principal de una sesión cargada. */
  private reapplyPrimaryProfile(activeAgent?: string | null): string | null {
    // El perfil activo es de la sesión cargada, no de la que había. Conservar
    // el actual dejaría el estado interno y el system prompt cargado en
    // desacuerdo.
    if (!activeAgent) {
      if (this._activeProfile) {
        this._activeProfile = null;
        this.rebuildSystemPrompt();
      }
      return null;
    }
    const applied = this.setPrimaryProfile(activeAgent);
    if (applied.ok) return null;
    this._activeProfile = null;
    this.rebuildSystemPrompt();
    return `No se pudo reactivar el perfil '${activeAgent}': ${applied.error}`;
  }

  /**
   * Fuerza una compresión de contexto ahora (`/compact`), sin esperar al umbral
   * automático del 80%. Se construye un `ContextManager` con los mismos
   * parámetros que usa `ReactLoop`, porque el del loop solo vive durante un
   * `run()` y `/compact` se invoca entre turnos.
   */
  async compactNow(trace?: TraceScope): Promise<CompressionResult> {
    return this.getContextManager().compress(this.messages, undefined, true, trace);
  }

  /**
   * `ContextManager` de la sesión. Vive fuera del `ReactLoop` (que dura un solo
   * turno) para conservar entre turnos el último `usage` real del provider y la
   * calibración del estimador de tokens: son lo que hace que el % de contexto de
   * la barra de estado y el umbral de compresión midan de verdad. Se reconstruye
   * solo si cambia el provider, el modelo o la ventana (`/model`, `/provider`,
   * fallback), porque la calibración es específica de ese tokenizador.
   */
  private getContextManager(): ContextManager {
    const key = `${this.router.providerName}|${this.router.model}|${this.router.contextWindow}`;
    if (!this.contextManager || this.contextManagerKey !== key) {
      this.contextManager = new ContextManager(
        this.router.contextWindow,
        this.config.agent.compressionKeepRounds,
        this.router.getActive(),
        this.router.model,
        this.config.agent.compressionThreshold,
        this.config.agent.compressorModel,
        this.config.agent.compressionTimeoutMs,
        this.router.providerName,
      );
      // M11 — con memoria de sesión, lo antiguo se compacta ahí (nunca se trunca).
      this.contextManager.attachSession(this.sessionCompactor());
      this.contextManagerKey = key;
    }
    return this.contextManager;
  }

  /**
   * Cambia el modelo activo en caliente (comando `/model`, Hito 3.5).
   * Solo afecta a la sesión actual; no persiste en `.stratumrc.json`.
   * Reconstruye el system prompt para que el bloque <env> refleje el modelo nuevo.
   */
  switchModel(model: string): void {
    this.router.switchModel(model);
    this.reloadMemory();
  }

  /**
   * Reaplica la config del provider activo en caliente (comando `/config_provider`).
   */
  reconfigureProvider(cfg: ProviderConfig): void {
    this.router.reconfigure(cfg);
    this.reloadMemory();
  }

  /**
   * Cambia el provider activo en caliente (comando `/provider <name>`, Hito 6).
   * Solo afecta a la sesión actual; no persiste en `.stratumrc.json`.
   * Reconstruye el system prompt para reflejar el provider/modelo nuevos.
   */
  switchProvider(name: string): void {
    this.router.switchProvider(name);
    this.reloadMemory();
  }

  /** Retira de la sesión un provider eliminado de la config (`/provider remove`). */
  forgetProvider(name: string): void {
    this.router.forgetProvider(name);
  }

  /** Alias de los providers configurados (para `/provider` y su autocompletado). */
  get providerNames(): string[] {
    return this.router.providerNames;
  }

  /** Health check del provider activo (para el indicador en tiempo real del status bar). */
  async healthCheck(): Promise<boolean> {
    return this.router.healthCheck();
  }

  getContextUsage(): { used: number; max: number; pct: number; estimated: boolean } {
    if (this.currentLoop) return this.currentLoop.getContextUsage();
    // Entre turnos: el mismo manager de sesión, para no perder la calibración ni
    // el último usage real (antes se recalculaba a mano con chars/3.5 crudo, que
    // subestima el contexto y hacía saltar el % de la barra al empezar el turno).
    return this.getContextManager().usage(this.messages);
  }

  /** Devuelve una copia del historial de mensajes (para persistir la sesión). */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Ref al fichero de plan activo (Hito 7), o null si no hay plan en esta sesión. */
  getPlanRef(): string | null {
    return this._planRef;
  }

  /** Registra la ref del plan activo (la fija el flujo de /plan al persistir). */
  setPlanRef(ref: string): void {
    this._planRef = ref;
  }

  /** Borra la ref del plan activo (al rechazar el plan antes de aprobación). */
  clearPlanRef(): void {
    this._planRef = null;
  }

  /**
   * Getter de un solo uso (§12.6): devuelve el plan reanudado con su tarea y
   * fecha de creación para que App.tsx inicialice el estado de UI en execute.
   * Se borra tras la primera llamada para no mantener la referencia innecesariamente.
   */
  getResumePlan(): {
    plan: import('./types.js').Plan;
    task: string;
    createdAt: string;
    root: string | null;
  } | null {
    if (!this._resumePlan) return null;
    const result = {
      plan: this._resumePlan,
      task: this._resumeTask ?? '',
      createdAt: this._resumeCreatedAt ?? new Date().toISOString(),
      root: this._resumePlanRoot,
    };
    this._resumePlanRoot = null;
    this._resumePlan = null;
    this._resumeTask = null;
    this._resumeCreatedAt = null;
    return result;
  }

  /** Total de tool calls ejecutados exitosamente en esta sesión. */
  /**
   * Tokens consumidos en la sesión (Hito 13). Nunca estima: cuando el backend
   * no reporta `usage`, devuelve el estado en lugar de un número inventado.
   */
  getTokenUsage(): TokenAccounting {
    const live = this.currentLoop?.tokenAccounting;
    if (live?.status === 'reported') {
      return { status: 'reported', tokens: this._sessionTokens + (live.tokens ?? 0) };
    }
    if (this._tokenStatus === 'reported') {
      return { status: 'reported', tokens: this._sessionTokens };
    }
    return { status: live?.status ?? this._tokenStatus };
  }

  get toolCallCount(): number {
    return this._toolCallCount;
  }

  /**
   * Desglose de uso del último turno cerrado (UX-3), o `null` si aún no hay
   * ninguno. Nunca estima: los campos que el backend no reporta van indefinidos.
   */
  getLastTurnUsage(): TurnUsage | null {
    return this._lastTurnUsage ? { ...this._lastTurnUsage } : null;
  }

  /**
   * Acumulado de la sesión (UX-3) más el número de turnos que lo componen.
   * `clearHistory()` no lo borra: limpiar el contexto no devuelve los tokens.
   *
   * **Excluye subagentes y llamadas auxiliares**: solo suma lo que midió el loop
   * principal (compresor de contexto y extracción de memoria no entran). Para la
   * contabilidad total de la sesión —que sí incluye lo que reportan los hijos,
   * en tokens— está `getTokenUsage()`. Un turno delegado (`runDelegate`) cuenta
   * en `turns` pero marca `incomplete`: su consumo no está en este desglose.
   */
  getSessionUsage(): TurnUsage & { turns: number } {
    return { ...this._sessionUsage, turns: this._sessionTurns };
  }

  /** Contadores de uso para guardar con la sesión o traspasarla. */
  getUsageSnapshot(): SessionUsageSnapshot {
    const tokens = this.getTokenUsage();
    return {
      toolCalls: this._toolCallCount,
      tokens: tokens.status === 'reported' ? (tokens.tokens ?? 0) : null,
      tokenStatus: tokens.status,
      session: this.getSessionUsage(),
    };
  }

  /**
   * Fija los contadores de uso a los de una sesión que continúa; sin `usage`,
   * los deja a cero. El desglose del último turno no se restaura: es del turno,
   * no de la sesión.
   */
  private restoreUsage(usage: SessionUsageSnapshot | undefined): void {
    this._toolCallCount = usage?.toolCalls ?? 0;
    this._tokenStatus = usage?.tokenStatus ?? 'unavailable';
    this._sessionTokens = usage?.tokenStatus === 'reported' ? (usage.tokens ?? 0) : 0;
    this._lastTurnUsage = null;
    if (usage?.session) {
      const { turns, ...breakdown } = usage.session;
      this._sessionUsage = breakdown;
      this._sessionTurns = turns;
    } else {
      this._sessionUsage = emptyTurnUsage();
      this._sessionTurns = 0;
    }
  }

  /**
   * Desglose del turno **en curso** (UX-3), para la telemetría en vivo; `null`
   * si no hay turno abierto. Es una foto parcial: crece con cada request.
   */
  getLiveTurnUsage(): TurnUsage | null {
    return this.currentLoop ? this.currentLoop.turnUsage : null;
  }

  get providerName(): string {
    return this.router.providerName;
  }

  get model(): string {
    return this.router.model;
  }

  /** Expone el provider activo para subsistemas que necesiten hacer LLM calls directas. */
  getProvider(): IProvider {
    return this.router.getActive();
  }

  /**
   * `/btw` (UX-4): responde una pregunta lateral sobre la conversación y va
   * devolviendo el texto. Llamada auxiliar sin tools (origen `side-question`):
   * no toca el historial, la memoria ni el uso de la sesión, así que vale
   * también con un turno en curso. Lanza si el provider falla.
   */
  async *askSideQuestion(
    question: string,
    opts: { trace?: TraceScope; signal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    const timeout = AbortSignal.timeout(SIDE_QUESTION_TIMEOUT_MS);
    for await (const chunk of tracedCompletion({
      origin: 'side-question',
      provider: this.router.getActive(),
      providerName: this.router.providerName,
      request: {
        messages: sideQuestionMessages(this.messages, question),
        stream: true,
        model: this.router.model,
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      },
      trace: opts.trace,
      cancelSignal: opts.signal,
    })) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) yield text;
    }
  }

  /** Tamaño del contexto del provider activo. */
  get contextWindow(): number {
    return this.router.contextWindow;
  }

  /** Expone la config para que comandos internos del chat puedan cargar rutas de memoria. */
  getConfig(): StratumConfig {
    return this.config;
  }

  /** Config del provider activo (con cambios en caliente aplicados). Para /model y /config_provider. */
  getActiveProviderConfig(): ProviderConfig {
    return this.router.getActiveConfig();
  }

  // -------------------------------------------------------------------------
  // Hito 15 — Perfiles de agente de primera clase
  // -------------------------------------------------------------------------

  /**
   * Entorno del system prompt del agente principal. Un único punto para el
   * constructor, `reloadMemory`, `/model` y `/agent`: si cada uno montase el
   * suyo, el primero que olvidase un campo borraría el bloque del perfil.
   */
  private promptEnv(): SystemPromptEnv {
    // El asistente no delega ni tiene perfiles o guías: nada de eso se calcula
    // (las guías, además, se materializarían en el cwd). Skills, solo las suyas.
    if (this.preset === 'assistant') {
      return {
        modelId: this.router.model,
        providerName: this.router.providerName,
        preset: 'assistant',
        skills: this.skillsBlock,
        workspace: this.workspace,
        workspaceFilesExpiredAt: this.workspaceFilesExpiredAt,
      };
    }
    const active = this._activeProfile;
    const session = this._sessionProfile;
    // Un perfil principal sin `delegate_task` no puede delegar: anunciarle
    // perfiles y reglas de delegación le ordenaría llamar a una tool que no tiene.
    // Lo mismo si el perfil de sesión la oculta (Hito 17).
    const canDelegate =
      (!active ||
        active.allowedTools === null ||
        active.allowedTools.includes(DELEGATE_TASK_TOOL)) &&
      (!session || profileAllows(session, DELEGATE_TASK_TOOL));
    // Hito 17: sin `test_evidence` en el toolset, el ciclo TDD no se enseña.
    const testing = !session || profileAllows(session, TEST_EVIDENCE_TOOL);
    const delegable = canDelegate
      ? this.profiles.delegable().filter((p) => p.name !== active?.name)
      : [];
    const agentProfiles = delegable.map((p) => p.name);
    return {
      modelId: this.router.model,
      providerName: this.router.providerName,
      agentProfiles,
      profileIndex: buildAgentProfilesBlock(
        delegable.map((p) => ({ name: p.name, when: describeProfile(p) })),
      ),
      activeProfile: active
        ? { name: active.name, fragment: active.systemPromptFragment }
        : undefined,
      skills: this.skillsBlock,
      readOnly: this._readOnly,
      testing,
      // Guías por puntero (§3 de gentle-pi): se recalculan con el perfil, porque
      // la de work-routing solo se anuncia si hay a quién delegar. En modo
      // `inline` devuelve cadena vacía; los ficheros llevan fingerprint y no se
      // reescriben si no cambiaron.
      guides: prepareGuideIndex(
        this.config,
        { agentProfiles, testCommand: testing ? this.config.tools.testCommand : '' },
        this.env.cwd,
      ),
      cwd: this.env.cwd,
    };
  }

  private buildSystemContent(): string {
    // Modo Chat: solo el `STRATUM.md` global (su `MemoryManager` tiene scope
    // `global`). El agente de código, solo el del proyecto.
    const memory =
      this.preset === 'assistant'
        ? this.memoryManager.getProjectMemory().globalContent
        : this.injectableMemory();
    return buildSystemPrompt(this.config, memory || undefined, this.promptEnv());
  }

  /**
   * Memoria para el system prompt del agente de código. Con scope `project` la
   * capa global llega vacía: se conserva el presupuesto por capa (M11) para que
   * una config con otro reparto no cambie de forma. Sin conversación duradera,
   * entera.
   */
  private injectableMemory(): string {
    const { globalContent, projectContent } = this.memoryManager.getProjectMemory();
    if (!this.conversation) {
      this.memoryLayerChars = { global: globalContent.length, project: projectContent.length };
      return this.memoryManager.getInjectableMemory();
    }
    const budget = this.contextBudget();
    const global = globalContent
      ? clipMemoryLayer(globalContent, budget.globalMemory, 'Global memory')
      : '';
    const project = projectContent
      ? clipMemoryLayer(projectContent, budget.projectMemory, 'Project memory')
      : '';
    this.memoryLayerChars = { global: global.length, project: project.length };
    return [global, project].filter(Boolean).join('\n\n---\n\n');
  }

  /** `ReactLoop` de un turno del agente principal. */
  private makeLoop(): ReactLoop {
    const active = this._activeProfile;
    return new ReactLoop(
      this.router.getActive(),
      this.registry,
      this.messages,
      this.config,
      this.router.model,
      this.router.contextWindow,
      this.router,
      {
        profiles: this.profiles,
        contextManager: this.getContextManager(),
        todos: this.todos,
        changes: this.changes,
        tdd: this.tdd,
        skills: this.skills,
        fileState: this.fileState,
        diagnostics: this.diagnosticsProvider,
        workspace: this.workspace,
        env: this.env,
        // Sin `isSubagent`: el principal conserva `question`/`todo`. Las tools de
        // control pasan aunque el perfil no las liste; `delegate_task` no.
        // Hito 17: el perfil de sesión se compone con el del agente principal.
        toolsetFilter:
          this.preset === 'assistant'
            ? assistantToolsetFilter({ workspace: this.workspace !== undefined })
            : composeToolsetFilters(
                this._sessionProfile ? sessionProfileFilter(this._sessionProfile) : undefined,
                active ? { allowedTools: active.allowedTools, controlTools: 'keep' } : undefined,
              ),
      },
    );
  }

  /**
   * Suma a la sesión los tokens de un subagente. Antes solo contaba el loop
   * padre, así que el `Σ` de la barra ignoraba todo el trabajo delegado.
   */
  private addChildTokens(result: SubagentResult): void {
    if (result.usage.tokenStatus !== 'reported' || result.usage.tokens === undefined) return;
    this._sessionTokens += result.usage.tokens;
    this._tokenStatus = 'reported';
  }

  /**
   * Activa un perfil como agente principal, o vuelve al agente por defecto con
   * `null`. Recompone el system prompt; el toolset se filtra en cada turno.
   * `provider`/`model` del perfil se ignoran a propósito en esta versión: se
   * informan en `notes` para que la UI lo diga.
   */
  setPrimaryProfile(
    name: string | null,
  ): { ok: true; profile: AgentProfile | null; notes: string[] } | { ok: false; error: string } {
    if (name === null) {
      this._activeProfile = null;
      this.rebuildSystemPrompt();
      return { ok: true, profile: null, notes: [] };
    }
    if (this.preset === 'assistant') {
      return {
        ok: false,
        error: 'los perfiles de agente no están disponibles en el modo asistente.',
      };
    }
    const profile = this.profiles.resolve(name);
    if (!profile) {
      const available = this.profiles.primaries().map((p) => p.name);
      return {
        ok: false,
        error:
          `el perfil '${name}' no existe.` +
          (available.length > 0
            ? ` Activables: ${available.join(', ')}.`
            : ' No hay perfiles con mode: primary o all.'),
      };
    }
    if (!isPrimaryCapable(profile)) {
      return {
        ok: false,
        error:
          `'${name}' es un perfil de subagente (mode: subagent). Declara mode: primary o ` +
          `mode: all en su frontmatter para usarlo como agente principal, o invócalo con @${name}.`,
      };
    }
    const notes: string[] = [];
    if (profile.provider || profile.model) {
      const declared = [profile.provider, profile.model].filter(Boolean).join(' / ');
      notes.push(
        `El perfil declara ${declared}; como agente principal se ignora y se sigue con ` +
          `${this.router.providerName} / ${this.router.model}.`,
      );
    }
    if (profile.budgetDeclared) {
      notes.push(
        'El budget del perfil solo se aplica cuando se usa como subagente; como agente principal no limita nada.',
      );
    }
    this._activeProfile = profile;
    this.rebuildSystemPrompt();
    return { ok: true, profile, notes };
  }

  /** Preset de prompt y toolset, fijado al construir el agente. */
  get promptPreset(): PromptPreset {
    return this.preset;
  }

  /** Perfil activo como agente principal, o null. */
  getActiveProfile(): AgentProfile | null {
    return this._activeProfile;
  }

  /** Aviso de reanudación pendiente (un solo uso), o null. */
  takeResumeNotice(): string | null {
    const notice = this._resumeNotice;
    this._resumeNotice = null;
    return notice;
  }

  // -------------------------------------------------------------------------
  // Hito 17 — read-only, perfil de sesión y contexto activo
  // -------------------------------------------------------------------------

  /** Las opciones de la sesión (read-only) sobre las del turno. Nunca relajan. */
  private withSessionOptions(opts?: RunOptions): RunOptions {
    const base: RunOptions = this._readOnly ? { ...opts, readOnly: true } : (opts ?? {});
    return {
      ...base,
      inbox: this.inbox,
      pause: this.pause,
      ...(this.jobs ? { jobs: this.jobs } : {}),
    };
  }

  /**
   * Observa los eventos de un turno y apunta el último target donde algo se
   * ejecutó (también dentro de subagentes). Un rechazo previo no cuenta: el
   * badge dice dónde se está actuando, no dónde se intentó.
   */
  private targetTracker(): (event: AgentEvent) => void {
    const inputs = new Map<string, { name: string; input: string }>();
    const observe = (event: AgentEvent, prefix: string): void => {
      if (event.type === 'tool_call_start') {
        inputs.set(prefix + event.id, { name: event.name, input: event.input_so_far });
      } else if (
        event.type === 'tool_result' ||
        (event.type === 'tool_error' && event.executed === true)
      ) {
        const call = inputs.get(prefix + event.id);
        const target = call ? targetOfCall(call.name, call.input) : null;
        if (target) this._activeTarget = target;
      } else if (event.type === 'subagent_event') {
        observe(event.event, `${event.subagentId}:`);
      }
    };
    return (event) => observe(event, '');
  }

  isReadOnly(): boolean {
    return this._readOnly;
  }

  /** Activa o desactiva el modo read-only. Recompone el prompt; el toolset cambia desde el próximo turno. */
  setReadOnly(on: boolean): void {
    if (this._readOnly === on) return;
    this._readOnly = on;
    this.rebuildSystemPrompt();
  }

  getSessionProfile(): SessionProfile | null {
    return this._sessionProfile;
  }

  /** Lo que se pidió (`auto`, `code`…): con `auto`, `getSessionProfile()` es el resuelto. */
  getSessionProfileRequest(): string {
    return this._sessionProfileRequest;
  }

  /** Detección de infraestructura de la última resolución `auto`, o null. */
  getProfileDetection(): InfraDetection | null {
    return this._profileDetection;
  }

  private applySessionProfile(
    requested: string | undefined,
  ): { ok: true; profile: SessionProfile } | { ok: false; error: string } {
    const resolved = resolveSessionProfile(requested, this.config);
    if (!resolved.ok) return resolved;
    this._sessionProfile = resolved.profile;
    this._sessionProfileRequest = (requested ?? this.config.session.profile).trim().toLowerCase();
    this._profileDetection = resolved.auto ?? null;
    return { ok: true, profile: resolved.profile };
  }

  /** Cambia el perfil de sesión (`/profile`). Recompone el prompt. */
  setSessionProfile(
    name: string,
  ):
    | { ok: true; profile: SessionProfile; detection: InfraDetection | null }
    | { ok: false; error: string } {
    if (this.preset === 'assistant') {
      return {
        ok: false,
        error: 'los perfiles de sesión no están disponibles en el modo asistente.',
      };
    }
    const applied = this.applySessionProfile(name);
    if (!applied.ok) return applied;
    this.rebuildSystemPrompt();
    return { ok: true, profile: applied.profile, detection: this._profileDetection };
  }

  /** Contexto activo (badge de la barra): último target usado y su entorno. */
  getActiveContext(): { target: string; environment: ResolvedEnvironment | null } {
    return {
      target: this._activeTarget,
      environment: resolveEnvironment(this._activeTarget, this.config),
    };
  }

  listProfiles(): AgentProfile[] {
    return this.profiles.list();
  }

  delegableProfiles(): AgentProfile[] {
    return this.profiles.delegable();
  }

  primaryProfiles(): AgentProfile[] {
    return this.profiles.primaries();
  }

  invalidProfiles(): InvalidProfile[] {
    return this.profiles.invalidProfiles();
  }

  profileWarnings(): ProfileWarning[] {
    return this.profiles.warnings();
  }

  /**
   * Invocación directa de un subagente por el usuario (`@perfil tarea`,
   * `stratum run --delegate`). No pasa por el LLM del agente principal, pero
   * deja el mismo rastro que un `delegate_task` del modelo — un par
   * `assistant(tool_calls) → tool` — para que el siguiente turno pueda usar el
   * resultado y la compresión y `--resume` vean un historial bien formado. Lo
   * cierra un `assistant` con el resumen: ni se queda un `tool` seguido de un
   * `user` (plantillas de chat estrictas), ni la sesión reanudada pierde qué
   * contestó el subagente.
   */
  runDelegate(profileName: string, task: string, opts?: RunOptions): AsyncGenerator<AgentEvent> {
    return this.observed(
      'delegate',
      `@${profileName} ${task.trim()}`,
      this.delegateTurn(profileName, task, opts),
      opts?.trace,
    );
  }

  private async *delegateTurn(
    profileName: string,
    task: string,
    opts?: RunOptions,
  ): AsyncGenerator<AgentEvent> {
    const taskText = task.trim();
    const resolved = resolveDelegationProfile(this.profiles, profileName);
    if (!resolved.ok || !taskText) {
      const message = !taskText
        ? `Uso: @${profileName} <tarea>`
        : resolved.ok
          ? ''
          : resolved.error;
      yield { type: 'error', message, fatal: false };
      yield { type: 'done', stopReason: 'stop' };
      return;
    }
    const profile = resolved.profile;
    const signal = opts?.signal ?? new AbortController().signal;
    const subId = generateSubagentId();
    const callId = `call_direct_${subId.slice(4)}`;

    pushUserInput(this.messages, `@${profile.name} ${taskText}`);
    const trace = opts?.trace;
    trace?.turnStart(`@${profile.name} ${taskText}`, this.messages);
    this.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: {
            name: DELEGATE_TASK_TOOL,
            arguments: JSON.stringify({ task: taskText, profile: profile.name }),
          },
        },
      ],
    });

    let result: SubagentResult | undefined;
    const delegations = executeDelegations([{ callId, profile, taskText, subId }], {
      registry: this.registry,
      config: this.config,
      signal,
      opts: this.withSessionOptions(opts),
      skills: this.skills,
      env: this.env,
    });
    try {
      for (;;) {
        const next = await delegations.next();
        if (next.done) {
          result = next.value.get(subId) ?? result;
          break;
        }
        // El resultado se captura al verlo pasar, no solo al final: si el
        // consumidor abandona justo después de este yield, el historial debe
        // decir lo que ocurrió de verdad, no `cancelled`.
        if (next.value.type === 'subagent_completed' && next.value.subagentId === subId) {
          result = next.value.result;
        }
        trace?.event(next.value);
        yield next.value;
      }
    } finally {
      // Abandonado a mitad: cerrar el generador interno aborta al hijo y espera
      // a que termine, así no queda nadie escribiendo ficheros por detrás.
      await delegations.return(new Map());
      // Aunque el consumidor abandone el generador, la tool call sintética no
      // puede quedar sin respuesta: el siguiente request al provider fallaría.
      const final: SubagentResult = result ?? {
        id: subId,
        status: 'cancelled',
        summary: '',
        filesChanged: [],
        usage: { iterations: 0, durationMs: 0 },
        error: 'Subagent was cancelled.',
      };
      this.messages.push({
        role: 'tool',
        tool_call_id: callId,
        name: DELEGATE_TASK_TOOL,
        content: truncateToolOutput(serializeSubagentResult(final, profile.name)),
      });
      this.messages.push({ role: 'assistant', content: directSummaryText(profile.name, final) });
      this._toolCallCount++;
      if (result) this.addChildTokens(result);
      // UX-3: el turno delegado cuenta como turno de sesión, pero su desglose
      // (tokens, caché, tiempos, coste) lo lleva el loop del hijo y aquí no
      // llega: se marca `incomplete` para que nadie lea ese 0 como medido.
      this._sessionTurns++;
      this._sessionUsage = { ...this._sessionUsage, incomplete: true };
      this._lastTurnUsage = { ...emptyTurnUsage(), incomplete: true };
      trace?.turnEnd(result ? 'stop' : 'cancelled');
    }

    yield {
      type: 'tool_result',
      id: callId,
      name: DELEGATE_TASK_TOOL,
      result: truncateToolOutput(serializeSubagentResult(result!, profile.name)),
      durationMs: result!.usage.durationMs,
    };
    yield { type: 'done', stopReason: result!.status === 'cancelled' ? 'cancelled' : 'stop' };
  }
}

/** Texto del `assistant` que cierra una invocación directa (Hito 15). */
function directSummaryText(profile: string, result: SubagentResult): string {
  const head = result.status === 'completed' ? `[@${profile}]` : `[@${profile} · ${result.status}]`;
  const body = result.summary.trim() || result.error || '(no summary)';
  return `${head} ${body}`;
}
