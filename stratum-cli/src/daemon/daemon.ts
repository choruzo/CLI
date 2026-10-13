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
 */
import { constants } from 'fs';
import { access, mkdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';
import { ProfileLoader, profileMode } from '../agent/profiles.js';
import { defaultEndpointDir, type Endpoint } from '../client/discovery.js';
import { loadConfig } from '../config/loader.js';
import type { StratumConfig } from '../config/schema.js';
import { resolveSessionStartup, type SessionStartup } from '../host/session-startup.js';
import { ProtocolError } from '../ipc/codec.js';
import type { RequestHandlers } from '../ipc/peer.js';
import { getLogger } from '../logging/index.js';
import { getDecisionMemory } from '../memory/decision-memory.js';
import {
  METHODS,
  STRATUM_PROTOCOL_VERSION,
  type MethodName,
  type ProtocolEvent,
  type ProtocolModel,
  type ProtocolOverviewSnapshot,
  type ProtocolServerInfo,
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
import { HostedSession } from './hosted-session.js';
import { OperationCache, type OperationCacheOptions } from './operation-cache.js';
import { PeerSessions, peerHostedOnly } from './peer-sessions.js';
import { RunRegistry } from './run-registry.js';

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
  /** Inyectables para tests del endpoint. */
  isAlive?: (pid: number) => boolean;
  probe?: (ipcPath: string) => Promise<boolean>;
  now?: () => number;
}

function invalid(path: string, message: string): ProtocolError {
  return new ProtocolError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

export class Stratumd {
  readonly endpoint: Endpoint;
  /** Se resuelve cuando el daemon ha terminado de apagarse, con el motivo. */
  readonly closed: Promise<ShutdownReason>;

  private readonly sessions = new Map<string, HostedSession>();
  /** Sesiones a medio cerrar: ya no se pueden pedir, pero el apagado las espera. */
  private readonly closingSessions = new Set<Promise<void>>();
  private readonly registry = new RunRegistry();
  private readonly hub: EventHub;
  /** Sesiones que alojan otros procesos: aquí solo está su proyección. */
  private readonly peers: PeerSessions;
  /** Aprobaciones, preguntas y planes pendientes de todas las sesiones, y quién los resuelve. */
  private readonly approvals: ApprovalCenter;
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
    this.hub = new EventHub({
      bufferSize: opts.eventBuffer ?? opts.config.daemon.eventBuffer,
      ...(opts.subscriptionQueue ? { maxQueue: opts.subscriptionQueue } : {}),
      snapshotOf: (sessionId) =>
        this.sessions.get(sessionId)?.snapshot() ?? this.peers.snapshotOf(sessionId),
      overviewOf: () => this.overview(),
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
      isLocalSession: (sessionId) => this.sessions.has(sessionId),
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
        // Las sesiones que alojaba quedan sin anfitrión; no se cierran.
        daemon.peers.disconnected(conn);
      },
      onDrain: (conn) => daemon.hub.pump(conn),
      approver: opts.approver ?? null,
      ...(opts.approverFailureDelayMs !== undefined
        ? { approverFailureDelayMs: opts.approverFailureDelayMs }
        : {}),
      ...(opts.highWaterBytes ? { highWaterBytes: opts.highWaterBytes } : {}),
      ...(opts.maxBufferedBytes ? { maxBufferedBytes: opts.maxBufferedBytes } : {}),
    });
    // En POSIX el canal es un unix socket **dentro** de esta carpeta: tiene que
    // existir antes de escuchar (un named pipe de Windows no la necesita).
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await daemon.server.listen();
    try {
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
      await this.settle('server', () => this.server.close(reason === 'idle' ? 'idle' : 'shutdown'));
      await this.settle('endpoint', () => this.claim.release());
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

  private async openSession(
    params: Parameters<NonNullable<RequestHandlers['sessions.open']>>[0],
  ): Promise<HostedSession> {
    if (this.shuttingDown) throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
    if (params.resume) {
      throw new ProtocolError('UNAVAILABLE', 'Resuming a saved session is not available yet.');
    }
    if (this.sessions.size + this.opening >= this.maxSessions) {
      throw new ProtocolError('UNAVAILABLE', 'Too many live sessions.');
    }
    // El directorio lo valida quien va a trabajar en él, no quien lo pide.
    const requested = params.cwd ?? this.opts.defaultCwd ?? homedir();
    if (!isAbsolute(requested)) throw invalid('cwd', 'cwd must be an absolute path');
    const cwd = resolve(requested);
    // `params.env` está reservado: ni se usa ni se registra.

    // Desde aquí cuenta como sesión que se está abriendo (para `maxSessions`).
    this.opening++;
    try {
      // Sin bloquear el bucle: la ruta la elige un cliente y puede ser una unidad de red.
      const isDirectory = await stat(cwd).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (!isDirectory) throw invalid('cwd', 'cwd is not an existing directory');
      const accessible = await access(cwd, constants.R_OK | constants.X_OK).then(
        () => true,
        () => false,
      );
      if (!accessible) throw invalid('cwd', 'cwd is not accessible to the daemon');
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
        this.hub.hasSession(sessionId)
      ) {
        sessionId = generateSessionId();
      }
      const session = await HostedSession.open({
        sessionId,
        env: createSessionEnv({ cwd, env: this.opts.env }),
        config: startup.config,
        router: startup.router,
        version: this.opts.version,
        sink: this.sinkFor(sessionId),
        remoteApprovals: () => this.opts.approver != null,
        approvalTimeoutMs: this.approvalTimeoutMs,
        ...(params.readOnly !== undefined ? { readOnly: params.readOnly } : {}),
        ...(params.sessionProfile ? { sessionProfile: params.sessionProfile } : {}),
        ...(params.agent ? { agent: params.agent } : {}),
      });
      if (this.shuttingDown) {
        await session.host.dispose({ cancelBackground: true });
        throw new ProtocolError('UNAVAILABLE', 'The daemon is shutting down.');
      }
      this.sessions.set(sessionId, session);
      this.hub.openSession(sessionId);
      session.publisher.start();
      session.publisher.flush();
      log.info('session opened', { sessionId, cwd });
      return session;
    } finally {
      this.opening--;
    }
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
          agents: loader.list().map((p) => ({
            name: p.name,
            description: p.description ?? '',
            mode: profileMode(p),
            origin: p.source?.scope ?? 'builtin',
            allowedTools: p.allowedTools ?? null,
            ...(p.provider ? { provider: p.provider } : {}),
            ...(p.model ? { model: p.model } : {}),
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
            models.push(
              name === defaultProvider && m.id === entry.model ? { ...m, default: true } : m,
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
        snapshot: this.peers.snapshotOf(params.sessionId) ?? this.need(params.sessionId).snapshot(),
      }),
      'sessions.open': async (params) => ({ session: (await this.openSession(params)).session() }),
      'sessions.close': async (params) => {
        const session = this.local(params.sessionId, 'Closing it');
        // Deja de existir ya para los demás; lo que se desmonta es solo lo suyo.
        this.sessions.delete(params.sessionId);
        await this.closeSession(session, 'closed');
        return {};
      },
      'sessions.setModel': (params) => ({
        session: this.local(params.sessionId, 'Changing its model').setModel(params.model),
      }),
      'sessions.setAgent': (params) => ({
        session: this.local(params.sessionId, 'Changing its agent').setAgent(params.agent),
      }),
      'sessions.setReadOnly': (params) => ({
        session: this.local(params.sessionId, 'Changing read-only').setReadOnly(params.readOnly),
      }),

      'runs.list': (params) => ({ runs: this.registry.listRuns(params) }),
      'runs.get': (params) => {
        const run = this.registry.run(params.runId);
        if (!run) throw new ProtocolError('NOT_FOUND', 'Run not found.');
        return { run };
      },
      'runs.start': (params) => ({
        run: this.local(params.sessionId, 'Starting a run').startRun(
          params.input,
          params.mode ?? 'normal',
        ),
      }),
      // Sobre una sesión par, cancelar y redirigir se reenvían a su anfitrión:
      // el resultado es el que da su runtime, no uno calculado aquí.
      'runs.steer': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.steer(params.sessionId, params.text)
          : this.need(params.sessionId).steer(params.text),
      }),
      'runs.cancel': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.cancel(params.sessionId, params.runId)
          : this.need(params.sessionId).cancel(params.runId),
      }),
      // Pausa cooperativa. El daemon no pausa nada: entrega la orden a quien
      // aloja la sesión —su `SessionHost`, aquí o en otro proceso— y no da el run
      // por pausado hasta que su anfitrión lo publique (`run.updated`).
      'runs.pause': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.pause(params.sessionId, params.runId)
          : this.need(params.sessionId).pause(params.runId),
      }),
      'runs.resume': async (params) => ({
        status: this.peers.has(params.sessionId)
          ? await this.peers.resume(params.sessionId, params.runId)
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
          decision: params.decision,
          ...(params.phrase !== undefined ? { phrase: params.phrase } : {}),
        });
        return {};
      },
      'questions.answer': async (params) => {
        await this.approvals.resolve(conn, {
          kind: 'question',
          id: params.requestId,
          answers: params.answers,
        });
        return {};
      },
      'plans.decide': async (params) => {
        await this.approvals.resolve(conn, {
          kind: 'plan',
          id: params.requestId,
          decision: params.decision,
          ...(params.plan ? { plan: params.plan } : {}),
        });
        return {};
      },

      'jobs.list': (params) => ({
        jobs: this.peers.snapshotOf(params.sessionId)?.jobs ?? this.need(params.sessionId).jobs(),
      }),
      'jobs.cancel': async (params) => {
        await this.local(params.sessionId, 'Cancelling a job').cancelJob(params.jobId);
        return {};
      },

      'memory.status': async (params) => {
        const memory = getDecisionMemory(this.configFor(params.cwd));
        const backend = await memory.vectors.backendName().catch(() => 'none');
        return {
          decisions: memory.list().length,
          indexed: backend === 'sqlite-vec' || backend === 'fallback',
          backend:
            backend === 'sqlite-vec' ? 'sqlite-vec' : backend === 'none' ? 'none' : 'fallback',
        };
      },
      'memory.decisions': async (params) => {
        const memory = getDecisionMemory(this.configFor(params.cwd));
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

      'events.subscribe': (params) => this.hub.subscribe(conn, params.scope),
      'events.unsubscribe': (params) => {
        this.hub.unsubscribe(conn, params.subscriptionId);
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
    };
    return this.withOperationIds(conn, handlers);
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
