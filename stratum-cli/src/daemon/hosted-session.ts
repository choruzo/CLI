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
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionHostInfo,
  ProtocolRevertPlan,
  ProtocolSessionSnapshot,
  ResumeStatus,
  RevertStatus,
  StateEventData,
  SteerStatus,
} from '../protocol/index.js';
import { REVERT_LIMITS } from '../protocol/index.js';
import type { RevertPlan } from '../snapshots/store.js';
import type { SessionEnv } from '../runtime/session-env.js';
import { handoffAgentOptions } from '../host/handoff.js';
import { SessionHost, type SessionHostOptions } from '../host/session-host.js';
import type { AssistantData } from '../host/assistant.js';
import { SessionPublisher, type PublisherSink } from '../host/session-publisher.js';
import { getLogger } from '../logging/index.js';
import { embeddedAgentName, embeddedPresetOf } from '../agent/presets.js';
import type { ArchivedSession, SessionFiles, SessionMeta } from './session-archive.js';
import { SESSION_META_SCHEMA_VERSION } from './session-archive.js';

const log = getLogger('daemon').child('session');

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
  /** Home de los snapshots de deshacer (UX-1). Ausente: el del usuario. Tests. */
  snapshotsHome?: string;
  /** ¿Hay quien pueda resolver en remoto lo que la sesión pida? */
  remoteApprovals: () => boolean;
  /** Plazo de una solicitud sin contestar. `0` = sin plazo. */
  approvalTimeoutMs: number;
  /** M11 — su conversación duradera y dónde guardar ajustes y foto. */
  files: SessionFiles;
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

  private constructor(
    readonly host: SessionHost,
    readonly publisher: SessionPublisher,
    private readonly files: SessionFiles,
    private readonly version: string,
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
    });
    return new HostedSession(host, publisher, opts.files, opts.version);
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
    opts: Omit<HostedSessionOptions, 'readOnly' | 'sessionProfile' | 'agent'> & {
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
    opts: Omit<HostedSessionOptions, 'readOnly' | 'sessionProfile' | 'agent'> & {
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
    });
    return new HostedSession(host, publisher, opts.files, opts.version);
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
      | 'companionDataDir'
      | 'snapshotsHome'
    >,
    agent: NonNullable<SessionHostOptions['agent']>,
    preset: SessionHostOptions['preset'] | null = null,
  ): Promise<SessionHost> {
    const host = await SessionHost.create({
      ...(preset ? { preset } : {}),
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
  startRun(input: string, mode: 'normal' | 'plan' = 'normal'): ProtocolRun {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.pump) throw new ProtocolError('BUSY', 'The session already has a run in progress.');
    if (this.reverting) throw new ProtocolError('BUSY', 'The session is reverting files.');

    this.publisher.expectRun({ mode, input });
    const turn = this.host.run(
      mode === 'plan' ? PLAN_MODE_PROMPT.replaceAll('$ARGUMENTS', input) : input,
      mode === 'plan' ? { mode: 'plan' } : {},
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

  steer(text: string): SteerStatus {
    return this.host.steer(text).status;
  }

  private assertIdle(): void {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.pump) throw new ProtocolError('BUSY', 'Not while a run is in progress.');
    if (this.reverting) throw new ProtocolError('BUSY', 'The session is reverting files.');
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
      // Un revert no se corta a medias: termina antes de desmontar.
      if (this.reverting) await this.reverting.catch(() => undefined);
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
