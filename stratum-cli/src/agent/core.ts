import type { StratumConfig, ProviderConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { IProvider } from '../providers/base.js';
import type { AgentEvent, Message, RunOptions } from './types.js';
import { ReactLoop } from './harness.js';
import { buildSystemPrompt } from './system-prompt.js';
import { ProfileLoader } from './profiles.js';
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
  private readonly memoryManager: MemoryManager;
  /** Perfiles de subagente (Hito 8): descubiertos al arrancar, pasados al loop. */
  private readonly profiles: ProfileLoader;
  private _toolCallCount = 0;
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
    this.profiles = new ProfileLoader();

    if (options?.planRef) this._planRef = options.planRef;
    if (options?.resumePlan) {
      this._resumePlan = options.resumePlan;
      this._resumeTask = options.resumeTask ?? null;
      this._resumeCreatedAt = options.resumeCreatedAt ?? null;
    }

    if (options?.initialMessages && options.initialMessages.length > 0) {
      // Reanudar sesión: usar historial completo tal como fue guardado
      this.messages = [...options.initialMessages];
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
      { profiles: this.profiles },
    );

    let stopReason: string | null = null;
    for await (const event of this.currentLoop.run(opts)) {
      if (event.type === 'tool_result') this._toolCallCount++;
      if (event.type === 'done') stopReason = event.stopReason;
      yield event;
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
    });
    if (this.messages[0]?.role === 'system') {
      this.messages[0] = { role: 'system', content: newSystemContent };
    } else {
      this.messages.unshift({ role: 'system', content: newSystemContent });
    }
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
    const chars = this.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    const used = Math.ceil(chars / 3.5);
    const max = this.router.contextWindow;
    return { used, max, pct: Math.round((used / max) * 100), estimated: true };
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
