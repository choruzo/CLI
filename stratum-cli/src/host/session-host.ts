import type { StratumConfig } from '../config/schema.js';
import type { AgentEvent, AgentMode, DestructivePolicy, Plan, RunOptions } from '../agent/types.js';
import { StratumAgent, type StratumAgentOptions } from '../agent/core.js';
import type { PauseRequestStatus, PauseState, ResumeStatus } from '../agent/pause.js';
import { strictestPolicy } from '../agent/profiles.js';
import type { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { McpManager, type McpManagerWarning } from '../tools/mcp/manager.js';
import { closeSessionExecRuntime } from '../tools/exec/runtime.js';
import { PlanStore, generatePlanId } from '../session/plan-store.js';
import { SubagentStore } from '../session/subagent-store.js';
import { generateSessionId } from '../session/store.js';
import { openSessionTrace } from '../trace/store.js';
import type { TraceRecorder, TraceScope } from '../trace/recorder.js';
import type { SessionEnv } from '../runtime/session-env.js';
import { getLogger } from '../logging/index.js';
import { findWorktreeRoot } from '../config/paths.js';
import { PluginHost, loadPlugins, type PluginLoadRequest } from '../plugins/index.js';
import { PendingInteractions, type HostGates, type InteractionChange } from './interactions.js';
import { recordResolution } from './resolution-audit.js';
import {
  assistantDataDir,
  assistantWorkspace,
  buildAssistantConfig,
  buildAssistantRegistry,
  importLegacyGlobalDecisions,
  legacyAssistantMemoryDir,
  legacyGlobalDecisionsDir,
  migrateLegacyAssistantMemory,
  type AssistantData,
} from './assistant.js';
import { buildCompanionConfig, buildCompanionRegistry, companionDataDir } from './companion.js';

export type { GateContext, HostGates } from './interactions.js';

const log = getLogger('host');

export interface SessionHostOptions {
  /** Entorno de la sesión. Siempre explícito: el host no lee el del proceso. */
  env: SessionEnv;
  /** Config ya cargada (`loadConfig(env.cwd)`). El host trabaja sobre una copia propia. */
  config: StratumConfig;
  /** Router de la sesión: lo crea quien aloja, que es quien resuelve provider y modelo. */
  router: ProviderRouter;
  /** Id de la sesión; por defecto se genera uno. Nombra también su traza. */
  sessionId?: string;
  /** Versión del cliente, para la cabecera de la traza. */
  version?: string;
  /**
   * Servers MCP: `eager` conecta y registra sus tools antes de devolver el host
   * (los fallos quedan en `mcpWarnings`, nunca abortan); `none` no conecta nada.
   */
  mcp?: 'eager' | 'none';
  /** Política destructiva base de la sesión. Un perfil principal solo la endurece. */
  destructivePolicy?: DestructivePolicy;
  /** `--allow-destructive`: se pasa tal cual al runtime. */
  allowDestructive?: boolean;
  /** Prompts del proceso que aloja la sesión (readline, Ink). */
  gates?: HostGates;
  /**
   * Plazo de una solicitud que nadie tiene delante (sin prompt local): al
   * vencer se resuelve en negativo. Ausente o `0` = sin plazo.
   */
  interactionTimeoutMs?: number;
  /** ¿Puede contestar ahora un cliente remoto? Ver `PendingInteractions`. */
  remoteApprovals?: () => boolean;
  /** Opciones del agente (reanudación, read-only, perfil de sesión…). `env` lo pone el host. */
  agent?: Omit<StratumAgentOptions, 'env' | 'promptPreset' | 'workspace' | 'plugins'>;
  /**
   * M12 — `assistant`: la sesión es del agente embebido `assistant`
   * (`host/assistant.ts`): su prompt, solo sus tools, ficheros confinados al
   * `cwd`, sin MCP, skills ni perfiles, y su propia memoria de decisiones. Se
   * fija aquí, al montar, y no cambia. Ausente: una sesión de código.
   *
   * M14 — `companion`: el agente embebido de Stratum Dot (`host/companion.ts`):
   * sin ficheros del anfitrión, `exec` solo en su caja, sin MCP, skills de
   * usuario, perfiles ni plugins, y su propia memoria. Quien lo aloja le da su
   * directorio (`ensureCompanionWorkspace`), no el del proceso.
   */
  preset?: 'assistant' | 'companion';
  /** M14 — dónde guarda el `companion` lo suyo. Por defecto `~/.stratum/companion/`. */
  companionDataDir?: string;
  /**
   * Datos del asistente: `dir` (su memoria; por defecto `~/.stratum/assistant/`)
   * y `legacyMemoryDir`, de dónde se migra una vez (por defecto la de Stratum
   * Desktop; `null`, nada).
   */
  assistantData?: AssistantData;
  /**
   * PL1 — plugins de la sesión: los flags de quien la aloja (`--no-plugins`,
   * `--plugin`). Ausente → los globales (config global y `~/.stratum/plugins/`);
   * es lo que hace el daemon, que nunca carga plugins por sesión. El preset
   * `assistant` no carga ninguno.
   */
  plugins?: PluginLoadRequest;
}

export interface TurnOptions {
  /** Cancelación del turno. Sin ella, el host crea una que `cancel()` aborta. */
  signal?: AbortSignal;
  mode?: AgentMode;
  /** Persistencia del plan del turno (ver `planPersister`). */
  onPlanPersist?: (plan: Plan, done: boolean) => void;
  compressionMode?: RunOptions['compressionMode'];
}

/**
 * Anfitrión de **una** sesión: la raíz de composición que monta el agente con
 * todo lo que necesita y lo desmonta sin tocar a nadie más.
 *
 *   config → registry (+ tools MCP) → `StratumAgent` → stores → traza → teardown
 *
 * Es la misma pieza para cualquier proceso que aloje sesiones (la CLI hoy; un
 * daemon con varias a la vez mañana — PRD de Stratum Dot, M0), así que no
 * asume nada del proceso: el directorio y las variables llegan por `env`, y lo
 * que cierra `dispose()` es solo lo de esta sesión. Tampoco sabe de terminales:
 * pintar eventos, leer flags o preguntar por readline es cosa de quien lo usa.
 */
export class SessionHost {
  readonly env: SessionEnv;
  /** Config de esta sesión. Objeto propio: de su identidad cuelgan su SSH y su auditoría. */
  readonly config: StratumConfig;
  readonly router: ProviderRouter;
  readonly registry: ToolRegistry;
  readonly mcp: McpManager;
  /** Avisos de la conexión MCP del arranque (servers que no conectaron, tools omitidas). */
  readonly mcpWarnings: readonly McpManagerWarning[];
  readonly agent: StratumAgent;
  readonly sessionId: string;
  /** Traza de la sesión, o null si está desactivada. No deja fichero hasta el primer turno. */
  readonly trace: TraceRecorder | null;
  readonly planStore: PlanStore;
  readonly subagentStore: SubagentStore;
  /**
   * Decisiones humanas pendientes de la sesión: el único sitio donde compiten
   * el prompt local, una respuesta remota, el plazo y la cancelación.
   */
  readonly interactions: PendingInteractions;
  /** PL1 — plugins cargados para esta sesión (vacío en el asistente o con `--no-plugins`). */
  readonly plugins: PluginHost;

  private readonly basePolicy: DestructivePolicy;
  private readonly allowDestructive: boolean | undefined;
  private readonly traceScope: TraceScope | undefined;
  /** Cancelación del turno en curso, cuando la creó el host. */
  private turnAbort: AbortController | null = null;
  private disposed = false;

  private constructor(
    opts: SessionHostOptions,
    parts: {
      config: StratumConfig;
      registry: ToolRegistry;
      mcp: McpManager;
      mcpWarnings: McpManagerWarning[];
      plugins: PluginHost;
    },
  ) {
    this.env = opts.env;
    this.config = parts.config;
    this.router = opts.router;
    this.registry = parts.registry;
    this.mcp = parts.mcp;
    this.mcpWarnings = parts.mcpWarnings;
    this.plugins = parts.plugins;
    this.sessionId = opts.sessionId ?? generateSessionId();
    this.interactions = new PendingInteractions({
      ...(opts.gates ? { local: opts.gates } : {}),
      ...(opts.interactionTimeoutMs ? { timeoutMs: opts.interactionTimeoutMs } : {}),
      ...(opts.remoteApprovals ? { remote: opts.remoteApprovals } : {}),
    });
    this.basePolicy = opts.destructivePolicy ?? 'ask';
    this.allowDestructive = opts.allowDestructive;

    this.planStore = new PlanStore(this.env.cwd);
    this.subagentStore = new SubagentStore(this.env.cwd);
    this.trace = openSessionTrace(this.config, this.sessionId, {
      cwd: this.env.cwd,
      ...(opts.version !== undefined ? { version: opts.version } : {}),
    });
    this.traceScope = this.trace?.scope();
    this.interactions.subscribe((change) => this.traceResolution(change));
    this.agent = new StratumAgent(this.config, this.router, this.registry, {
      ...opts.agent,
      // UX-1: misma clave de sesión para snapshots que para trazas y store.
      sessionId: this.sessionId,
      ...(opts.preset === 'assistant'
        ? { promptPreset: 'assistant', workspace: assistantWorkspace(this.env.cwd) }
        : opts.preset === 'companion'
          ? { promptPreset: 'companion' }
          : {}),
      ...(this.plugins.size > 0 ? { plugins: this.plugins } : {}),
      env: this.env,
    });
    this.plugins.startSession({
      sessionId: this.sessionId,
      cwd: this.env.cwd,
      worktree: findWorktreeRoot(this.env.cwd).worktree,
      resumed:
        (opts.agent?.initialMessages?.length ?? 0) > 0 ||
        opts.agent?.conversation?.restore === true,
    });
  }

  /**
   * Monta la sesión, en este orden: tools propias → servers MCP → agente.
   * Asíncrono por MCP: con `mcp: 'eager'` las tools de los servers quedan
   * registradas **antes** de crear el agente.
   */
  static async create(opts: SessionHostOptions): Promise<SessionHost> {
    // Copia propia: de la identidad de este objeto cuelgan el pool SSH y la
    // auditoría de la sesión (`closeSessionExecRuntime`), y dos sesiones no
    // pueden compartirla aunque partan de la misma config cargada.
    // Un agente embebido (asistente o companion): toolset cerrado, sin MCP ni plugins.
    const embedded = opts.preset !== undefined;
    let config: StratumConfig = { ...opts.config };
    let registry: ToolRegistry;
    if (opts.preset === 'companion') {
      config = buildCompanionConfig(config, opts.companionDataDir ?? companionDataDir());
      registry = buildCompanionRegistry(config);
    } else if (opts.preset === 'assistant') {
      const dataDir = opts.assistantData?.dir ?? assistantDataDir();
      const legacy =
        opts.assistantData?.legacyMemoryDir === undefined
          ? legacyAssistantMemoryDir()
          : opts.assistantData.legacyMemoryDir;
      if (legacy) migrateLegacyAssistantMemory(dataDir, legacy);
      // Con un `assistantData` propio (tests, fixtures) solo se importa si lo
      // pide: la marca se escribe junto al original y no debe tocar el real.
      const legacyGlobal = opts.assistantData
        ? (opts.assistantData.legacyGlobalDecisionsDir ?? null)
        : legacyGlobalDecisionsDir();
      if (legacyGlobal) importLegacyGlobalDecisions(dataDir, legacyGlobal);
      config = buildAssistantConfig(config, dataDir);
      registry = buildAssistantRegistry();
    } else {
      registry = new ToolRegistry();
      registerBuiltinTools(registry, config);
    }

    // Los servers MCP nacen en el directorio de la sesión, no en el del proceso.
    // Los agentes embebidos no tienen: sus tools son las suyas y nada más.
    const mcp = new McpManager(config, undefined, { cwd: opts.env.cwd });
    const mcpWarnings: McpManagerWarning[] = [];
    if (!embedded && (opts.mcp ?? 'eager') === 'eager' && config.mcp.servers.length > 0) {
      mcpWarnings.push(...(await mcp.connectAll()));
      mcpWarnings.push(...mcp.registerInto(registry));
      // Un server que se cuelga durante una sesión larga se detecta y se relanza.
      mcp.startHeartbeat();
    }
    // PL1: los agentes embebidos no cargan plugins (su toolset es cerrado); el
    // resto, los globales más lo que pidan los flags de quien aloja.
    const plugins = embedded
      ? PluginHost.empty(false)
      : await loadPlugins({
          cwd: opts.env.cwd,
          config,
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.plugins?.disabled ? { disabled: true } : {}),
          ...(opts.plugins?.paths ? { paths: opts.plugins.paths } : {}),
        });
    return new SessionHost(opts, { config, registry, mcp, mcpWarnings, plugins });
  }

  /** Sustituye los prompts locales (p. ej. cuando dependen de la política ya resuelta). */
  setGates(gates: HostGates): void {
    this.interactions.setLocal(gates);
  }

  /** Quién resolvió cada solicitud queda en la traza y en la auditoría de la sesión. */
  private traceResolution(change: InteractionChange): void {
    recordResolution(
      { config: this.config, sessionId: this.sessionId, trace: this.traceScope },
      change,
    );
  }

  /** Política destructiva vigente: la base, endurecida por el perfil principal activo. */
  get destructivePolicy(): DestructivePolicy {
    return strictestPolicy(this.basePolicy, this.agent.getActiveProfile()?.destructivePolicy);
  }

  /**
   * `RunOptions` de un turno de esta sesión. Un único sitio donde se cablean
   * id, traza, política, puertas y persistencia: `run`, `runDelegate` y quien
   * necesite llamar al agente por su cuenta parten de aquí.
   */
  runOptions(turn: TurnOptions = {}): RunOptions {
    // Las puertas del turno: existen solo si alguien puede contestarlas, y lo
    // que quede pendiente se cancela con el turno.
    const gates = this.interactions.gatesFor({ signal: turn.signal });
    return {
      signal: turn.signal,
      sessionId: this.sessionId,
      trace: this.traceScope,
      allowDestructive: this.allowDestructive,
      destructivePolicy: this.destructivePolicy,
      onConfirmDestructive: gates.confirm,
      onAskQuestions: gates.askQuestions,
      onApprovePlan: gates.approvePlan,
      onSubagentPersist: (rec) => this.subagentStore.persist(rec),
      ...(turn.onPlanPersist ? { onPlanPersist: turn.onPlanPersist } : {}),
      ...(turn.mode ? { mode: turn.mode } : {}),
      ...(turn.compressionMode ? { compressionMode: turn.compressionMode } : {}),
    };
  }

  /**
   * Persistencia incremental de un plan en `.stratum/plans/` del proyecto de la
   * sesión. Una ref por tarea: se pasa como `onPlanPersist` a los turnos que
   * puedan producir o ejecutar ese plan.
   */
  planPersister(task: string): { ref: string; persist: (plan: Plan) => void } {
    const ref = generatePlanId();
    const createdAt = new Date().toISOString();
    return { ref, persist: (plan) => this.planStore.save(ref, task, plan, createdAt) };
  }

  /** Un turno del agente principal. */
  run(input: string, turn: TurnOptions = {}): AsyncGenerator<AgentEvent> {
    return this.withTurnSignal(turn, (opts) => this.agent.run(input, opts));
  }

  /** Entrega la tarea a un subagente sin pasar por el agente principal. */
  runDelegate(profile: string, task: string, turn: TurnOptions = {}): AsyncGenerator<AgentEvent> {
    return this.withTurnSignal(turn, (opts) => this.agent.runDelegate(profile, task, opts));
  }

  private async *withTurnSignal(
    turn: TurnOptions,
    start: (opts: RunOptions) => AsyncGenerator<AgentEvent>,
  ): AsyncGenerator<AgentEvent> {
    let own: AbortController | null = null;
    let signal = turn.signal;
    if (!signal) {
      own = new AbortController();
      this.turnAbort = own;
      signal = own.signal;
    }
    try {
      yield* start(this.runOptions({ ...turn, signal }));
    } finally {
      if (own && this.turnAbort === own) this.turnAbort = null;
    }
  }

  /**
   * Cancela el turno en curso, si su señal la creó el host. Un turno lanzado
   * con una `signal` propia lo cancela quien la tiene.
   */
  cancel(): void {
    this.turnAbort?.abort();
  }

  /**
   * Pausa cooperativa del turno en curso (`agent/pause.ts`): desde su siguiente
   * punto seguro el runtime no empieza nada nuevo —ni petición al modelo, ni
   * tool, ni subagente—. Lo que ya está en marcha termina y los jobs siguen.
   * No cancela: `cancel()` funciona igual con el turno en pausa.
   */
  pause(): PauseRequestStatus {
    return this.agent.pause.requestPause();
  }

  /** Retira la pausa: el mismo turno continúa desde donde esperaba. */
  resume(): ResumeStatus {
    return this.agent.pause.resume();
  }

  /** `paused` solo cuando el runtime ya no avanza; `pause-requested` mientras llega. */
  get pauseState(): PauseState {
    return this.agent.pause.state;
  }

  /** Mensaje del usuario con el turno en curso (Runtime Inbox). Nunca cancela. */
  steer(text: string): ReturnType<StratumAgent['enqueueUserMessage']> {
    return this.agent.enqueueUserMessage(text);
  }

  /**
   * Desmonta la sesión: servers MCP, jobs, conexiones SSH, auditoría y traza
   * **de esta sesión**. No toca nada de otra sesión del mismo proceso. Cada paso
   * por separado, para que un fallo no deje el resto sin cerrar. Idempotente.
   *
   * `cancelBackground`: corta además el trabajo en segundo plano del agente (la
   * extracción de memoria en vuelo). Sin ello se deja terminar, como hace la
   * salida normal de la CLI.
   */
  async dispose(opts: { cancelBackground?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.turnAbort?.abort();
    // Nada queda esperando a una persona: cada puerta recibe su respuesta negativa.
    this.interactions.cancelAll();
    await this.settle('mcp shutdown', () => this.mcp.shutdownAll());
    // `session.end` antes de cerrar jobs y SSH: el plugin aún ve la sesión entera.
    await this.settle('plugins', () => this.plugins.dispose('closed'));
    await this.settle('exec runtime', () => closeSessionExecRuntime(this.config, this.agent.jobs));
    if (opts.cancelBackground) {
      await this.settle('background work', () => this.agent.cancelBackgroundWork());
    }
    await this.settle('subagent store', () => this.subagentStore.dispose());
    await this.settle('lsp dispose', () => this.agent.dispose());
    await this.settle('trace flush', () => this.trace?.flush());
  }

  private async settle(step: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.warn('teardown step failed', { step, sessionId: this.sessionId, err });
    }
  }
}
