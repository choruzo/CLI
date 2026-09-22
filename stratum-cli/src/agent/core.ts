import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { IProvider } from '../providers/base.js';
import type {
  AgentEvent,
  AgentProfile,
  Message,
  RunOptions,
  SubagentResult,
  TokenAccounting,
  TokenStatus,
  WorkspaceConfinement,
} from './types.js';
import { ReactLoop, ContextManager } from './harness.js';
import type { CompressionResult } from './harness.js';
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
import { SkillRegistry } from '../skills/registry.js';
import { TodoList, rehydrateTodos } from './todo.js';
import { TddLedger, rehydrateTdd } from './tdd.js';
import { TEST_EVIDENCE_TOOL } from '../tools/tdd.js';
import type { TodoItem } from './todo.js';
import { MemoryManager } from '../memory/manager.js';
import { assistantToolsetFilter, type PromptPreset } from './presets.js';
import { extractAndStore } from '../memory/extractor.js';

export interface StratumAgentOptions {
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
}

export class StratumAgent {
  private messages: Message[];
  private currentLoop: ReactLoop | null = null;
  /** `ContextManager` de sesión (ver `getContextManager`). */
  private contextManager: ContextManager | null = null;
  private contextManagerKey = '';
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
  /** Índice de skills (Hito 12). Se descubre una vez y se hereda a los hijos. */
  private readonly skillsBlock: string;
  /**
   * Contabilidad de tokens de la sesión (Hito 13). El `ReactLoop` vive un turno,
   * así que el acumulado se suma aquí. El estado se guarda aparte del número:
   * un 0 sin estado no distingue «no gastó nada» de «el backend no lo dice».
   */
  private _sessionTokens = 0;
  private _tokenStatus: TokenStatus = 'unavailable';
  /** Ref al fichero de plan activo (Hito 7), para persistir el `planRef` de la sesión. */
  private _planRef: string | null = null;
  /** Plan reanudado (§12.6): expuesto una sola vez a la UI al init, luego se borra. */
  private _resumePlan: import('./types.js').Plan | null = null;
  private _resumeTask: string | null = null;
  private _resumeCreatedAt: string | null = null;
  /**
   * Perfil activo como agente principal (Hito 15, `/agent <perfil>`). Cambia el
   * system prompt y restringe el toolset; no el provider ni el modelo.
   */
  private _activeProfile: AgentProfile | null = null;
  /** Aviso de un solo uso al reanudar con un perfil que ya no se puede activar. */
  private _resumeNotice: string | null = null;
  private readonly preset: PromptPreset;
  private readonly workspace: WorkspaceConfinement | undefined;
  private readonly workspaceFilesExpiredAt: string | undefined;

  constructor(
    private readonly config: StratumConfig,
    private readonly router: ProviderRouter,
    private readonly registry: ToolRegistry,
    options?: StratumAgentOptions,
  ) {
    this.memoryManager = new MemoryManager(config);
    this.preset = options?.promptPreset ?? 'coding';
    this.workspace = options?.workspace;
    this.workspaceFilesExpiredAt = options?.workspaceFilesExpiredAt;
    // Perfiles de subagente desde la raíz del worktree git Y el cwd: la raíz del
    // worktree cubre la invocación desde un subdirectorio del repo (consistente
    // con el `<env>`); el cwd cubre el caso en que el proyecto npm vive en un
    // subdirectorio del repo (p.ej. `stratum-cli/.stratum/agents/`). El cwd gana
    // en conflictos por ser el más específico. Si coinciden, se carga una vez.
    this.profiles =
      options?.profileLoader ??
      new ProfileLoader([findWorktreeRoot(process.cwd()).worktree, process.cwd()]);

    // Skills (Hito 12): mismos roots que los perfiles. El índice entra en el
    // system prompt; el cuerpo de cada skill se lee bajo demanda con read_file.
    // La tabla materializada en disco es auditable y sirve de caché: si el
    // fingerprint no cambia, no se reescribe.
    // El asistente no tiene skills: su índice presupone un proyecto, y
    // materializarlo escribiría `skill-registry.md` en el cwd del sidecar.
    if (config.skills.enabled && this.preset === 'coding') {
      const registry = new SkillRegistry([findWorktreeRoot(process.cwd()).worktree, process.cwd()]);
      this.skillsBlock = registry.promptBlock(process.cwd());
      registry.writeRegistryFile(config.skills.registryFile);
    } else {
      this.skillsBlock = '';
    }

    if (options?.planRef) this._planRef = options.planRef;
    if (options?.resumePlan) {
      this._resumePlan = options.resumePlan;
      this._resumeTask = options.resumeTask ?? null;
      this._resumeCreatedAt = options.resumeCreatedAt ?? null;
    }

    if (options?.initialMessages && options.initialMessages.length > 0) {
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
  }

  async *run(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: input });

    // Hito 6: reiniciar el estado de fallback en cada turno para que el provider
    // primario se reintente aunque haya fallado en un turno anterior.
    this.router.resetFallback();

    this.currentLoop = this.makeLoop();

    let stopReason: string | null = null;
    for await (const event of this.currentLoop.run(opts)) {
      if (event.type === 'tool_result') this._toolCallCount++;
      if (event.type === 'subagent_completed') this.addChildTokens(event.result);
      if (event.type === 'done') stopReason = event.stopReason;
      yield event;
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
    this.currentLoop = null;

    // Extracción automática de decisiones en background (§9, detección
    // LLM-based). Fire-and-forget: nunca bloquea ni interrumpe la respuesta.
    if (stopReason === 'stop' && this.config.memory.autoExtract) {
      void this.maybeAutoExtract();
    }
  }

  /** Lanza la extracción automática de decisiones. Best-effort, no lanza. */
  private async maybeAutoExtract(): Promise<void> {
    try {
      await extractAndStore({
        provider: this.router.getActive(),
        model: this.config.memory.extractionModel ?? this.router.model,
        messages: this.getMessages(),
        memory: this.memoryManager.getDecisionMemory(),
      });
    } catch {
      /* la memoria es auxiliar: un fallo nunca debe afectar a la sesión */
    }
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
    this._toolCallCount = 0;
    this._planRef = null;
    this.todos.clear();
    this.tdd.clear();
  }

  /**
   * Sustituye el historial completo (`/sessions resume <id>` en caliente).
   * A diferencia de `clearHistory`, el system prompt viene dentro de los
   * mensajes cargados: se guardaron tal cual estaban en la sesión original.
   */
  replaceHistory(messages: Message[], activeAgent?: string | null): string | null {
    this.messages = [...messages];
    this._toolCallCount = 0;
    this._planRef = null;
    this.todos.replace(rehydrateTodos(this.messages));
    this.tdd.replace(rehydrateTdd(this.messages, TEST_EVIDENCE_TOOL));

    // Hito 15: el perfil activo es de la sesión cargada, no de la que había.
    // Conservar el actual dejaría el estado interno y el system prompt cargado
    // en desacuerdo.
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
  async compactNow(): Promise<CompressionResult> {
    return this.getContextManager().compress(this.messages);
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
      );
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
  getResumePlan(): { plan: import('./types.js').Plan; task: string; createdAt: string } | null {
    if (!this._resumePlan) return null;
    const result = {
      plan: this._resumePlan,
      task: this._resumeTask ?? '',
      createdAt: this._resumeCreatedAt ?? new Date().toISOString(),
    };
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
    // El asistente no delega ni tiene perfiles, skills o guías: nada de eso se
    // calcula (las guías, además, se materializarían en el cwd).
    if (this.preset === 'assistant') {
      return {
        modelId: this.router.model,
        providerName: this.router.providerName,
        preset: 'assistant',
        workspace: this.workspace,
        workspaceFilesExpiredAt: this.workspaceFilesExpiredAt,
      };
    }
    const active = this._activeProfile;
    // Un perfil principal sin `delegate_task` no puede delegar: anunciarle
    // perfiles y reglas de delegación le ordenaría llamar a una tool que no tiene.
    const canDelegate =
      !active || active.allowedTools === null || active.allowedTools.includes(DELEGATE_TASK_TOOL);
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
      // Guías por puntero (§3 de gentle-pi): se recalculan con el perfil, porque
      // la de work-routing solo se anuncia si hay a quién delegar. En modo
      // `inline` devuelve cadena vacía; los ficheros llevan fingerprint y no se
      // reescriben si no cambiaron.
      guides: prepareGuideIndex(
        this.config,
        { agentProfiles, testCommand: this.config.tools.testCommand },
        process.cwd(),
      ),
    };
  }

  private buildSystemContent(): string {
    // Modo Chat: solo el `STRATUM.md` global. El de proyecto se resolvería
    // contra el cwd del sidecar, que no es ningún proyecto.
    const memory =
      this.preset === 'assistant'
        ? this.memoryManager.getProjectMemory().globalContent
        : this.memoryManager.getInjectableMemory();
    return buildSystemPrompt(this.config, memory || undefined, this.promptEnv());
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
        skillsBlock: this.skillsBlock,
        workspace: this.workspace,
        // Sin `isSubagent`: el principal conserva `question`/`todo`. Las tools de
        // control pasan aunque el perfil no las liste; `delegate_task` no.
        toolsetFilter:
          this.preset === 'assistant'
            ? assistantToolsetFilter({ workspace: this.workspace !== undefined })
            : active
              ? { allowedTools: active.allowedTools, controlTools: 'keep' }
              : undefined,
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
  async *runDelegate(
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

    this.messages.push({ role: 'user', content: `@${profile.name} ${taskText}` });
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
      opts,
      skillsBlock: this.skillsBlock,
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
