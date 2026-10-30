/**
 * `stratumd`: el plano de control local. Un proceso que aloja sesiones, las
 * publica a varios clientes y atiende sus órdenes por el Stratum Protocol.
 *
 * Qué es de quién:
 *
 *  - **Una sesión** (`HostedSession` → `SessionHost`) es dueña de su agente, sus
 *    tools, sus servers MCP, sus jobs, su SSH, su auditoría y su traza.
 *    `sessions.close` desmonta eso y **nada más**.
 *  - **El proceso** es dueño del canal, del `endpoint.json` y del runtime global
 *    de ejecución. Solo `shutdown()` los cierra (`processTeardown`).
 *  - **Un cliente** no es dueño de nada: que se desconecte no cambia ninguna
 *    sesión, y que no quede ninguno conectado no apaga el daemon.
 *
 * El runtime de cada sesión es la autoridad. Lo que guarda el daemon
 * (`RunRegistry`, el buffer del `EventHub`) es una proyección en memoria de lo
 * que las sesiones publican: no se persiste y se puede rehacer.
 *
 * M11 — lo que **sí** se guarda es cada sesión del daemon (su conversación, su
 * memoria de sesión, su contexto y sus ajustes, `SessionArchive`). Al arrancar,
 * las guardadas vuelven **sin montar** (se listan y se siguen por su foto) y se
 * montan al primer uso que necesite su runtime (`wake`): recuperar diez
 * sesiones no arranca diez veces sus servers MCP.
 */
import { constants } from 'fs';
import { access, rmdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, resolve } from 'path';
import { ProfileLoader, profileMode } from '../agent/profiles.js';
import {
  BoxBusyError,
  BoxCommandError,
  BoxManager,
  BoxScreenUnavailableError,
  BoxUnavailableError,
  type BoxStatus,
} from '../box/manager.js';
import {
  ASSISTANT_AGENT,
  COMPANION_AGENT,
  EMBEDDED_AGENTS,
  assistantAgentInfo,
  companionAgentInfo,
  embeddedPresetOf,
} from '../agent/presets.js';
import { sessionSkills } from '../skills/registry.js';
import { defaultEndpointDir, type Endpoint } from '../client/discovery.js';
import { loadConfig } from '../config/loader.js';
import type { StratumConfig } from '../config/schema.js';
import { resolveSessionStartup, type SessionStartup } from '../host/session-startup.js';
import {
  assistantCwdProblem,
  assistantDataDir,
  buildAssistantConfig,
  type AssistantData,
} from '../host/assistant.js';
import { companionDataDir, ensureCompanionWorkspace } from '../host/companion.js';
import { ProtocolError } from '../ipc/codec.js';
import type { RequestHandlers } from '../ipc/peer.js';
import { getLogger } from '../logging/index.js';
import { getDecisionMemory } from '../memory/decision-memory.js';
import {
  BOX_SCREEN_LIMITS,
  METHODS,
  STRATUM_PROTOCOL_VERSION,
  type ClientKind,
  type MethodName,
  type ProtocolEvent,
  type ProtocolModel,
  type ProtocolOverviewSnapshot,
  type ProtocolServerInfo,
  type ProtocolSession,
  type ProtocolSessionSnapshot,
  type StateEventData,
} from '../protocol/index.js';
import { fetchModelInfos } from '../providers/utils.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { generateSessionId } from '../session/store.js';
import { closeExecRuntime } from '../tools/exec/runtime.js';
import { ApprovalCenter } from './approval-center.js';
import type { ApproverAuth } from './approver-key.js';
import { ControlServer, type ClientConnection } from './control-server.js';
import { claimEndpoint, newIpcPath, newToken, type EndpointClaim } from './endpoint.js';
import { EventHub, type HubClientStats } from './event-hub.js';
import { DAEMON_HOST, HostedSession } from './hosted-session.js';
import {
  archivedContextReport,
  historyPage,
  liveContextReport,
  protocolMemory,
} from './conversation-dto.js';
import {
  SessionArchive,
  restorableSnapshot,
  type ArchivedSession,
  type SessionFiles,
} from './session-archive.js';
import { OperationCache, type OperationCacheOptions } from './operation-cache.js';
import { PeerSessions, peerHostedOnly } from './peer-sessions.js';
import { ensurePrivateDir, restrictSocket } from './private-dir.js';
import { RunRegistry } from './run-registry.js';
import { TraceFeeds } from './trace-feeds.js';
import { traceFilePath } from '../trace/store.js';

const log = getLogger('daemon');

export type ShutdownReason = 'requested' | 'signal' | 'idle';

export interface StratumdOptions {
  /** Versión de Stratum que sirve el protocolo. */
  version: string;
  /** Config **global**: de ella salen `daemon.*` y los providers de `models.list`. */
  config: StratumConfig;
  /**
   * Variables con las que las sesiones del daemon lanzan procesos: una **copia
   * tomada al arrancar** del entorno del daemon. No es el entorno de ningún
   * cliente —`sessions.open.env` sigue reservado y no se usa—, y no cambia
   * mientras el daemon vive. Reproducir el de una terminal es M10.
   */
  env: NodeJS.ProcessEnv;
  /** Carpeta del endpoint. Por defecto `~/.stratum/daemon/`. */
  dir?: string;
  /**
   * Directorio de una sesión abierta sin `cwd`. Por defecto, el *home* del
   * usuario del daemon (nunca el directorio desde el que se lanzó el proceso).
   */
  defaultCwd?: string;
  /** Arranque de una sesión (config, provider, modelo). Inyectable para tests. */
  startup?: typeof resolveSessionStartup;
  /**
   * Cierre del runtime global del **proceso**. Solo lo llama `shutdown()`; cerrar
   * una sesión nunca llega aquí.
   */
  processTeardown?: () => Promise<void>;
  /** `0` = no se apaga solo. Por defecto, `daemon.idleExitMinutes`. */
  idleExitMs?: number;
  eventBuffer?: number;
  /** Cada cuánto mira `trace.subscribe` si la traza creció (250 ms). */
  tracePollMs?: number;
  /** Home de los snapshots de deshacer de sus sesiones. Ausente: el del usuario. Tests. */
  snapshotsHome?: string;
  maxSessions?: number;
  /** Cola de eventos por suscripción. */
  subscriptionQueue?: number;
  /** Límites de salida por cliente (ver `ControlServer`). */
  highWaterBytes?: number;
  maxBufferedBytes?: number;
  operations?: OperationCacheOptions;
  /** Cuánto se conserva una sesión par sin anfitrión. Por defecto, `daemon.detachedTtlMinutes`. */
  detachedTtlMs?: number;
  /** Cada cuánto se comprueba si el proceso de un anfitrión desconectado sigue vivo. */
  peerWatchIntervalMs?: number;
  /**
   * Cómo se acredita un aprobador (ver `approver-key.ts`). Sin esto ninguna
   * conexión obtiene `approve`: nada se resuelve en remoto, y una sesión del
   * daemon deniega lo que pediría confirmación.
   */
  approver?: ApproverAuth | null;
  /** Retraso de la respuesta a una clave de aprobador errónea. Solo para tests. */
  approverFailureDelayMs?: number;
  /** Plazo de una solicitud de una sesión del daemon. Por defecto, `daemon.approvalTimeoutMinutes`. */
  approvalTimeoutMs?: number;
  /**
   * M11 — carpeta de las sesiones guardadas (`~/.stratum/daemon/sessions/`).
   * Sin ella (o `null`) las sesiones tienen su conversación en memoria y
   * mueren con el proceso. La pasa `stratum daemon` según `daemon.persistSessions`.
   */
  sessionsDir?: string | null;
  /**
   * M12 — dónde guarda su memoria el agente embebido `assistant` y de dónde la
   * migra. Ausente: `~/.stratum/assistant/` desde la de Stratum Desktop.
   */
  assistantData?: AssistantData;
  /** Home del usuario, para lo que no puede ser el directorio del asistente. Por defecto `homedir()`. */
  home?: string;
  /**
   * M14 — dónde guarda lo suyo el agente embebido `companion` (memoria y su
   * directorio de trabajo). Ausente: `<home>/.stratum/companion/`.
   */
  companionDataDir?: string;
  /** M13 — la caja (`box.*`). Por defecto, la de `config.box`. Inyectable para tests. */
  box?: BoxManager;
  /** Inyectables para tests del endpoint. */
  isAlive?: (pid: number) => boolean;
  probe?: (ipcPath: string) => Promise<boolean>;
  now?: () => number;
}

/** Ajustes de una sesión nueva que no caben en `sessions.open { resume }`. */
const RESUME_EXCLUSIVE = [
  'cwd',
  'agent',
  'provider',
  'model',
  'readOnly',
  'sessionProfile',
] as const;

function invalid(path: string, message: string): ProtocolError {
  return new ProtocolError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

/** Una orden de ciclo de vida de la caja, con sus errores traducidos al protocolo. */
async function boxOperation(fn: () => Promise<BoxStatus>): Promise<{ box: BoxStatus }> {
  try {
    return { box: await fn() };
  } catch (err) {
    if (err instanceof BoxBusyError) {
      throw new ProtocolError('BUSY', err.message, { reason: 'box-busy' });
    }
    if (err instanceof BoxUnavailableError) {
      throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'no-runtime' });
    }
    if (err instanceof BoxCommandError) {
      throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'box-failed' });
    }
    throw err;
  }
}

export class Stratumd {
  readonly endpoint: Endpoint;
  /** Se resuelve cuando el daemon ha terminado de apagarse, con el motivo. */
  readonly closed: Promise<ShutdownReason>;

  private readonly sessions = new Map<string, HostedSession>();
  /** M11 — sesiones guardadas, recuperadas al arrancar y aún sin montar. */
  private readonly dormant = new Map<
    string,
    { archived: ArchivedSession; snapshot: ProtocolSessionSnapshot }
  >();
  /** Montajes de sesiones guardadas en curso: dos peticiones a la vez montan una vez. */
  private readonly waking = new Map<string, Promise<HostedSession>>();
  /** M14 — la apertura del `companion` en curso: dos peticiones a la vez abren una sesión. */
  private companionOpening: Promise<HostedSession> | null = null;
  private readonly archive: SessionArchive;
  /** Sesiones a medio cerrar: ya no se pueden pedir, pero el apagado las espera. */
  private readonly closingSessions = new Set<Promise<void>>();
  private readonly registry = new RunRegistry();
  private readonly hub: EventHub;
  /** `trace.subscribe`: la traza de cada sesión, leída de su fichero. */
  private readonly traces: TraceFeeds;
  /** Sesiones que alojan otros procesos: aquí solo está su proyección. */
  private readonly peers: PeerSessions;
  /** Aprobaciones, preguntas y planes pendientes de todas las sesiones, y quién los resuelve. */
  private readonly approvals: ApprovalCenter;
  /** M13 — la caja: el daemon pide sus órdenes fijas; no es dueño del contenedor. */
  private readonly box: BoxManager;
  private readonly approvalTimeoutMs: number;
  private readonly operations: OperationCache;
  private readonly serverInfo: ProtocolServerInfo;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly startup: typeof resolveSessionStartup;
  private readonly maxSessions: number;
  private readonly idleExitMs: number;

  private server!: ControlServer;
  private claim!: EndpointClaim;
  /** Subcarpeta propia del socket de reserva en el temporal (POSIX), si la hay. */
  private socketDir: string | null = null;
  private activeOperations = 0;
  private opening = 0;
  private lastActivity: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private shuttingDown: Promise<void> | null = null;
  private resolveClosed!: (reason: ShutdownReason) => void;

  private constructor(
    private readonly opts: StratumdOptions,
    endpoint: Endpoint,
  ) {
    this.endpoint = endpoint;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.lastActivity = this.startedAt;
    this.startup = opts.startup ?? resolveSessionStartup;
    this.serverInfo = { version: opts.version, platform: process.platform };
    this.maxSessions = opts.maxSessions ?? opts.config.daemon.maxSessions;
    this.idleExitMs = opts.idleExitMs ?? Math.round(opts.config.daemon.idleExitMinutes * 60_000);
    this.operations = new OperationCache({ now: this.now, ...opts.operations });
    this.archive = new SessionArchive(opts.sessionsDir ?? null);
    this.hub = new EventHub({
      bufferSize: opts.eventBuffer ?? opts.config.daemon.eventBuffer,
      ...(opts.subscriptionQueue ? { maxQueue: opts.subscriptionQueue } : {}),
      snapshotOf: (sessionId) =>
        this.sessions.get(sessionId)?.snapshot() ??
        this.peers.snapshotOf(sessionId) ??
        this.dormant.get(sessionId)?.snapshot ??
        null,
      overviewOf: () => this.overview(),
    });
    this.traces = new TraceFeeds(opts.tracePollMs ? { pollMs: opts.tracePollMs } : {});
    // La caja vive fuera del daemon: apagarlo o reiniciarlo no la toca.
    this.box =
      opts.box ??
      new BoxManager({
        config: opts.config.box,
        onProgress: (line) => log.debug('box build', { line }),
      });
    this.approvalTimeoutMs =
      opts.approvalTimeoutMs ?? Math.round(opts.config.daemon.approvalTimeoutMinutes * 60_000);
    this.approvals = new ApprovalCenter({
      // Alojada aquí: su promesa está en este proceso. Par: en el de su anfitrión.
      routeOf: (sessionId) =>
        this.sessions.get(sessionId)?.host.interactions ??
        (this.peers.connected(sessionId) ? this.peers.route(sessionId) : null),
      hostsSession: (link, sessionId) => this.peers.isHost(link, sessionId),
      reachable: (sessionId) => this.sessions.has(sessionId) || this.peers.connected(sessionId),
      now: this.now,
    });
    this.peers = new PeerSessions({
      hub: this.hub,
      registry: this.registry,
      pending: this.approvals,
      isLocalSession: (sessionId) => this.sessions.has(sessionId) || this.dormant.has(sessionId),
      detachedTtlMs:
        opts.detachedTtlMs ?? Math.round(opts.config.daemon.detachedTtlMinutes * 60_000),
      ...(opts.peerWatchIntervalMs ? { watchIntervalMs: opts.peerWatchIntervalMs } : {}),
      ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
      now: this.now,
      onActivity: () => {
        this.lastActivity = this.now();
      },
    });
    this.closed = new Promise<ShutdownReason>((r) => (this.resolveClosed = r));
  }

  /**
   * Arranca el daemon: escucha, y solo entonces publica el endpoint.
   *
   * @throws DaemonAlreadyRunningError si ya hay uno vivo en ese directorio.
   */
  static async start(opts: StratumdOptions): Promise<Stratumd> {
    const dir = opts.dir ?? defaultEndpointDir();
    const endpoint: Endpoint = {
      protocol: STRATUM_PROTOCOL_VERSION,
      pid: process.pid,
      startedAt: new Date((opts.now ?? Date.now)()).toISOString(),
      version: opts.version,
      ipcPath: newIpcPath(dir),
      token: newToken(),
    };
    const daemon = new Stratumd(opts, endpoint);
    daemon.server = new ControlServer({
      ipcPath: endpoint.ipcPath,
      token: endpoint.token,
      server: daemon.serverInfo,
      handlers: (conn) => daemon.handlers(conn),
      onRequest: () => daemon.operationStarted(),
      onDisconnected: (conn) => {
        daemon.hub.dropClient(conn);
        daemon.traces.dropClient(conn);
        // Las sesiones que alojaba quedan sin anfitrión; no se cierran.
        daemon.peers.disconnected(conn);
      },
      onDrain: (conn) => {
        daemon.hub.pump(conn);
        daemon.traces.pump(conn);
      },
      approver: opts.approver ?? null,
      ...(opts.approverFailureDelayMs !== undefined
        ? { approverFailureDelayMs: opts.approverFailureDelayMs }
        : {}),
      ...(opts.highWaterBytes ? { highWaterBytes: opts.highWaterBytes } : {}),
      ...(opts.maxBufferedBytes ? { maxBufferedBytes: opts.maxBufferedBytes } : {}),
    });
    // En POSIX el canal es un unix socket **dentro** de esta carpeta: tiene que
    // existir antes de escuchar (un named pipe de Windows no la necesita). Y
    // tiene que ser privada: si no lo es, no se arranca (`private-dir.ts`).
    await ensurePrivateDir(dir);
    // Un socket de reserva en el temporal (ruta demasiado larga) va en su subcarpeta, también privada.
    const socketDir = dirname(endpoint.ipcPath);
    if (process.platform !== 'win32' && resolve(socketDir) !== resolve(dir)) {
      await ensurePrivateDir(socketDir);
      daemon.socketDir = socketDir;
    }
    await daemon.server.listen();
    try {
      // El socket, solo para este usuario, antes de que el endpoint diga dónde está.
      await restrictSocket(endpoint.ipcPath);
      daemon.claim = await claimEndpoint({
        dir,
        endpoint,
        ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
        ...(opts.probe ? { probe: opts.probe } : {}),
      });
    } catch (err) {
      await daemon.server.close();
      throw err;
    }
    if (daemon.claim.replacedStale) log.info('stale endpoint replaced', { dir });
    // Ya somos el daemon de esta carpeta: las sesiones guardadas son nuestras.
    daemon.recoverArchived();
    log.info('daemon started', {
      pid: process.pid,
      version: opts.version,
      protocol: STRATUM_PROTOCOL_VERSION,
      idleExitMs: daemon.idleExitMs,
    });
    daemon.armIdleTimer();
    return daemon;
  }

  // ---------------------------------------------------------------------------
  // Estado de conjunto
  // ---------------------------------------------------------------------------

  get liveSessions(): number {
    return this.sessions.size;
  }

  get clients(): ClientConnection[] {
    return this.server.clients;
  }

  /** Cola y descartes del bus para una conexión (diagnóstico y tests). */
  clientStats(connectionId: number): HubClientStats | null {
    const conn = this.server.clients.find((c) => c.id === connectionId);
    return conn ? this.hub.stats(conn) : null;
  }

  private overview(): ProtocolOverviewSnapshot {
    return { sessions: this.registry.listSessions(), ...this.approvals.list() };
  }

  private need(sessionId: string): HostedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ProtocolError('NOT_FOUND', 'Session not found.');
    return session;
  }

  /**
   * Una sesión que el daemon aloja y conduce. De una par solo tiene la
   * proyección: lo que pide `what` es cosa del proceso que la aloja.
   */
  private local(sessionId: string, what: string): HostedSession {
    if (this.peers.has(sessionId)) throw peerHostedOnly(what);
    return this.need(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Actividad y apagado por inactividad
  // ---------------------------------------------------------------------------

  private operationStarted(): () => void {
    this.activeOperations++;
    return () => {
      this.activeOperations--;
      this.lastActivity = this.now();
    };
  }

  private armIdleTimer(): void {
    if (this.idleExitMs <= 0) return;
    const period = Math.max(50, Math.min(this.idleExitMs / 4, 30_000));
    this.idleTimer = setInterval(() => {
      if (this.isIdle()) {
        log.info('idle, shutting down', { idleExitMs: this.idleExitMs });
        void this.shutdown('idle');
      }
    }, period);
  }

  /**
   * Solo se está ocioso sin sesiones vivas **y** sin operaciones en curso. Que
   * no haya clientes conectados no cuenta: una sesión viva mantiene el daemon.
   */
  private isIdle(): boolean {
    return (
      this.sessions.size === 0 &&
      this.peers.size === 0 &&
      this.closingSessions.size === 0 &&
      this.waking.size === 0 &&
      this.opening === 0 &&
      this.activeOperations === 0 &&
      this.now() - this.lastActivity >= this.idleExitMs
    );
  }

  /**
   * Apagado ordenado, una sola vez: cierra cada sesión por su propio camino,
   * despide a los clientes, retira el endpoint y, lo último, cierra el runtime
   * global del proceso.
   */
  shutdown(reason: ShutdownReason = 'requested'): Promise<void> {
    this.shuttingDown ??= (async () => {
      log.info('daemon shutting down', { reason, sessions: this.sessions.size });
      if (this.idleTimer) clearInterval(this.idleTimer);
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.allSettled([
        ...sessions.map((s) => this.closeSession(s, 'server-shutdown')),
        ...this.closingSessions,
      ]);
      // Las sesiones pares no se cierran: siguen en sus procesos, sin daemon.
      this.peers.shutdown();
      // Los últimos eventos (`session.closed`) salen antes de la despedida.
      this.hub.flushAll();
      this.traces.closeAll();
      await this.settle('server', () => this.server.close(reason === 'idle' ? 'idle' : 'shutdown'));
      await this.settle('endpoint', () => this.claim.release());
      const socketDir = this.socketDir;
      if (socketDir)
        await this.settle('socket folder', () => rmdir(socketDir).catch(() => undefined));
      await this.settle('process teardown', () =>
        (this.opts.processTeardown ?? closeExecRuntime)(),
      );
      log.info('daemon stopped', { reason });
      this.resolveClosed(reason);
    })();
    return this.shuttingDown;
  }

  /** Muere sin limpiar nada, como con `kill -9`: el endpoint queda rancio. Solo tests. */
  async crash(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    await this.server.abort();
  }

  private async settle(step: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (err) {
      log.warn('shutdown step failed', { step, err });
    }
  }

  // ---------------------------------------------------------------------------
  // Sesiones
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Sesiones guardadas (M11)
  // ---------------------------------------------------------------------------

  /**
   * Al arrancar: cada sesión guardada vuelve a estar en la lista, con su foto
   * (saneada: nada en curso) y su `seq`, pero **sin montar**. Síncrono: ningún
   * cliente la ve a medias. Una que no se puede leer se deja en disco.
   */
  private recoverArchived(): void {
    if (!this.archive.persistent) return;
    const { sessions, skipped } = this.archive.list();
    for (const archived of sessions) {
      const id = archived.meta.sessionId;
      try {
        const files = this.archive.read(id);
        if (!files) continue;
        let snapshot: ProtocolSessionSnapshot;
        try {
          snapshot = restorableSnapshot(archived.snapshot, files.store, DAEMON_HOST);
        } finally {
          files.store.close();
        }
        this.dormant.set(id, { archived, snapshot });
        this.hub.openSession(id, snapshot.seq);
        this.registry.replace(snapshot);
      } catch (err) {
        log.warn('archived session not recovered', { sessionId: id, err });
      }
    }
    if (sessions.length > 0 || skipped.length > 0) {
      log.info('archived sessions recovered', {
        recovered: this.dormant.size,
        skipped: skipped.length,
      });
    }
  }

  /**
   * La sesión del daemon con su runtime montado: si es una guardada sin montar,
   * se monta ahora (una vez, aunque lo pidan dos a la vez).
   *
   * @throws ProtocolError `NOT_FOUND`, `UNAVAILABLE` (`peer-hosted`, `startup`, `cwd`).
   */
  private wake(sessionId: string, what: string): Promise<HostedSession> {
    if (this.peers.has(sessionId)) throw peerHostedOnly(what);
    const live = this.sessions.get(sessionId);
    if (live) return Promise.resolve(live);
    const pending = this.waking.get(sessionId);
    if (pending) return pending;
    const dormant = this.dormant.get(sessionId);
    if (!dormant) throw new ProtocolError('NOT_FOUND', 'Session not found.');
    const mounting = this.mountArchived(sessionId, dormant.archived).finally(() =>
      this.waking.delete(sessionId),
    );
    this.waking.set(sessionId, mounting);
    return mounting;
  }

  private async mountArchived(
    sessionId: string,
    archived: ArchivedSession,
  ): Promise<HostedSession> {
    if (this.shuttingDown) throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
    if (this.sessions.size + this.opening >= this.maxSessions) {
      throw new ProtocolError('UNAVAILABLE', 'Too many live sessions.');
    }
    const { meta } = archived;
    this.opening++;
    let files: SessionFiles | null = null;
    let session: HostedSession | null = null;
    try {
      const unusable = await this.unusableCwd(meta.cwd);
      if (unusable) {
        throw new ProtocolError('UNAVAILABLE', `Cannot restore that session: ${unusable}.`, {
          reason: 'cwd',
        });
      }
      const startup = await this.startup({
        cwd: meta.cwd,
        provider: meta.provider,
        model: meta.model,
        sessionProfile: meta.sessionProfile,
      });
      if (!startup.ok) {
        log.warn('archived session startup failed', { sessionId, stage: startup.stage });
        throw new ProtocolError(
          'UNAVAILABLE',
          `Cannot restore that session here (${startup.stage}).`,
          { reason: 'startup' },
        );
      }
      files = this.archive.open(sessionId);
      session = await HostedSession.restore({
        sessionId,
        env: createSessionEnv({ cwd: meta.cwd, env: this.opts.env }),
        config: startup.config,
        router: startup.router,
        version: this.opts.version,
        sink: this.sinkFor(sessionId),
        remoteApprovals: () => this.opts.approver != null,
        approvalTimeoutMs: this.approvalTimeoutMs,
        files,
        archived,
        ...(this.opts.assistantData ? { assistantData: this.opts.assistantData } : {}),
        companionDataDir: this.companionDir,
        ...(this.opts.snapshotsHome ? { snapshotsHome: this.opts.snapshotsHome } : {}),
        snapshot: restorableSnapshot(archived.snapshot, files.conversation.store, DAEMON_HOST),
      });
      if (this.shuttingDown) {
        throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
      }
    } catch (err) {
      try {
        if (session) await session.host.dispose({ cancelBackground: true });
      } catch (disposeErr) {
        log.warn('restore teardown failed', { sessionId, err: disposeErr });
      } finally {
        files?.close();
      }
      if (err instanceof ProtocolError) throw err;
      log.error('archived session not restored', { sessionId, err });
      throw new ProtocolError('UNAVAILABLE', 'The daemon could not restore that session.', {
        reason: 'startup',
      });
    } finally {
      this.opening--;
    }
    // Síncrono desde aquí: la sesión pasa de guardada a montada.
    this.dormant.delete(sessionId);
    this.sessions.set(sessionId, session);
    session.publisher.start();
    session.publisher.flush();
    session.persist();
    log.info('archived session restored', { sessionId });
    return session;
  }

  /** Cierra de verdad una sesión guardada sin montar: deja de existir, también en disco. */
  private closeDormant(sessionId: string): void {
    const dormant = this.dormant.get(sessionId);
    if (!dormant) return;
    this.dormant.delete(sessionId);
    this.archive.remove(sessionId);
    this.registry.remove(sessionId);
    this.hub.endSession(sessionId, {
      ...dormant.snapshot,
      session: { ...dormant.snapshot.session, state: 'closed' },
    });
    log.info('session closed', { sessionId, reason: 'closed', archived: true });
  }

  /** Lectura de una sesión guardada sin montar (historial, contexto, memoria). */
  private readArchived<T>(
    sessionId: string,
    fn: (files: NonNullable<ReturnType<SessionArchive['read']>>) => T,
  ): T {
    const files = this.archive.read(sessionId);
    if (!files) throw new ProtocolError('NOT_FOUND', 'Session not found.');
    try {
      return fn(files);
    } finally {
      files.store.close();
    }
  }

  /** Lo que publica una sesión: primero la proyección, después el reparto. */
  private sinkFor(sessionId: string): {
    onEvents(events: ProtocolEvent[]): void;
    onOverflow(): void;
  } {
    return {
      onEvents: (events) => {
        for (const event of events) {
          this.registry.apply(event);
          this.approvals.apply(event);
        }
        this.hub.ingest(sessionId, events);
      },
      onOverflow: () => {
        log.warn('session queue overflow, resync forced', { sessionId });
        const snapshot = this.sessions.get(sessionId)?.snapshot();
        if (snapshot) {
          this.registry.replace(snapshot);
          this.approvals.sync(snapshot);
        }
        this.hub.resync(sessionId);
      },
    };
  }

  /**
   * `sessions.open { resume }`: la sesión guardada del daemon con ese id, montada
   * (M11). Es la misma sesión, con sus ajustes: no admite los de una sesión nueva.
   * Una que ya está montada se devuelve tal cual; `origin` no cambia.
   *
   * @throws ProtocolError `INVALID_PARAMS` (otros ajustes), `NOT_FOUND`,
   *   `UNAVAILABLE` (`peer-hosted`, `startup`, `cwd`).
   */
  private resumeSession(
    params: Parameters<NonNullable<RequestHandlers['sessions.open']>>[0],
  ): Promise<HostedSession> {
    for (const field of RESUME_EXCLUSIVE) {
      if (params[field] !== undefined) {
        throw invalid(field, 'a resumed session keeps its own settings');
      }
    }
    return this.wake(params.resume as string, 'Resuming it');
  }

  private async openSession(
    params: Parameters<NonNullable<RequestHandlers['sessions.open']>>[0],
    origin?: ClientKind,
  ): Promise<HostedSession> {
    if (this.shuttingDown) throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
    if (params.resume !== undefined) return this.resumeSession(params);
    if (params.agent === COMPANION_AGENT) return this.openCompanion(params, origin);
    return this.openNewSession(params, origin);
  }

  /** Dónde guarda lo suyo el `companion` (M14). */
  private get companionDir(): string {
    return this.opts.companionDataDir ?? companionDataDir(this.opts.home ?? homedir());
  }

  /**
   * M14 — `sessions.open { agent: 'companion' }`: la sesión del asistente de
   * Stratum Dot, que es **una** y de larga vida. Si ya hay una (montada o
   * guardada sin montar) se devuelve esa, con sus ajustes; si no, se abre en su
   * propio directorio, que elige el daemon y nunca el cliente. Una sesión nueva
   * es explícita: se cierra la actual (`sessions.close`) y se abre otra.
   *
   * @throws ProtocolError `INVALID_PARAMS` (`cwd`), y los de `openNewSession`/`wake`.
   */
  private openCompanion(
    params: Parameters<NonNullable<RequestHandlers['sessions.open']>>[0],
    origin?: ClientKind,
  ): Promise<HostedSession> {
    if (params.cwd !== undefined) {
      throw invalid('cwd', 'the companion works in its own directory; do not pass cwd');
    }
    if (this.companionOpening) return this.companionOpening;
    const opening = (async (): Promise<HostedSession> => {
      const existing = this.companionSessionId();
      if (existing) return this.wake(existing, 'Opening the companion');
      const cwd = ensureCompanionWorkspace(this.companionDir);
      return this.openNewSession({ ...params, cwd }, origin);
    })().finally(() => {
      this.companionOpening = null;
    });
    this.companionOpening = opening;
    return opening;
  }

  /** La sesión del `companion` que ya tiene el daemon (la más reciente), o `null`. */
  private companionSessionId(): string | null {
    for (const [id, s] of this.sessions) {
      if (s.host.agent.promptPreset === 'companion') return id;
    }
    let best: { id: string; updatedAt: number } | null = null;
    for (const [id, d] of this.dormant) {
      if (d.archived.meta.agent !== COMPANION_AGENT) continue;
      const updatedAt = d.archived.meta.updatedAt;
      if (!best || updatedAt > best.updatedAt) best = { id, updatedAt };
    }
    return best?.id ?? null;
  }

  private async openNewSession(
    params: Parameters<NonNullable<RequestHandlers['sessions.open']>>[0],
    origin?: ClientKind,
  ): Promise<HostedSession> {
    if (this.sessions.size + this.opening >= this.maxSessions) {
      throw new ProtocolError('UNAVAILABLE', 'Too many live sessions.');
    }
    // El directorio lo valida quien va a trabajar en él, no quien lo pide.
    // El asistente lee todo lo que hay bajo su directorio: lo elige quien lo abre
    // (Desktop, una carpeta por conversación), y nunca vale el home (M12).
    const assistant = params.agent === ASSISTANT_AGENT;
    if (assistant && !params.cwd)
      throw invalid('cwd', 'the assistant needs its own directory (cwd)');
    const requested = params.cwd ?? this.opts.defaultCwd ?? homedir();
    if (!isAbsolute(requested)) throw invalid('cwd', 'cwd must be an absolute path');
    const cwd = resolve(requested);
    const assistantProblem = assistant
      ? assistantCwdProblem(cwd, this.opts.home ?? homedir())
      : null;
    if (assistantProblem) throw invalid('cwd', assistantProblem);
    // `params.env` está reservado: ni se usa ni se registra.

    // Desde aquí cuenta como sesión que se está abriendo (para `maxSessions`).
    this.opening++;
    try {
      const unusable = await this.unusableCwd(cwd);
      if (unusable) throw invalid('cwd', unusable);
      const startup: SessionStartup = await this.startup({
        cwd,
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.sessionProfile ? { sessionProfile: params.sessionProfile } : {}),
      });
      if (!startup.ok) {
        log.warn('session startup failed', { stage: startup.stage });
        throw startup.stage === 'config'
          ? new ProtocolError('UNAVAILABLE', `Cannot load the configuration: ${startup.error}`)
          : invalid(
              startup.stage === 'profile' ? 'sessionProfile' : startup.stage,
              startup.error.slice(0, 1_000),
            );
      }
      let sessionId = generateSessionId();
      while (
        this.sessions.has(sessionId) ||
        this.peers.has(sessionId) ||
        this.dormant.has(sessionId) ||
        this.archive.has(sessionId) ||
        this.hub.hasSession(sessionId)
      ) {
        sessionId = generateSessionId();
      }
      const files = this.archive.open(sessionId);
      let session: HostedSession;
      try {
        session = await HostedSession.open({
          sessionId,
          env: createSessionEnv({ cwd, env: this.opts.env }),
          config: startup.config,
          router: startup.router,
          version: this.opts.version,
          sink: this.sinkFor(sessionId),
          remoteApprovals: () => this.opts.approver != null,
          approvalTimeoutMs: this.approvalTimeoutMs,
          files,
          ...(this.opts.assistantData ? { assistantData: this.opts.assistantData } : {}),
          companionDataDir: this.companionDir,
          ...(this.opts.snapshotsHome ? { snapshotsHome: this.opts.snapshotsHome } : {}),
          ...(params.readOnly !== undefined ? { readOnly: params.readOnly } : {}),
          ...(params.sessionProfile ? { sessionProfile: params.sessionProfile } : {}),
          ...(params.agent ? { agent: params.agent } : {}),
          ...(origin ? { origin } : {}),
        });
      } catch (err) {
        // Nada de una sesión que no llegó a abrirse queda en disco.
        files.close();
        this.archive.remove(sessionId);
        throw err;
      }
      if (this.shuttingDown) {
        await session.host.dispose({ cancelBackground: true });
        files.close();
        this.archive.remove(sessionId);
        throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
      }
      this.sessions.set(sessionId, session);
      this.hub.openSession(sessionId);
      session.publisher.start();
      session.publisher.flush();
      session.persist();
      log.info('session opened', { sessionId, cwd });
      return session;
    } finally {
      this.opening--;
    }
  }

  /** Por qué el daemon no puede trabajar en ese directorio, o `null` si puede. */
  private async unusableCwd(cwd: string): Promise<string | null> {
    // Sin bloquear el bucle: la ruta la elige un cliente y puede ser una unidad de red.
    const isDirectory = await stat(cwd).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!isDirectory) return 'cwd is not an existing directory';
    const accessible = await access(cwd, constants.R_OK | constants.X_OK).then(
      () => true,
      () => false,
    );
    return accessible ? null : 'cwd is not accessible to the daemon';
  }

  // ---------------------------------------------------------------------------
  // Traspaso de una sesión par al daemon (M10)
  // ---------------------------------------------------------------------------

  /**
   * `sessions.detach`: que una sesión par pase a alojarse aquí. Lo hace su
   * anfitrión (se le pide con `host.detach` y él traspasa con `host.handoff*`);
   * lo que se contesta sale del estado del daemon, no de su respuesta: si la
   * respuesta se pierde pero la sesión ya es de aquí, el traspaso se hizo.
   */
  private async detachSession(
    sessionId: string,
  ): Promise<{ status: 'detached' | 'already-daemon'; session: ProtocolSession }> {
    const hosted = this.sessions.get(sessionId);
    if (hosted) return { status: 'already-daemon', session: hosted.session() };
    if (!this.peers.has(sessionId)) throw new ProtocolError('NOT_FOUND', 'Session not found.');
    try {
      await this.peers.requestDetach(sessionId);
    } catch (err) {
      const now = this.sessions.get(sessionId);
      if (now) return { status: 'detached', session: now.session() };
      throw err;
    }
    const now = this.sessions.get(sessionId);
    if (!now) {
      throw new ProtocolError('UNAVAILABLE', 'The handoff did not complete.', {
        reason: 'host-unavailable',
      });
    }
    return { status: 'detached', session: now.session() };
  }

  /**
   * `host.handoffCommit`: monta la sesión con el contexto que entregó su
   * anfitrión par y, **solo si todo salió bien**, pasa a ser su único
   * anfitrión en un paso síncrono (valla al par, registra la sesión aquí y
   * anuncia el cambio con el `seq` siguiente). Si algo falla antes de ese paso,
   * la sesión montada se desmonta sin haber publicado nada y la sesión sigue
   * siendo del par.
   */
  private async commitHandoff(
    conn: ClientConnection,
    params: { sessionId: string; handoffId: string },
  ): Promise<{ session: ProtocolSession; epoch: number }> {
    const { sessionId } = params;
    // Desde aquí el traspaso está en `committing`: cualquier fallo lo devuelve al par.
    const { context, snapshot } = this.peers.takeHandoff(conn, params);
    this.opening++;
    let session: HostedSession | null = null;
    let files: SessionFiles | null = null;
    try {
      if (this.shuttingDown) {
        throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
      }
      // M11: ese id ya es de una sesión guardada aquí; no se mezclan dos historias.
      if (this.dormant.has(sessionId) || this.archive.has(sessionId)) {
        throw new ProtocolError(
          'NOT_TRANSFERABLE',
          'The daemon already has a saved session with that id; use `stratum attach`.',
          { reason: 'context' },
        );
      }
      if (this.sessions.size + this.opening - 1 >= this.maxSessions) {
        throw new ProtocolError('UNAVAILABLE', 'Too many live sessions.');
      }
      // M14: el companion es una sesión del daemon, nunca de un anfitrión par.
      if (embeddedPresetOf(context.agent) === 'companion') {
        throw new ProtocolError(
          'NOT_TRANSFERABLE',
          'A companion session lives in the daemon; it cannot be handed over.',
          { reason: 'context' },
        );
      }
      const cwd = resolve(context.cwd);
      const unusable = isAbsolute(context.cwd)
        ? ((context.agent === ASSISTANT_AGENT
            ? assistantCwdProblem(cwd, this.opts.home ?? homedir())
            : null) ?? (await this.unusableCwd(cwd)))
        : 'not absolute';
      if (unusable) {
        throw new ProtocolError('NOT_TRANSFERABLE', 'The daemon cannot use that directory.', {
          reason: 'cwd',
        });
      }
      const startup = await this.startup({
        cwd,
        provider: context.provider,
        model: context.model,
        sessionProfile: context.sessionProfile,
      });
      if (!startup.ok) {
        log.warn('handoff startup failed', { sessionId, stage: startup.stage });
        throw new ProtocolError(
          'NOT_TRANSFERABLE',
          `The daemon cannot start that session here (${startup.stage}).`,
          { reason: 'startup' },
        );
      }
      files = this.archive.open(sessionId);
      session = await HostedSession.adopt({
        files,
        sessionId,
        env: createSessionEnv({ cwd, env: this.opts.env }),
        config: startup.config,
        router: startup.router,
        version: this.opts.version,
        sink: this.sinkFor(sessionId),
        remoteApprovals: () => this.opts.approver != null,
        approvalTimeoutMs: this.approvalTimeoutMs,
        context,
        snapshot,
        ...(this.opts.assistantData ? { assistantData: this.opts.assistantData } : {}),
        companionDataDir: this.companionDir,
        ...(this.opts.snapshotsHome ? { snapshotsHome: this.opts.snapshotsHome } : {}),
      });
      if (this.shuttingDown) {
        throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
      }
    } catch (err) {
      try {
        if (session) await session.host.dispose({ cancelBackground: true });
      } catch (disposeErr) {
        log.warn('handoff teardown failed', { sessionId, err: disposeErr });
      } finally {
        // Lo que se llegó a guardar no es de nadie: la sesión sigue en el par.
        if (files) {
          files.close();
          this.archive.remove(sessionId);
        }
        this.peers.abortHandoff(sessionId, params.handoffId);
      }
      if (err instanceof ProtocolError) throw err;
      log.error('handoff failed', { sessionId, err });
      throw new ProtocolError('NOT_TRANSFERABLE', 'The daemon could not take that session.', {
        reason: 'startup',
      });
    } finally {
      this.opening--;
    }

    // Commit: síncrono desde aquí. El par queda vallado y la sesión es de aquí.
    const { epoch } = this.peers.release(sessionId);
    this.sessions.set(sessionId, session);
    // Ya es de aquí: lo que falle al anunciarlo no deshace el traspaso (el
    // publicador nunca lanza; si lo hiciera, la foto lo corrige al resincronizar).
    try {
      session.publisher.start();
      session.publisher.flush();
      session.persist();
    } catch (err) {
      log.error('handoff announce failed', { sessionId, err });
    }
    log.info('session handed off to the daemon', { sessionId, epoch, cwd: context.cwd });
    return { session: session.session(), epoch };
  }

  private closeSession(
    session: HostedSession,
    reason: StateEventData['session.closed']['reason'],
  ): Promise<void> {
    const sessionId = session.sessionId;
    const closing = (async () => {
      try {
        await session.close(reason);
      } catch (err) {
        log.error('session close failed', { sessionId, err });
      } finally {
        // Nada de una sesión cerrada sigue pendiente de decisión.
        this.approvals.forget(sessionId);
        this.hub.closeSession(sessionId);
        this.lastActivity = this.now();
        log.info('session closed', { sessionId, reason });
      }
    })();
    this.closingSessions.add(closing);
    void closing.finally(() => this.closingSessions.delete(closing));
    return closing;
  }

  // ---------------------------------------------------------------------------
  // Métodos del protocolo
  // ---------------------------------------------------------------------------

  private handlers(conn: ClientConnection): RequestHandlers {
    const handlers: RequestHandlers = {
      'core.status': () => ({
        server: this.serverInfo,
        protocol: STRATUM_PROTOCOL_VERSION,
        startedAt: this.startedAt,
        clients: this.server.clients.length,
        liveSessions: this.registry.liveSessions,
        activeRuns: this.registry.activeRuns,
        pendingApprovals: this.approvals.count,
      }),
      'core.shutdown': (params) => {
        if (!params.force && this.registry.activeRuns > 0) {
          throw new ProtocolError('BUSY', 'There are runs in progress. Use force to stop anyway.');
        }
        log.info('shutdown requested', { connectionId: conn.id, force: params.force === true });
        // Después de contestar: la respuesta sale antes de la despedida.
        setImmediate(() => void this.shutdown('requested'));
        return {};
      },

      'agents.list': (params) => {
        // Una ruta relativa se resolvería contra el directorio del proceso del daemon.
        if (params.cwd !== undefined && !isAbsolute(params.cwd)) {
          throw invalid('cwd', 'cwd must be an absolute path');
        }
        const loader = new ProfileLoader(params.cwd ? [params.cwd] : []);
        return {
          // Los agentes embebidos (M12, M14) van primero; un perfil con su
          // nombre no se puede abrir como tal (`sessions.open` elige el embebido).
          agents: [
            assistantAgentInfo(),
            companionAgentInfo(),
            ...loader
              .list()
              .filter((p) => !EMBEDDED_AGENTS.includes(p.name))
              .map((p) => ({
                name: p.name,
                description: p.description ?? '',
                mode: profileMode(p),
                origin: p.source?.scope ?? 'builtin',
                allowedTools: p.allowedTools ?? null,
                ...(p.provider ? { provider: p.provider } : {}),
                ...(p.model ? { model: p.model } : {}),
              })),
          ],
        };
      },
      'skills.list': (params) => {
        const embedded = embeddedPresetOf(params.agent);
        const assistant = embedded !== null;
        if (params.cwd !== undefined && !isAbsolute(params.cwd)) {
          throw invalid('cwd', 'cwd must be an absolute path');
        }
        // Las de código dependen del proyecto: sin `cwd` se listarían las del
        // directorio del proceso del daemon, que no es el de nadie.
        if (!assistant && params.cwd === undefined) {
          throw invalid('cwd', 'cwd is required to list the skills of a coding agent');
        }
        const config = assistant ? this.opts.config : this.configFor(params.cwd);
        if (!config.skills.enabled) return { skills: [] };
        // El asistente no mira ningún directorio: su `cwd` no se usa.
        const registry = sessionSkills(config, embedded ?? 'coding', params.cwd ?? '');
        // Sin ruta ni cuerpo: un cliente no lee ficheros del anfitrión.
        return {
          skills: registry.entries.map((e) => ({
            name: e.name,
            description: e.description,
            scope: e.scope,
            presets: e.presets,
          })),
        };
      },
      'models.list': async (params) => {
        // De la config solo salen alias e ids: ni `baseUrl`, ni claves, ni cabeceras.
        const providers = this.opts.config.provider?.providers ?? {};
        const defaultProvider = this.opts.config.provider?.default;
        const names = params.provider ? [params.provider] : Object.keys(providers);
        const models: ProtocolModel[] = [];
        let error: string | undefined;
        for (const name of names) {
          const entry = providers[name];
          if (!entry) throw new ProtocolError('NOT_FOUND', 'Provider not found.');
          const found: ProtocolModel[] = [];
          try {
            const infos = await fetchModelInfos(entry.baseUrl, entry.apiKey, { timeoutMs: 3000 });
            for (const m of infos) {
              found.push({ provider: name, id: m.id, contextWindow: m.contextWindow ?? null });
            }
          } catch {
            // Sin el detalle: puede nombrar la URL del backend.
            error ??= `Could not list the models of "${name}".`;
          }
          // El modelo configurado se ofrece aunque el backend no liste modelos.
          if (entry.model && !found.some((m) => m.id === entry.model)) {
            found.unshift({ provider: name, id: entry.model, contextWindow: null });
          }
          for (const m of found) {
            // M15: la visión solo es la declarada en la config, nunca la de `/models`.
            const vision = entry.models?.[m.id]?.vision;
            const withVision = vision ? { ...m, vision: { coordinates: vision.coordinates } } : m;
            models.push(
              name === defaultProvider && m.id === entry.model
                ? { ...withVision, default: true }
                : withVision,
            );
          }
        }
        return { models, ...(error ? { error } : {}) };
      },

      'sessions.list': (params) => {
        // Las guardadas no se listan todavía: el daemon solo conoce las vivas.
        const sessions = params.live === false ? [] : this.registry.listSessions();
        return { sessions: params.limit ? sessions.slice(0, params.limit) : sessions };
      },
      'sessions.get': (params) => ({
        snapshot:
          this.peers.snapshotOf(params.sessionId) ??
          this.dormant.get(params.sessionId)?.snapshot ??
          this.need(params.sessionId).snapshot(),
      }),
      // M11 — conversación guardada, contexto y memoria de sesión. De una par
      // el daemon solo tiene la proyección: no guarda su conversación.
      'sessions.history': (params) => {
        if (this.peers.has(params.sessionId)) throw peerHostedOnly('Its saved conversation');
        const live = this.sessions.get(params.sessionId);
        if (live) return historyPage(live.conversation.store, params.before, params.limit);
        if (!this.dormant.has(params.sessionId)) {
          throw new ProtocolError('NOT_FOUND', 'Session not found.');
        }
        return this.readArchived(params.sessionId, (files) =>
          historyPage(files.store, params.before, params.limit),
        );
      },
      'sessions.context': (params) => {
        if (this.peers.has(params.sessionId)) throw peerHostedOnly('Its context');
        const live = this.sessions.get(params.sessionId);
        if (live) {
          return {
            report: liveContextReport(
              params.sessionId,
              live.host.agent.getContextReport(),
              live.conversation.memory,
            ),
          };
        }
        const dormant = this.dormant.get(params.sessionId);
        if (!dormant) throw new ProtocolError('NOT_FOUND', 'Session not found.');
        const enabled = this.configFor(dormant.archived.meta.cwd).memory.session.enabled;
        return this.readArchived(params.sessionId, (files) => ({
          report: archivedContextReport(
            params.sessionId,
            files.store,
            files.state,
            files.memory,
            enabled,
          ),
        }));
      },
      'sessions.memory': (params) => {
        if (this.peers.has(params.sessionId)) throw peerHostedOnly('Its session memory');
        const live = this.sessions.get(params.sessionId);
        if (live) return { memory: protocolMemory(live.conversation.memory) };
        if (!this.dormant.has(params.sessionId)) {
          throw new ProtocolError('NOT_FOUND', 'Session not found.');
        }
        return this.readArchived(params.sessionId, (files) => ({
          memory: protocolMemory(files.memory),
        }));
      },
      'sessions.open': async (params) => ({
        session: (await this.openSession(params, conn.client?.kind)).session(),
      }),
      'sessions.close': async (params) => {
        if (this.dormant.has(params.sessionId) && !this.waking.has(params.sessionId)) {
          this.closeDormant(params.sessionId);
          return {};
        }
        const session = this.sessions.has(params.sessionId)
          ? this.local(params.sessionId, 'Closing it')
          : await this.wake(params.sessionId, 'Closing it');
        // Deja de existir ya para los demás; lo que se desmonta es solo lo suyo.
        this.sessions.delete(params.sessionId);
        await this.closeSession(session, 'closed');
        // Cerrarla es acabarla: no vuelve al reiniciar (M11).
        this.archive.remove(params.sessionId);
        return {};
      },
      'sessions.setModel': async (params) => ({
        session: (await this.wake(params.sessionId, 'Changing its model')).setModel(
          params.model,
          params.provider,
        ),
      }),
      'sessions.setAgent': async (params) => ({
        session: (await this.wake(params.sessionId, 'Changing its agent')).setAgent(params.agent),
      }),
      'sessions.setReadOnly': async (params) => ({
        session: (await this.wake(params.sessionId, 'Changing read-only')).setReadOnly(
          params.readOnly,
        ),
      }),
      'sessions.detach': (params) => this.detachSession(params.sessionId),
      // `approve` lo comprueba `authorize` antes de llegar aquí. Una sesión par
      // deshace en su terminal (`/undo`); una guardada se monta para hacerlo.
      'sessions.revert': async ({ sessionId, operationId: _op, ...params }) => {
        void _op;
        const session = await this.wake(sessionId, 'Reverting its files');
        log.info('session revert requested', {
          sessionId,
          connectionId: conn.id,
          client: conn.client?.name,
          dryRun: params.dryRun === true,
          force: params.force === true,
        });
        return session.revert(params);
      },

      'runs.list': (params) => ({ runs: this.registry.listRuns(params) }),
      'runs.get': (params) => {
        const run = this.registry.run(params.runId);
        if (!run) throw new ProtocolError('NOT_FOUND', 'Run not found.');
        return { run };
      },
      'runs.start': async (params) => ({
        run: (await this.wake(params.sessionId, 'Starting a run')).startRun(
          params.input,
          params.mode ?? 'normal',
        ),
      }),
      // Sobre una sesión par, cancelar y redirigir se reenvían a su anfitrión:
      // el resultado es el que da su runtime, no uno calculado aquí.
      'runs.steer': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.steer(params.sessionId, params.text)
          : this.dormant.has(params.sessionId)
            ? 'not-accepting'
            : this.need(params.sessionId).steer(params.text),
      }),
      'runs.cancel': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.cancel(params.sessionId, params.runId)
          : this.dormant.has(params.sessionId)
            ? 'not-running'
            : this.need(params.sessionId).cancel(params.runId),
      }),
      // Pausa cooperativa. El daemon no pausa nada: entrega la orden a quien
      // aloja la sesión —su `SessionHost`, aquí o en otro proceso— y no da el run
      // por pausado hasta que su anfitrión lo publique (`run.updated`).
      'runs.pause': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.pause(params.sessionId, params.runId)
          : this.dormant.has(params.sessionId)
            ? 'not-running'
            : this.need(params.sessionId).pause(params.runId),
      }),
      'runs.resume': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.resume(params.sessionId, params.runId)
          : this.dormant.has(params.sessionId)
            ? 'not-running'
            : this.need(params.sessionId).resume(params.runId),
      }),

      // Centro de aprobaciones. Listar es de quien observa; resolver exige la
      // capacidad `approve` (`authorize.ts`) y, además, no ser el anfitrión de
      // esa sesión (`ApprovalCenter`). Gana la primera respuesta válida.
      'approvals.list': (params) => this.approvals.list(params.sessionId),
      'approvals.resolve': async (params) => {
        await this.approvals.resolve(conn, {
          kind: 'approval',
          id: params.approvalId,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
          decision: params.decision,
          ...(params.phrase !== undefined ? { phrase: params.phrase } : {}),
        });
        return {};
      },
      'questions.answer': async (params) => {
        await this.approvals.resolve(conn, {
          kind: 'question',
          id: params.requestId,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
          answers: params.answers,
        });
        return {};
      },
      'plans.decide': async (params) => {
        await this.approvals.resolve(conn, {
          kind: 'plan',
          id: params.requestId,
          ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
          decision: params.decision,
          ...(params.plan ? { plan: params.plan } : {}),
        });
        return {};
      },

      'jobs.list': (params) => ({
        jobs:
          this.peers.snapshotOf(params.sessionId)?.jobs ??
          this.dormant.get(params.sessionId)?.snapshot.jobs ??
          this.need(params.sessionId).jobs(),
      }),
      'jobs.cancel': async (params) => {
        // Una sesión guardada sin montar no tiene jobs: murieron con su proceso.
        if (this.dormant.has(params.sessionId)) {
          throw new ProtocolError('NOT_FOUND', 'Job not found.');
        }
        await this.local(params.sessionId, 'Cancelling a job').cancelJob(params.jobId);
        return {};
      },

      'memory.status': async (params) => {
        const memory = getDecisionMemory(this.memoryConfigFor(params.cwd));
        const backend = await memory.vectors.backendName().catch(() => 'none');
        return {
          decisions: memory.list().length,
          indexed: backend === 'sqlite-vec' || backend === 'fallback',
          backend:
            backend === 'sqlite-vec' ? 'sqlite-vec' : backend === 'none' ? 'none' : 'fallback',
        };
      },
      'memory.decisions': async (params) => {
        const memory = getDecisionMemory(this.memoryConfigFor(params.cwd));
        const limit = params.limit ?? 50;
        const records = params.query
          ? (await memory.search(params.query, limit)).map((r) => r.record)
          : memory.list().slice(-limit).reverse();
        return {
          decisions: records.map((r) => ({
            id: r.id,
            title: r.title,
            type: r.type,
            tags: r.tags,
            importance: r.importance,
            timestamp: r.timestamp,
          })),
        };
      },

      'box.status': async () => ({ box: await this.box.status() }),
      'box.screen': async () => {
        try {
          return { screen: await this.box.screen(BOX_SCREEN_LIMITS.maxBytes) };
        } catch (err) {
          if (err instanceof BoxScreenUnavailableError) {
            throw new ProtocolError('UNAVAILABLE', err.message, { reason: err.reason });
          }
          if (err instanceof BoxUnavailableError) {
            throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'no-runtime' });
          }
          if (err instanceof BoxCommandError) {
            throw new ProtocolError('UNAVAILABLE', err.message, { reason: 'box-failed' });
          }
          throw err;
        }
      },
      'box.start': () => boxOperation(() => this.box.start()),
      'box.stop': () => boxOperation(() => this.box.stop()),
      'box.reset': () => boxOperation(() => this.box.reset()),

      'events.subscribe': (params) => this.hub.subscribe(conn, params.scope),
      'events.unsubscribe': (params) => {
        this.hub.unsubscribe(conn, params.subscriptionId);
        return {};
      },
      'trace.subscribe': (params) =>
        this.traces.subscribe(conn, params.sessionId, this.traceFileOf(params.sessionId)),
      'trace.unsubscribe': (params) => {
        this.traces.unsubscribe(conn, params.subscriptionId);
        return {};
      },

      // Anfitriones pares. La capacidad `host` da acceso a estos tres métodos;
      // sobre qué sesiones, lo decide `PeerSessions`: las que registró esa conexión.
      'host.register': (params) => this.peers.register(conn, params),
      'host.publish': (params) => {
        this.peers.publish(conn, params);
        return {};
      },
      'host.unregister': (params) => {
        this.peers.unregister(conn, params.sessionId);
        return {};
      },
      // Traspaso al daemon (M10): solo de la sesión que aloja esa conexión, con su época.
      'host.handoffBegin': (params) => this.peers.beginHandoff(conn, params),
      'host.handoffChunk': (params) => {
        this.peers.addChunk(conn, params);
        return {};
      },
      'host.handoffCommit': (params) => this.commitHandoff(conn, params),
      'host.handoffAbort': (params) => {
        this.peers.abortOwnHandoff(conn, params);
        return {};
      },
    };
    return this.withOperationIds(conn, handlers);
  }

  /**
   * La memoria de decisiones que miran `memory.*`: la del proyecto de `cwd`
   * (la del agente de código) o, sin `cwd`, la del asistente, que es la única
   * global. Nunca la que resultaría del directorio del proceso del daemon.
   */
  private memoryConfigFor(cwd: string | undefined): StratumConfig {
    if (cwd) return this.configFor(cwd);
    return buildAssistantConfig(
      this.opts.config,
      this.opts.assistantData?.dir ?? assistantDataDir(),
    );
  }

  /**
   * El fichero de traza de una sesión del daemon, montada o guardada sin montar
   * (con la config de su directorio, sin montarla). La de una sesión par la
   * escribe su proceso: no es del daemon.
   *
   * @throws ProtocolError `NOT_FOUND`, `UNAVAILABLE` (`peer-hosted`, config).
   */
  private traceFileOf(sessionId: string): string {
    if (this.peers.has(sessionId)) throw peerHostedOnly('Its trace');
    const live = this.sessions.get(sessionId);
    const recorded = live?.host.trace?.file;
    if (recorded) return recorded;
    const cwd = live?.session().cwd ?? this.dormant.get(sessionId)?.archived.meta.cwd;
    const file = cwd !== undefined ? traceFilePath(this.configFor(cwd), sessionId) : null;
    if (!file) throw new ProtocolError('NOT_FOUND', 'Session not found.');
    return file;
  }

  private configFor(cwd: string | undefined): StratumConfig {
    if (!cwd) return this.opts.config;
    try {
      return loadConfig(cwd);
    } catch {
      throw new ProtocolError('UNAVAILABLE', 'Cannot load the configuration of that directory.');
    }
  }

  /**
   * `operationId`: toda petición que cambia estado y lo trae pasa por la caché
   * de operaciones, en un único sitio. Los handlers no saben de él.
   */
  private withOperationIds(conn: ClientConnection, handlers: RequestHandlers): RequestHandlers {
    const out: Record<string, unknown> = {};
    for (const [method, handler] of Object.entries(handlers)) {
      const fn = handler as (params: unknown) => unknown;
      if (!METHODS[method as MethodName].mutating) {
        out[method] = fn;
        continue;
      }
      out[method] = (params: unknown) => {
        const operationId = (params as { operationId?: string }).operationId;
        if (!operationId) return fn(params);
        const client = conn.client ? `${conn.client.kind}:${conn.client.name}` : `#${conn.id}`;
        return this.operations.run({ client, operationId, method, params }, async () => fn(params));
      };
    }
    return out as RequestHandlers;
  }
}
