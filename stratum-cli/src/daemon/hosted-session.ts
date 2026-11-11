/**
 * Una sesión alojada en el daemon: su `SessionHost`, su publicador y el turno
 * que tenga en curso. El daemon la **conduce** (lanza turnos y los consume),
 * pero la sesión se monta por la única vía que hay: `SessionHost.create`.
 *
 * Una sesión del daemon no tiene terminal: lo que pida a una persona —una
 * aprobación, una tanda de preguntas, la decisión de un plan— solo lo puede
 * contestar un cliente con la capacidad `approve`, a través del centro de
 * aprobaciones, y **caduca** a la respuesta negativa si nadie contesta. Si el
 * daemon no acredita aprobadores, no hay a quién preguntar y se comporta como
 * `stratum run` sin terminal: lo destructivo se deniega, las preguntas se
 * contestan con supuestos y un plan no se aprueba.
 *
 * M11 — toda sesión del daemon tiene su conversación duradera (`SessionFiles`:
 * store, memoria de sesión y estado del contexto, en disco o en memoria). Al
 * cerrar cada turno se guardan además sus ajustes y su foto, de modo que se
 * puede volver a montar tras reiniciar el daemon (`HostedSession.restore`).
 */
import type { StratumConfig } from '../config/schema.js';
import { PLAN_MODE_PROMPT } from '../agent/plan.js';
import { ProtocolError } from '../ipc/codec.js';
import type { ProviderRouter } from '../providers/router.js';
import type {
  ClientKind,
  ProtocolChatMessage,
  CancelStatus,
  PauseStatus,
  ProtocolHandoffContext,
  ProtocolJob,
  ProtocolBrowserAction,
  ProtocolBrowserScreen,
  ProtocolBrowserStatus,
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionHostInfo,
  ProtocolSessionInspection,
  ProtocolUndoableTurn,
  ProtocolRevertPlan,
  ProtocolSessionSnapshot,
  ResumeStatus,
  RevertStatus,
  StateEventData,
  SteerStatus,
} from '../protocol/index.js';
import { ASK_LIMITS, INSPECT_LIMITS, REVERT_LIMITS, TURNS_LIMITS } from '../protocol/index.js';
import { redactText } from '../security/redact-output.js';
import type { RevertPlan } from '../snapshots/store.js';
import type { SessionEnv } from '../runtime/session-env.js';
import { handoffAgentOptions } from '../host/handoff.js';
import { SessionHost, type SessionHostOptions } from '../host/session-host.js';
import type { AssistantData } from '../host/assistant.js';
import { SessionPublisher, type PublisherSink } from '../host/session-publisher.js';
import { getLogger } from '../logging/index.js';
import type { UserImage } from '../agent/user-images.js';
import { UserImageError } from '../images/store.js';
import { embeddedAgentName, embeddedPresetOf } from '../agent/presets.js';
import type { RoutineProposals } from '../tools/routines/propose.js';
import type { ArchivedSession, SessionFiles, SessionMeta } from './session-archive.js';
import { SESSION_META_SCHEMA_VERSION } from './session-archive.js';
import { BrowserActionError, BrowserUnavailableError } from '../browser/manager.js';
import { inspectSession } from './session-inspection.js';

const log = getLogger('daemon').child('session');

/** Un fallo del navegador de la sesión, como error del protocolo (auxiliar: la sesión sigue). */
function browserProtocolError(err: unknown): Error {
  if (err instanceof ProtocolError) return err;
  if (err instanceof BrowserUnavailableError) {
    return new ProtocolError('UNAVAILABLE', err.message, { reason: 'failed' });
  }
  if (err instanceof BrowserActionError) return new ProtocolError('INVALID_PARAMS', err.message);
  return err instanceof Error ? err : new Error(String(err));
}

type RevertParams = { turns?: number; dryRun?: boolean; force?: boolean };
type RevertOutcome = { status: RevertStatus; plan: ProtocolRevertPlan | null };

/** El plan del almacén de snapshots, recortado al tope de una respuesta. */
export function protocolRevertPlan(plan: RevertPlan): ProtocolRevertPlan {
  let truncated = false;
  const cap = (paths: string[]): string[] => {
    if (paths.length <= REVERT_LIMITS.paths) return [...paths];
    truncated = true;
    return paths.slice(0, REVERT_LIMITS.paths);
  };
  return {
    turns: plan.turns.slice(0, REVERT_LIMITS.turns),
    restore: cap(plan.restore),
    remove: cap(plan.remove),
    conflicts: cap(plan.conflicts),
    skipped: cap(plan.skipped),
    truncated,
  };
}

export const DAEMON_HOST: ProtocolSessionHostInfo = {
  kind: 'daemon',
  client: 'daemon',
  connected: true,
};

export interface HostedSessionOptions {
  sessionId: string;
  env: SessionEnv;
  config: StratumConfig;
  router: ProviderRouter;
  /** Versión de Stratum, para la cabecera de la traza. */
  version: string;
  sink: PublisherSink;
  readOnly?: boolean;
  sessionProfile?: string;
  /**
   * Perfil de agente principal con el que arranca. `assistant` (M12) no es un
   * perfil: monta la sesión con el preset del asistente (`host/assistant.ts`).
   */
  agent?: string;
  /** M12 — desde qué cliente se abrió (`ProtocolSession.origin`). Solo procedencia. */
  origin?: ClientKind;
  /** M12 — dónde guarda el asistente su memoria (`SessionHostOptions.assistantData`). */
  assistantData?: AssistantData;
  /** M14 — dónde guarda el `companion` lo suyo (`SessionHostOptions.companionDataDir`). */
  companionDataDir?: string;
  /** M19 fase 3 — carpeta de sesiones donde busca `search_conversations` (solo agentes embebidos). */
  transcriptsDir?: string;
  /** Home de los snapshots de deshacer (UX-1). Ausente: el del usuario. Tests. */
  snapshotsHome?: string;
  /** ¿Hay quien pueda resolver en remoto lo que la sesión pida? */
  remoteApprovals: () => boolean;
  /** Plazo de una solicitud sin contestar. `0` = sin plazo. */
  approvalTimeoutMs: number;
  /** M11 — su conversación duradera y dónde guardar ajustes y foto. */
  files: SessionFiles;
  /** M16 — la rutina a la que pertenece la sesión. Solo la abre el planificador del daemon. */
  routineId?: string;
  /**
   * M16 — dónde crea el `companion` una rutina aprobada (`propose_routine`).
   * Solo llega a su sesión principal: una sesión de rutina no propone rutinas.
   */
  routineProposals?: RoutineProposals;
}

/** Cuánto se espera a que un turno cancelado termine de cerrarse. */
const RUN_SETTLE_MS = 10_000;

export class HostedSession {
  private pump: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  /**
   * El `sessions.revert` en marcha: ni turnos ni otro revert hasta que acabe, y
   * `close()` lo espera (el registro ya no tiene esos turnos y el disco quedaría
   * a medias).
   */
  private reverting: Promise<unknown> | null = null;
  /** Cierre de M14 — compactándose para archivarse: nada arranca mientras. */
  private archiving: { job: Promise<unknown>; abort: AbortController } | null = null;

  private constructor(
    readonly host: SessionHost,
    readonly publisher: SessionPublisher,
    private readonly files: SessionFiles,
    private readonly version: string,
    /** M16 — la rutina dueña de esta sesión, o `null`. */
    readonly routineId: string | null = null,
  ) {}

  /** La conversación publicada, al store según aparece (también lo que la foto ya no lleva). */
  private static transcriptTo(files: SessionFiles): (messages: ProtocolChatMessage[]) => void {
    return (messages) => {
      for (const m of messages) files.conversation.store.putChat(m);
    };
  }

  /**
   * Monta la sesión. Aún no publica nada: `publisher.start()` lo llama quien la
   * registra, cuando ya hay dónde recibir sus eventos.
   *
   * @throws ProtocolError `INVALID_PARAMS` si el perfil de agente no vale.
   */
  static async open(opts: HostedSessionOptions): Promise<HostedSession> {
    const preset = embeddedPresetOf(opts.agent);
    const host = await HostedSession.mount(
      opts,
      {
        readOnly: opts.readOnly === true,
        // Un agente embebido no tiene perfil de sesión (Hito 17): es de código.
        ...(opts.sessionProfile && !preset ? { sessionProfile: opts.sessionProfile } : {}),
        conversation: { conversation: opts.files.conversation },
      },
      preset,
      opts.routineId ? undefined : opts.routineProposals,
      opts.routineId !== undefined,
    );
    if (opts.agent && !preset) {
      const applied = host.agent.setPrimaryProfile(opts.agent);
      if (!applied.ok) {
        await host.dispose({ cancelBackground: true });
        throw new ProtocolError('INVALID_PARAMS', applied.error, {
          issues: [{ path: 'agent', message: 'unknown or unusable agent profile' }],
        });
      }
    }
    const publisher = new SessionPublisher({
      host,
      hostInfo: DAEMON_HOST,
      sink: opts.sink,
      onTranscript: HostedSession.transcriptTo(opts.files),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.routineId ? { routineId: opts.routineId } : {}),
    });
    return new HostedSession(host, publisher, opts.files, opts.version, opts.routineId ?? null);
  }

  /**
   * M10 — monta aquí una sesión que **traspasa** su anfitrión par: el mismo id,
   * el contexto del agente que entregó (rehidratado como una sesión reanudada)
   * y un publicador que continúa desde la foto que el daemon ya tenía (`seq`,
   * conversación, último run). Tampoco publica nada hasta `publisher.start()`,
   * que anuncia el cambio de anfitrión; hasta entonces se puede desmontar sin
   * que nadie lo vea.
   *
   * @throws ProtocolError `NOT_TRANSFERABLE` (`startup`) si el perfil principal
   *   que tenía la sesión no se puede activar aquí: continuar con otro sería
   *   cambiarle el agente sin decirlo.
   */
  static async adopt(
    opts: Omit<
      HostedSessionOptions,
      'readOnly' | 'sessionProfile' | 'agent' | 'routineId' | 'routineProposals'
    > & {
      context: ProtocolHandoffContext;
      snapshot: ProtocolSessionSnapshot;
    },
  ): Promise<HostedSession> {
    // M11 — lo que ya se veía de la conversación queda guardado desde ya; el
    // historial del agente lo registra el propio agente al montarse.
    for (const m of opts.snapshot.messages) opts.files.conversation.store.putChat(m);
    const preset = embeddedPresetOf(opts.context.agent);
    const { sessionProfile, ...agentOptions } = handoffAgentOptions(opts.context);
    const host = await HostedSession.mount(
      opts,
      {
        ...agentOptions,
        // Un agente embebido no tiene perfil de sesión (como en `open` y `restore`).
        ...(preset ? {} : { sessionProfile }),
        conversation: { conversation: opts.files.conversation },
      },
      preset,
    );
    const wanted = opts.context.agent;
    if (wanted && !preset && host.agent.getActiveProfile()?.name !== wanted) {
      await host.dispose({ cancelBackground: true });
      throw new ProtocolError(
        'NOT_TRANSFERABLE',
        `The agent profile "${wanted}" cannot be used by the daemon.`,
        { reason: 'startup' },
      );
    }
    const publisher = new SessionPublisher({
      host,
      hostInfo: DAEMON_HOST,
      sink: opts.sink,
      continueFrom: opts.snapshot,
      onTranscript: HostedSession.transcriptTo(opts.files),
    });
    return new HostedSession(host, publisher, opts.files, opts.version);
  }

  /**
   * M11 — vuelve a montar una sesión guardada tras reiniciar el daemon: el
   * mismo id, sus ajustes, el contexto activo que tenía (reconstruido desde
   * su `ConversationStore`) y su memoria de sesión, con un publicador que
   * continúa desde su última foto (`continueFrom`, ya saneada: lo que estaba
   * en marcha cuando murió el daemon queda `interrupted`). Lo del proceso
   * anterior (jobs, SSH, MCP, pendientes) no vuelve: se monta lo de este.
   *
   * @throws ProtocolError `UNAVAILABLE` (`startup`) si su perfil principal ya
   *   no se puede activar: continuar con otro sería cambiarle el agente.
   */
  static async restore(
    opts: Omit<HostedSessionOptions, 'readOnly' | 'sessionProfile' | 'agent' | 'routineId'> & {
      archived: ArchivedSession;
      snapshot: ProtocolSessionSnapshot;
    },
  ): Promise<HostedSession> {
    const { meta } = opts.archived;
    const preset = embeddedPresetOf(meta.agent);
    const host = await HostedSession.mount(
      opts,
      {
        readOnly: meta.readOnly,
        ...(preset ? {} : { sessionProfile: meta.sessionProfile }),
        ...(meta.agent && !preset ? { activeAgent: meta.agent } : {}),
        ...(meta.planRef ? { planRef: meta.planRef } : {}),
        usage: meta.usage,
        conversation: { conversation: opts.files.conversation, restore: true },
      },
      preset,
      meta.routineId ? undefined : opts.routineProposals,
      meta.routineId !== undefined,
    );
    if (meta.agent && !preset && host.agent.getActiveProfile()?.name !== meta.agent) {
      await host.dispose({ cancelBackground: true });
      throw new ProtocolError(
        'UNAVAILABLE',
        `The agent profile "${meta.agent}" of this session cannot be used anymore.`,
        { reason: 'startup' },
      );
    }
    const publisher = new SessionPublisher({
      host,
      hostInfo: DAEMON_HOST,
      sink: opts.sink,
      continueFrom: opts.snapshot,
      onTranscript: HostedSession.transcriptTo(opts.files),
      ...(meta.routineId ? { routineId: meta.routineId } : {}),
    });
    return new HostedSession(host, publisher, opts.files, opts.version, meta.routineId ?? null);
  }

  /** Ajustes para volver a montarla. Sin entorno, claves ni handles. */
  private meta(): SessionMeta {
    const agent = this.host.agent;
    const session = this.publisher.session();
    const tokens = agent.getTokenUsage();
    return {
      schemaVersion: SESSION_META_SCHEMA_VERSION,
      sessionId: this.sessionId,
      cwd: this.host.env.cwd,
      provider: agent.providerName,
      model: agent.model,
      agent: embeddedAgentName(agent.promptPreset) ?? agent.getActiveProfile()?.name ?? null,
      readOnly: agent.isReadOnly(),
      sessionProfile: agent.getSessionProfileRequest(),
      planRef: agent.getPlanRef(),
      ...(this.routineId ? { routineId: this.routineId } : {}),
      usage: {
        toolCalls: agent.toolCallCount,
        tokens: tokens.status === 'reported' ? (tokens.tokens ?? 0) : null,
        tokenStatus: tokens.status,
      },
      writtenBy: this.version,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  /**
   * Guarda ajustes y foto (fin de turno, cambio de ajustes, apagado). La
   * conversación ya está en el store. Un fallo se registra: la sesión sigue.
   */
  persist(): void {
    try {
      this.files.saveMeta(this.meta());
      this.files.saveSnapshot(this.publisher.snapshot());
    } catch (err) {
      log.error('session not persisted', { sessionId: this.sessionId, err });
    }
  }

  /** La conversación duradera de la sesión (M11). */
  get conversation(): SessionFiles['conversation'] {
    return this.files.conversation;
  }

  private static async mount(
    opts: Pick<
      HostedSessionOptions,
      | 'env'
      | 'config'
      | 'router'
      | 'sessionId'
      | 'version'
      | 'remoteApprovals'
      | 'approvalTimeoutMs'
      | 'assistantData'
      | 'transcriptsDir'
      | 'companionDataDir'
      | 'snapshotsHome'
    >,
    agent: NonNullable<SessionHostOptions['agent']>,
    preset: SessionHostOptions['preset'] | null = null,
    routineProposals?: RoutineProposals,
    /** M16/M17 — la sesión de una rutina: sin concesiones temporales. */
    routine = false,
  ): Promise<SessionHost> {
    const host = await SessionHost.create({
      ...(preset ? { preset } : {}),
      ...(preset === 'companion' && routineProposals ? { routineProposals } : {}),
      ...(preset && opts.transcriptsDir ? { transcriptsDir: opts.transcriptsDir } : {}),
      ...(preset === 'assistant' && opts.assistantData
        ? { assistantData: opts.assistantData }
        : {}),
      ...(preset === 'companion' && opts.companionDataDir
        ? { companionDataDir: opts.companionDataDir }
        : {}),
      env: opts.env,
      config: opts.config,
      router: opts.router,
      sessionId: opts.sessionId,
      version: opts.version,
      mcp: 'eager',
      // Sin prompts locales: pregunta solo si un aprobador remoto puede contestar.
      // Sin aprobadores acreditados no hay a quién preguntar, y la política es
      // la de una sesión sin terminal: denegar (también en un entorno `allow`).
      destructivePolicy: opts.remoteApprovals() ? 'ask' : 'deny',
      remoteApprovals: opts.remoteApprovals,
      interactionTimeoutMs: opts.approvalTimeoutMs,
      ...(routine ? { approvalGrants: false } : {}),
      agent: opts.snapshotsHome ? { ...agent, snapshotsHome: opts.snapshotsHome } : agent,
    });
    for (const warning of host.mcpWarnings) {
      log.warn('mcp warning', { sessionId: host.sessionId, message: warning.message });
    }
    return host;
  }

  get sessionId(): string {
    return this.host.sessionId;
  }

  get running(): boolean {
    return this.pump !== null;
  }

  /**
   * Resuelve cuando no hay run en curso (en el acto si ya no lo hay). Nunca
   * rechaza: el fallo de un turno ya se registró y se publicó.
   */
  idle(): Promise<void> {
    return this.pump ?? Promise.resolve();
  }

  session(): ProtocolSession {
    return this.publisher.session();
  }

  snapshot(): ProtocolSessionSnapshot {
    return this.publisher.snapshot();
  }

  jobs(): ProtocolJob[] {
    return this.publisher.snapshot().jobs;
  }

  /**
   * Lanza un turno y devuelve su run en cuanto existe; el turno sigue por su
   * cuenta y se sigue por eventos.
   *
   * @throws ProtocolError `BUSY` si ya hay uno en curso.
   */
  startRun(
    input: string,
    mode: 'normal' | 'plan' = 'normal',
    options: {
      maxIterations?: number;
      images?: readonly string[];
      /** M18 parte 6E — imágenes ya cargadas dentro del daemon (una foto de Telegram). */
      imageData?: readonly UserImage[];
      via?: ProtocolRun['via'];
    } = {},
  ): ProtocolRun {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.pump) throw new ProtocolError('BUSY', 'The session already has a run in progress.');
    if (this.reverting) throw new ProtocolError('BUSY', 'The session is reverting files.');
    if (this.archiving) throw new ProtocolError('BUSY', 'The conversation is being archived.');
    const images = [...this.loadImages(options.images), ...(options.imageData ?? [])];

    this.publisher.expectRun({ mode, input, ...(options.via ? { via: options.via } : {}) });
    const turn = this.host.run(
      mode === 'plan' ? PLAN_MODE_PROMPT.replaceAll('$ARGUMENTS', input) : input,
      {
        ...(mode === 'plan' ? { mode: 'plan' as const } : {}),
        ...(options.maxIterations ? { maxIterations: options.maxIterations } : {}),
        ...(images.length > 0 ? { images } : {}),
      },
    );
    // El arranque del turno es síncrono hasta su primera espera: al volver de
    // `next()`, el publicador ya ha visto `turn_started` y el run existe.
    const first = turn.next();
    const pump = (async () => {
      try {
        let step = await first;
        while (!step.done) step = await turn.next();
      } catch (err) {
        log.error('run failed', { sessionId: this.sessionId, err });
      } finally {
        this.pump = null;
        // El cierre del run sale ya, no en la siguiente vuelta.
        this.publisher.flush();
        this.persist();
      }
    })();
    this.pump = pump;

    const run = this.publisher.activeRun;
    if (!run) throw new Error('the turn did not start');
    this.publisher.flush();
    return run;
  }

  /**
   * Cancela el turno en curso. Con `runId`, solo si sigue siendo ese.
   *
   * @throws ProtocolError `STALE_STATE` si `runId` ya no es el run en curso.
   */
  cancel(runId?: string): CancelStatus {
    if (!this.current(runId)) return 'not-running';
    this.host.cancel();
    return 'cancelled';
  }

  /** El run en curso; con `runId`, tiene que seguir siendo ese. */
  private current(runId: string | undefined): ProtocolRun | null {
    const active = this.publisher.activeRun;
    if (runId !== undefined && active?.id !== runId) {
      throw new ProtocolError('STALE_STATE', 'That run is no longer the current one.');
    }
    return active;
  }

  /**
   * Pausa cooperativa del turno en curso. No espera a que se alcance: el run
   * pasa a `paused` —y la sesión lo publica— en su siguiente punto seguro.
   *
   * @throws ProtocolError `STALE_STATE` si `runId` ya no es el run en curso.
   */
  pause(runId?: string): PauseStatus {
    if (!this.current(runId)) return 'not-running';
    return this.host.pause();
  }

  /** Retira la pausa: el mismo run continúa. */
  resume(runId?: string): ResumeStatus {
    if (!this.current(runId)) return 'not-running';
    return this.host.resume();
  }

  steer(
    text: string,
    imagePaths?: readonly string[],
    imageData: readonly UserImage[] = [],
  ): SteerStatus {
    return this.host.steer(text, [...this.loadImages(imagePaths), ...imageData]).status;
  }

  /**
   * Las imágenes de un mensaje, leídas solo del `cwd` de la sesión o de
   * `~/.stratum/images` (`loadUserImages`). Una que no vale rechaza el
   * mensaje entero con `INVALID_PARAMS`: nada se arranca ni se encola.
   */
  private loadImages(paths: readonly string[] | undefined): UserImage[] {
    if (!paths?.length) return [];
    try {
      return this.host.loadImages(paths);
    } catch (err) {
      if (err instanceof UserImageError) throw new ProtocolError('INVALID_PARAMS', err.message);
      throw err;
    }
  }

  /** La pregunta lateral en curso (`sessions.ask`), si la hay. */
  private asking: AbortController | null = null;

  private assertIdle(): void {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.pump) throw new ProtocolError('BUSY', 'Not while a run is in progress.');
    if (this.reverting) throw new ProtocolError('BUSY', 'The session is reverting files.');
    if (this.archiving) throw new ProtocolError('BUSY', 'The conversation is being archived.');
  }

  /** El estado del navegador del agente de la sesión (nunca lo arranca). */
  async browserStatus(): Promise<ProtocolBrowserStatus> {
    const browser = this.host.agent.browser;
    if (!browser) return { state: 'unavailable', reason: this.noBrowserReason() };
    return browser.status();
  }

  /**
   * `browser.screen`: estado y la pestaña en JPEG, otra captura con orden fija
   * (no la que ve el agente, no toca su `ScreenshotBuffer` y no se guarda).
   */
  async browserScreen(
    maxBytes: number,
  ): Promise<{ browser: ProtocolBrowserStatus; screen: ProtocolBrowserScreen | null }> {
    const browser = this.host.agent.browser;
    const status = await this.browserStatus();
    if (!browser || status.state !== 'open') return { browser: status, screen: null };
    try {
      const shot = await browser.screen(maxBytes);
      return { browser: status, screen: shot ? { mime: 'image/jpeg', ...shot } : null };
    } catch (err) {
      throw browserProtocolError(err);
    }
  }

  /**
   * `browser.navigate`: la persona mueve el navegador. Solo en reposo (con un
   * run, el navegador es del agente) y solo hacia lo local o ya aprobado:
   * `control` no aprueba orígenes, eso es de la confirmación de `browser_navigate`.
   *
   * @throws ProtocolError `BUSY`, `INVALID_PARAMS` (`needs-approval`, `blocked-url`),
   *   `UNAVAILABLE` (sin navegador, cerrado o caído).
   */
  async browserNavigate(
    action: ProtocolBrowserAction,
    url: string | undefined,
  ): Promise<{ browser: ProtocolBrowserStatus }> {
    this.assertIdle();
    const browser = this.host.agent.browser;
    if (!browser) {
      throw new ProtocolError('UNAVAILABLE', 'This session has no browser.', {
        reason: this.noBrowserReason(),
      });
    }
    try {
      if (action === 'goto') {
        const verdict = browser.inspect(url ?? '');
        if (verdict.class === 'blocked') {
          throw new ProtocolError(
            'INVALID_PARAMS',
            `That URL cannot be opened: ${verdict.reason ?? 'blocked'}.`,
            {
              reason: 'blocked-url',
            },
          );
        }
        if (verdict.class === 'external') {
          throw new ProtocolError(
            'INVALID_PARAMS',
            'That site has not been approved in this session: the agent asks for it with browser_navigate.',
            { reason: 'needs-approval' },
          );
        }
        await browser.navigate(url ?? '');
      } else {
        if (browser.state !== 'open') {
          throw new ProtocolError('UNAVAILABLE', 'The browser is not open.', {
            reason: 'browser-closed',
          });
        }
        await browser.history(action);
      }
    } catch (err) {
      throw browserProtocolError(err);
    }
    return { browser: await browser.status() };
  }

  /** Por qué una sesión sin navegador no lo tiene. */
  private noBrowserReason(): string {
    if (this.host.agent.promptPreset === 'companion') return 'not-supported';
    if (!this.host.config.tools.browser.enabled) return 'disabled';
    return 'not-found';
  }

  /**
   * Cierre de M14 — antes de archivar esta conversación (una conversación nueva
   * del `companion`): solo en reposo, y nada arranca mientras se compacta.
   *
   * @throws ProtocolError `BUSY`, `UNAVAILABLE` (cerrándose).
   */
  async compactForArchive(): ReturnType<SessionHost['agent']['compactForArchive']> {
    this.assertIdle();
    const abort = new AbortController();
    const job = this.host.agent.compactForArchive(abort.signal);
    this.archiving = { job, abort };
    try {
      return await job;
    } finally {
      this.archiving = null;
    }
  }

  /**
   * `sessions.revert`: deshace los ficheros de los últimos `turns` turnos con
   * el mismo `StratumAgent.planRevert`/`revertTurns` que `/undo`. Solo en reposo,
   * y nada arranca mientras dura. Con conflictos y sin `force` no toca nada. El
   * modelo lo sabe en su siguiente turno (`<files_reverted>`).
   *
   * Una sesión en solo lectura no revierte: promete que nada cambia el proyecto.
   *
   * @throws ProtocolError `BUSY`, `UNAVAILABLE` (cerrándose), `INVALID_PARAMS`
   *   (solo lectura).
   */
  async revert(params: RevertParams): Promise<RevertOutcome> {
    this.assertIdle();
    if (this.host.agent.isReadOnly()) {
      throw new ProtocolError('INVALID_PARAMS', 'A read-only session does not revert files.', {
        issues: [{ path: 'sessionId', message: 'read-only session' }],
      });
    }
    const job = this.applyRevert(params);
    this.reverting = job;
    try {
      return await job;
    } finally {
      this.reverting = null;
    }
  }

  private async applyRevert(params: RevertParams): Promise<RevertOutcome> {
    const count = params.turns ?? 1;
    const agent = this.host.agent;
    const plan = await agent.planRevert(count);
    if (plan.turns.length === 0) return { status: 'nothing', plan: null };
    if (params.dryRun) return { status: 'planned', plan: protocolRevertPlan(plan) };
    if (plan.conflicts.length > 0 && !params.force) {
      return { status: 'conflicts', plan: protocolRevertPlan(plan) };
    }
    const result = await agent.revertTurns(count, { force: params.force === true });
    if (result.ok) {
      log.info('session files reverted', {
        sessionId: this.sessionId,
        turns: result.turns,
        restored: result.restored.length,
        removed: result.removed.length,
      });
      return {
        status: 'reverted',
        plan: protocolRevertPlan({
          turns: result.turns,
          restore: result.restored,
          remove: result.removed,
          conflicts: [],
          skipped: result.skipped,
        }),
      };
    }
    switch (result.reason) {
      case 'conflicts':
        // Algo cambió entre el plan y el revert: lo de ahora manda.
        return {
          status: 'conflicts',
          plan: protocolRevertPlan({ ...plan, conflicts: result.conflicts ?? plan.conflicts }),
        };
      case 'turn-in-progress':
        throw new ProtocolError('BUSY', 'Not while a run is in progress.');
      case 'disabled':
      case 'no-turns':
        return { status: 'nothing', plan: null };
      case 'error': {
        // El detalle (git, rutas) va al log del daemon, no al cliente.
        log.error('session revert failed', { sessionId: this.sessionId, error: result.error });
        const applied = result.applied;
        return {
          status: 'failed',
          plan: applied
            ? protocolRevertPlan({
                turns: applied.turns,
                restore: applied.restored,
                remove: applied.removed,
                conflicts: [],
                skipped: [],
              })
            : null,
        };
      }
    }
  }

  /** Un aviso de la sesión (`warning`) que el daemon quiere que vean los clientes. */
  warn(message: string): void {
    this.publisher.warn(message);
    this.publisher.flush();
  }

  private changed(): ProtocolSession {
    this.publisher.sessionChanged();
    this.publisher.flush();
    this.persist();
    return this.publisher.session();
  }

  setModel(model: string, provider?: string): ProtocolSession {
    this.assertIdle();
    const agent = this.host.agent;
    if (provider !== undefined && provider !== agent.providerName) {
      // Se comprueba antes de tocar nada: un alias desconocido no cambia la sesión.
      if (!agent.providerNames.includes(provider)) {
        throw new ProtocolError('INVALID_PARAMS', 'Unknown provider.', {
          issues: [{ path: 'provider', message: 'not a configured provider' }],
        });
      }
      agent.switchProvider(provider);
    }
    agent.switchModel(model);
    return this.changed();
  }

  setAgent(agent: string | null): ProtocolSession {
    this.assertIdle();
    // Un agente embebido (asistente, companion) se elige al abrir la sesión y no
    // se cambia: es otro preset, no un perfil que se active o desactive (M12, M14).
    if (embeddedPresetOf(agent) || embeddedAgentName(this.host.agent.promptPreset)) {
      throw new ProtocolError(
        'INVALID_PARAMS',
        'An embedded agent (assistant, companion) is chosen when the session is opened and cannot be switched.',
        { issues: [{ path: 'agent', message: 'not switchable' }] },
      );
    }
    const applied = this.host.agent.setPrimaryProfile(agent);
    if (!applied.ok) {
      throw new ProtocolError('INVALID_PARAMS', applied.error, {
        issues: [{ path: 'agent', message: 'unknown or unusable agent profile' }],
      });
    }
    return this.changed();
  }

  setReadOnly(readOnly: boolean): ProtocolSession {
    this.assertIdle();
    this.host.agent.setReadOnly(readOnly);
    return this.changed();
  }

  /**
   * El perfil de sesión (`/profile`): qué tools ve el modelo desde el próximo
   * turno. No toca ninguna guarda: lo que una tool pueda hacer lo siguen
   * decidiendo `preflight`, los entornos y las confirmaciones.
   */
  setProfile(profile: string): ProtocolSession {
    this.assertIdle();
    const applied = this.host.agent.setSessionProfile(profile);
    if (!applied.ok) {
      throw new ProtocolError('INVALID_PARAMS', applied.error, {
        issues: [{ path: 'profile', message: 'unknown or unusable session profile' }],
      });
    }
    return this.changed();
  }

  /** Cómo está montada la sesión ahora (`sessions.inspect`); solo lee. */
  inspect(): ProtocolSessionInspection {
    return inspectSession(this.host);
  }

  /**
   * Pregunta lateral (`/btw`): llamada auxiliar sin tools que no toca el
   * historial, la memoria ni el uso. Una a la vez; se corta al cerrar la sesión.
   */
  async ask(question: string): Promise<{ answer: string; truncated: boolean }> {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.asking) throw new ProtocolError('BUSY', 'A side question is already in progress.');
    const controller = new AbortController();
    this.asking = controller;
    try {
      let answer = '';
      for await (const chunk of this.host.agent.askSideQuestion(question, {
        trace: this.host.trace?.scope(),
        signal: controller.signal,
      })) {
        answer += chunk;
        // Con margen: la redacción puede acortar; más no hace falta leer.
        if (answer.length > ASK_LIMITS.answerChars * 2) {
          controller.abort();
          break;
        }
      }
      const text = redactText(answer.trim(), this.host.config);
      return {
        answer: text.slice(0, ASK_LIMITS.answerChars),
        truncated: text.length > ASK_LIMITS.answerChars,
      };
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      // Un fallo auxiliar: la sesión sigue. El mensaje del provider, redactado.
      const message = redactText(
        err instanceof Error ? err.message : String(err),
        this.host.config,
      );
      throw new ProtocolError(
        'UNAVAILABLE',
        `The side question failed: ${message.slice(0, INSPECT_LIMITS.reasonChars)}`,
        { reason: this.closing ? 'closing' : 'provider-failed' },
      );
    } finally {
      this.asking = null;
    }
  }

  /** Los turnos con cambios que se pueden deshacer, el más reciente primero. */
  async undoableTurns(): Promise<ProtocolUndoableTurn[]> {
    const turns = await this.host.agent.listUndoableTurns();
    return turns.slice(0, TURNS_LIMITS.turns).map((t) => ({
      turn: t.turn,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      files: t.files.slice(0, TURNS_LIMITS.paths).map((f) => ({
        path: f.path,
        status: f.status,
        ...(f.additions !== undefined ? { additions: f.additions } : {}),
        ...(f.deletions !== undefined ? { deletions: f.deletions } : {}),
      })),
      totalFiles: t.files.length,
      skipped: t.skipped.length,
    }));
  }

  /**
   * Pasa a jobs los `exec` en primer plano (el Ctrl+B de `chat`). No relaja
   * ninguna guarda: esas llamadas ya pasaron por todas. Los jobs nuevos los
   * publica el anfitrión como cualquier otro.
   */
  backgroundJobs(): { moved: number; errors: string[] } {
    const jobs = this.host.agent.jobs;
    if (!jobs) return { moved: 0, errors: [] };
    const result = jobs.backgroundForeground();
    return {
      moved: result.jobs.length,
      errors: result.errors
        .slice(0, 64)
        .map((e) => redactText(e, this.host.config).slice(0, INSPECT_LIMITS.reasonChars)),
    };
  }

  async cancelJob(jobId: string): Promise<void> {
    const jobs = this.host.agent.jobs;
    if (!jobs?.get(jobId)) throw new ProtocolError('NOT_FOUND', 'Job not found.');
    await jobs.cancel(jobId);
  }

  /**
   * Cierra **esta** sesión: cancela su turno, desmonta su anfitrión
   * (`SessionHost.dispose()`: sus servers MCP, sus jobs, su SSH, su auditoría,
   * su traza) y publica `session.closed` como último evento. No toca nada de
   * otra sesión ni del proceso. Idempotente.
   */
  close(reason: StateEventData['session.closed']['reason']): Promise<void> {
    this.closing ??= (async () => {
      this.host.cancel();
      this.asking?.abort();
      // Un revert no se corta a medias: termina antes de desmontar.
      if (this.reverting) await this.reverting.catch(() => undefined);
      // Compactar para archivar sí se corta (no guarda nada a medias), pero se
      // espera: nada escribe en los ficheros de la sesión tras cerrarlos.
      if (this.archiving) {
        this.archiving.abort.abort();
        await this.archiving.job.catch(() => undefined);
      }
      const pump = this.pump;
      if (pump) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          pump,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, RUN_SETTLE_MS);
            timer.unref();
          }),
        ]);
        clearTimeout(timer);
      }
      // Antes de despedirse: los jobs que se cancelan al desmontar aún se publican.
      await this.host.dispose({ cancelBackground: true });
      // M11 — lo último que se guarda es el estado de antes del cierre: una
      // sesión que se apaga con el daemon vuelve con él.
      this.persist();
      try {
        this.files.close();
      } catch (err) {
        log.warn('conversation not closed', { sessionId: this.sessionId, err });
      }
      this.publisher.close(reason);
    })();
    return this.closing;
  }
}
