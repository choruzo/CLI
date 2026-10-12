/**
 * Cliente Node del Stratum Protocol. Une las piezas —descubrimiento, conexión,
 * handshake, petición/respuesta, suscripciones y reconexión— y poco más: cada
 * una vive en su fichero y se puede usar por separado.
 *
 * Lo que este cliente **no** hace nunca es reenviar una petición. Si la
 * conexión cae con una petición enviada y sin respuesta, quien llamó recibe
 * `UnknownOutcomeError` y decide; al reconectar solo se restablecen las
 * suscripciones.
 */
import {
  MAX_MESSAGE_BYTES,
  STRATUM_PROTOCOL_VERSION,
  type Capability,
  type HelloResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from '../protocol/index.js';
import { ProtocolError, type ValidatedNotification } from '../ipc/codec.js';
import { NotSentError, RpcPeer, type RequestHandlers, type RequestOptions } from '../ipc/peer.js';
import { getLogger } from '../logging/index.js';
import { socketConnector, type CloseInfo, type Connection, type Connector } from './connection.js';
import type { Discovery, DiscoveryResult } from './discovery.js';
import { ProtocolMismatchError, performHandshake, type ClientIdentity } from './handshake.js';
import { createBackoff, sleep, type BackoffOptions } from './reconnect.js';
import {
  Subscriptions,
  type OverviewSubscriptionHandlers,
  type SessionSubscriptionHandlers,
  type Subscription,
  type TraceSubscriptionHandlers,
} from './subscriptions.js';

const log = getLogger('client');

export type ClientStatus =
  /** Aún no se ha llamado a `connect()`. */
  | 'idle'
  | 'connecting'
  | 'ready'
  /** Se perdió la conexión y se está intentando recuperar. */
  | 'reconnecting'
  /** Cerrado: por `close()`, o porque reconectar no tiene sentido (`closeReason`). */
  | 'closed';

/** No hay servidor al que conectarse. */
export class ServerUnavailableError extends Error {
  override readonly name = 'ServerUnavailableError';

  constructor(readonly discovery: Exclude<DiscoveryResult['status'], 'found' | 'incompatible'>) {
    super(
      discovery === 'absent'
        ? 'Stratum daemon is not running.'
        : discovery === 'stale'
          ? 'Stratum daemon is not running (its endpoint is stale).'
          : 'Stratum daemon endpoint cannot be read.',
    );
  }
}

export interface StratumClientOptions {
  discovery: Discovery;
  identity: ClientIdentity;
  /** Conector del transporte. Por defecto, el socket local. */
  connector?: Connector;
  /** Reconexión automática. `false` la desactiva. */
  reconnect?: BackoffOptions | false;
  /** Plazo por defecto de las peticiones. `0` = sin plazo. */
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** Peticiones del servidor que este cliente atiende (un anfitrión par). */
  handlers?: RequestHandlers;
  onStatus?: (status: ClientStatus) => void;
  /** Notificaciones que no son de una suscripción (`goodbye`). */
  onNotification?: (notification: ValidatedNotification) => void;
}

interface Link {
  connection: Connection;
  peer: RpcPeer;
  hello: HelloResult;
}

/** ¿Tiene sentido volver a intentarlo tras este fallo? */
function isFatal(err: unknown): boolean {
  if (err instanceof ProtocolMismatchError) return true;
  return err instanceof ProtocolError && (err.code === 'UNAUTHORIZED' || err.code === 'FORBIDDEN');
}

export class StratumClient {
  private readonly connector: Connector;
  private readonly subscriptions = new Subscriptions();
  private readonly lifetime = new AbortController();
  private link: Link | null = null;
  private current: ClientStatus = 'idle';
  private fatal: unknown = null;

  constructor(private readonly opts: StratumClientOptions) {
    this.connector = opts.connector ?? socketConnector();
  }

  get status(): ClientStatus {
    return this.current;
  }

  /** Capacidades concedidas en la conexión actual. Vacío si no hay conexión. */
  get capabilities(): readonly Capability[] {
    return this.link?.hello.capabilities ?? [];
  }

  /** Resultado del último handshake, o `null` sin conexión. */
  get server(): HelloResult | null {
    return this.link?.hello ?? null;
  }

  /** Por qué se cerró sin que nadie llamase a `close()` (versión incompatible, token rechazado). */
  get closeReason(): unknown {
    return this.fatal;
  }

  private setStatus(status: ClientStatus): void {
    if (this.current === status) return;
    this.current = status;
    try {
      this.opts.onStatus?.(status);
    } catch {
      /* quien observa el estado no puede romper el cliente */
    }
  }

  /**
   * Primera conexión. Rechaza con `ServerUnavailableError`,
   * `ProtocolMismatchError` o el `ProtocolError` del handshake. Tras un fallo
   * aquí no se reintenta: la reconexión automática solo cubre conexiones que ya
   * estuvieron listas.
   */
  async connect(): Promise<HelloResult> {
    if (this.current !== 'idle') throw new Error(`connect() called in state ${this.current}`);
    this.setStatus('connecting');
    try {
      const link = await this.establish();
      return link.hello;
    } catch (err) {
      this.fatal = err;
      this.setStatus('closed');
      throw err;
    }
  }

  /** Descubre, conecta y hace el handshake. No envía nada más hasta que termina bien. */
  private async establish(): Promise<Link> {
    const found = await this.opts.discovery.locate();
    if (found.status === 'incompatible') {
      throw new ProtocolMismatchError(STRATUM_PROTOCOL_VERSION, found.protocol, found.version);
    }
    if (found.status !== 'found') throw new ServerUnavailableError(found.status);

    let peer: RpcPeer | null = null;
    const connection = await this.connector(found.endpoint.ipcPath, {
      onLine: (line) => peer?.handleLine(line),
    });
    peer = new RpcPeer({
      send: (line) => connection.send(line),
      handlers: this.opts.handlers,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      maxMessageBytes: MAX_MESSAGE_BYTES,
      onNotification: (n) => {
        if (!this.subscriptions.dispatch(n)) this.opts.onNotification?.(n);
      },
      onProtocolError: (detail) => log.debug('protocol error', { detail }),
    });
    const livePeer = peer;
    void connection.closed.then((info) => this.onClosed(livePeer, info));

    let hello: HelloResult;
    try {
      hello = await performHandshake(
        livePeer,
        found.endpoint.token,
        this.opts.identity,
        this.opts.handshakeTimeoutMs ?? 5_000,
      );
    } catch (err) {
      livePeer.close();
      connection.close();
      throw err;
    }
    if (this.lifetime.signal.aborted) {
      livePeer.close();
      connection.close();
      throw new Error('client closed');
    }
    const link: Link = { connection, peer: livePeer, hello };
    this.link = link;
    this.setStatus('ready');
    await this.subscriptions.attach(livePeer);
    return link;
  }

  private onClosed(peer: RpcPeer, info: CloseInfo): void {
    // Toda petición sin respuesta queda con resultado desconocido. No se reenvía.
    peer.close();
    if (this.link?.peer !== peer) return;
    this.link = null;
    this.subscriptions.detach();
    log.debug('connection closed', { reason: info.reason, discardedBytes: info.discardedBytes });
    if (this.lifetime.signal.aborted || this.current === 'closed') return;
    if (this.opts.reconnect === false) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    void this.reconnectLoop(this.opts.reconnect ?? {});
  }

  private async reconnectLoop(options: BackoffOptions): Promise<void> {
    const backoff = createBackoff(options);
    for (let attempt = 1; ; attempt++) {
      const delay = backoff.delay(attempt);
      if (delay === null || !(await sleep(delay, this.lifetime.signal))) break;
      try {
        await this.establish();
        return;
      } catch (err) {
        if (this.lifetime.signal.aborted) return;
        if (isFatal(err)) {
          this.fatal = err;
          break;
        }
        log.debug('reconnect attempt failed', { attempt, err });
      }
    }
    if (!this.lifetime.signal.aborted) this.setStatus('closed');
  }

  /**
   * Envía una petición. Sin conexión rechaza con `NotSentError` (no se encola
   * para más tarde). Ver `RpcPeer.request` para el resto de errores.
   */
  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: RequestOptions,
  ): Promise<MethodResult<M>> {
    const peer = this.link?.peer;
    if (!peer || this.current !== 'ready') return Promise.reject(new NotSentError(method));
    return peer.request(method, params, options);
  }

  /** Sigue una sesión. Se restablece sola tras una reconexión. */
  subscribeSession(
    sessionId: string,
    handlers: SessionSubscriptionHandlers,
    options?: { volatile?: boolean; sinceSeq?: number },
  ): Subscription {
    return this.subscriptions.subscribeSession(sessionId, handlers, options);
  }

  /** Sigue el conjunto: qué sesiones hay y qué esperan. */
  subscribeOverview(handlers: OverviewSubscriptionHandlers): Subscription {
    return this.subscriptions.subscribeOverview(handlers);
  }

  /** Sigue la traza de una sesión. */
  subscribeTrace(sessionId: string, handlers: TraceSubscriptionHandlers): Subscription {
    return this.subscriptions.subscribeTrace(sessionId, handlers);
  }

  /** Cierra y deja de reconectar. Las peticiones en vuelo quedan con resultado desconocido. */
  close(): void {
    if (this.current === 'closed') return;
    this.lifetime.abort();
    const link = this.link;
    this.link = null;
    this.subscriptions.detach();
    this.setStatus('closed');
    if (link) {
      link.peer.close();
      link.connection.close();
    }
  }
}
