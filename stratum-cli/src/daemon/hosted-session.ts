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
  ProtocolSessionSnapshot,
  ResumeStatus,
  StateEventData,
  SteerStatus,
} from '../protocol/index.js';
import type { SessionEnv } from '../runtime/session-env.js';
import { handoffAgentOptions } from '../host/handoff.js';
import { SessionHost, type SessionHostOptions } from '../host/session-host.js';
import type { AssistantData } from '../host/assistant.js';
import { SessionPublisher, type PublisherSink } from '../host/session-publisher.js';
import { getLogger } from '../logging/index.js';
import { ASSISTANT_AGENT } from '../agent/presets.js';
import type { ArchivedSession, SessionFiles, SessionMeta } from './session-archive.js';
import { SESSION_META_SCHEMA_VERSION } from './session-archive.js';

const log = getLogger('daemon').child('session');

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
    const assistant = opts.agent === ASSISTANT_AGENT;
    const host = await HostedSession.mount(
      opts,
      {
        readOnly: opts.readOnly === true,
        // El asistente no tiene perfil de sesión (Hito 17): es de código.
        ...(opts.sessionProfile && !assistant ? { sessionProfile: opts.sessionProfile } : {}),
        conversation: { conversation: opts.files.conversation },
      },
      assistant,
    );
    if (opts.agent && !assistant) {
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
    const assistant = opts.context.agent === ASSISTANT_AGENT;
    const { sessionProfile, ...agentOptions } = handoffAgentOptions(opts.context);
    const host = await HostedSession.mount(
      opts,
      {
        ...agentOptions,
        // El asistente no tiene perfil de sesión (como en `open` y `restore`).
        ...(assistant ? {} : { sessionProfile }),
        conversation: { conversation: opts.files.conversation },
      },
      assistant,
    );
    const wanted = opts.context.agent;
    if (wanted && !assistant && host.agent.getActiveProfile()?.name !== wanted) {
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
    const assistant = meta.agent === ASSISTANT_AGENT;
    const host = await HostedSession.mount(
      opts,
      {
        readOnly: meta.readOnly,
        ...(assistant ? {} : { sessionProfile: meta.sessionProfile }),
        ...(meta.agent && !assistant ? { activeAgent: meta.agent } : {}),
        ...(meta.planRef ? { planRef: meta.planRef } : {}),
        usage: meta.usage,
        conversation: { conversation: opts.files.conversation, restore: true },
      },
      assistant,
    );
    if (meta.agent && !assistant && host.agent.getActiveProfile()?.name !== meta.agent) {
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
      agent:
        agent.promptPreset === 'assistant'
          ? ASSISTANT_AGENT
          : (agent.getActiveProfile()?.name ?? null),
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
    >,
    agent: NonNullable<SessionHostOptions['agent']>,
    assistant = false,
  ): Promise<SessionHost> {
    const host = await SessionHost.create({
      ...(assistant ? { preset: 'assistant' as const } : {}),
      ...(assistant && opts.assistantData ? { assistantData: opts.assistantData } : {}),
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
      agent,
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
  }

  private changed(): ProtocolSession {
    this.publisher.sessionChanged();
    this.publisher.flush();
    this.persist();
    return this.publisher.session();
  }

  setModel(model: string): ProtocolSession {
    this.assertIdle();
    this.host.agent.switchModel(model);
    return this.changed();
  }

  setAgent(agent: string | null): ProtocolSession {
    this.assertIdle();
    // El asistente se elige al abrir la sesión y no se cambia: es otro preset,
    // no un perfil que se active o desactive (M12).
    if (agent === ASSISTANT_AGENT || this.host.agent.promptPreset === 'assistant') {
      throw new ProtocolError(
        'INVALID_PARAMS',
        'The assistant agent is chosen when the session is opened and cannot be switched.',
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
