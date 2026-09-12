import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { IProvider } from '../providers/base.js';
import type { AgentEvent, Message, RunOptions, TokenAccounting, TokenStatus } from './types.js';
import { ReactLoop, ContextManager } from './harness.js';
import type { CompressionResult } from './harness.js';
import { buildSystemPrompt, findWorktreeRoot } from './system-prompt.js';
import { ProfileLoader } from './profiles.js';
import { ChangeTracker } from './risk.js';
import { SkillRegistry } from '../skills/registry.js';
import { TodoList, rehydrateTodos } from './todo.js';
import { TddLedger, rehydrateTdd } from './tdd.js';
import { TEST_EVIDENCE_TOOL } from '../tools/tdd.js';
import type { TodoItem } from './todo.js';
import { MemoryManager } from '../memory/manager.js';
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

  constructor(
    private readonly config: StratumConfig,
    private readonly router: ProviderRouter,
    private readonly registry: ToolRegistry,
    options?: StratumAgentOptions,
  ) {
    this.memoryManager = new MemoryManager(config);
    // Perfiles de subagente desde la raíz del worktree git Y el cwd: la raíz del
    // worktree cubre la invocación desde un subdirectorio del repo (consistente
    // con el `<env>`); el cwd cubre el caso en que el proyecto npm vive en un
    // subdirectorio del repo (p.ej. `stratum-cli/.stratum/agents/`). El cwd gana
    // en conflictos por ser el más específico. Si coinciden, se carga una vez.
    this.profiles = new ProfileLoader([findWorktreeRoot(process.cwd()).worktree, process.cwd()]);

    // Skills (Hito 12): mismos roots que los perfiles. El índice entra en el
    // system prompt; el cuerpo de cada skill se lee bajo demanda con read_file.
    // La tabla materializada en disco es auditable y sirve de caché: si el
    // fingerprint no cambia, no se reescribe.
    if (config.skills.enabled) {
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
    } else {
      // Nueva sesión: construir system prompt con memoria del proyecto
      const memory = this.memoryManager.getInjectableMemory();
      this.messages = [
        {
          role: 'system',
          content: buildSystemPrompt(config, memory || undefined, {
            modelId: router.model,
            providerName: router.providerName,
            agentProfiles: this.profiles.availableNames(),
            skills: this.skillsBlock,
          }),
        },
      ];
    }
  }

  async *run(input: string, opts?: RunOptions): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: input });

    // Hito 6: reiniciar el estado de fallback en cada turno para que el provider
    // primario se reintente aunque haya fallado en un turno anterior.
    this.router.resetFallback();

    this.currentLoop = new ReactLoop(
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
      },
    );

    let stopReason: string | null = null;
    for await (const event of this.currentLoop.run(opts)) {
      if (event.type === 'tool_result') this._toolCallCount++;
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
    const memory = this.memoryManager.getInjectableMemory();
    const newSystemContent = buildSystemPrompt(this.config, memory || undefined, {
      modelId: this.router.model,
      providerName: this.router.providerName,
      agentProfiles: this.profiles.availableNames(),
      skills: this.skillsBlock,
    });
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
  replaceHistory(messages: Message[]): void {
    this.messages = [...messages];
    this._toolCallCount = 0;
    this._planRef = null;
    this.todos.replace(rehydrateTodos(this.messages));
    this.tdd.replace(rehydrateTdd(this.messages, TEST_EVIDENCE_TOOL));
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
}
