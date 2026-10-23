/**
 * Servidor del Stratum Protocol: acepta **varios clientes** a la vez sobre un
 * named pipe / unix socket (nunca TCP), les exige el handshake y les aplica la
 * autorización. No sabe de sesiones: los métodos los atiende quien lo crea.
 *
 * Cada conexión tiene su propia salida, y ninguna puede frenar a las demás ni
 * al runtime:
 *
 *  - `ready()` deja de ser cierto cuando hay más de `highWaterBytes` sin enviar;
 *    el bus de eventos deja entonces de darle eventos (los acumula en su cola
 *    acotada, o le fuerza un snapshot);
 *  - si aun así lo pendiente pasa de `maxBufferedBytes` —un cliente que no lee
 *    ni las respuestas—, la conexión se corta. Volverá con un snapshot.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { createServer, type Server, type Socket } from 'net';
import {
  FEATURE_REMOTE_APPROVALS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  MAX_UNAUTHENTICATED_MESSAGE_BYTES,
  METHODS,
  STRATUM_PROTOCOL_VERSION,
  type Capability,
  type ClientKind,
  type HelloParams,
  type HelloResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
  type ProtocolNotifications,
  type ProtocolServerInfo,
} from '../protocol/index.js';
import { ProtocolError, encodeMessage, errorResponse } from '../ipc/codec.js';
import { FrameTooLargeError, LineDecoder } from '../ipc/framing.js';
import { RpcPeer, type RequestHandlers, type RequestOptions } from '../ipc/peer.js';
import { getLogger } from '../logging/index.js';
import type { ApproverAuth } from './approver-key.js';
import { authorize, grantCapabilities, type Principal } from './authorize.js';
import type { HubClient } from './event-hub.js';
import { peerVerification, type PeerVerification } from './peer-identity.js';

const log = getLogger('daemon').child('server');

/** Una conexión de cliente. Es también el extremo que ve el bus de eventos. */
export interface ClientConnection extends HubClient, Principal {
  readonly id: number;
  readonly connectedAt: number;
  /** Lo que el cliente declaró ser en `core.hello`. No es una identidad verificada. */
  client: { kind: ClientKind; name: string; version: string } | null;
  /**
   * Qué comprobó el sistema operativo antes de dejarle conectar (`peer-identity.ts`).
   * No distingue procesos del mismo usuario, y no da ni quita capacidades.
   */
  readonly verification: PeerVerification;
  /** Bytes aceptados y aún sin enviar. */
  readonly bufferedBytes: number;
  /**
   * Petición del servidor a este cliente (un anfitrión par). Va con su propio
   * id: no espera detrás de lo que el cliente esté enviando.
   */
  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: RequestOptions,
  ): Promise<MethodResult<M>>;
}

export interface ControlServerOptions {
  ipcPath: string;
  /** Secreto del handshake. No se registra. */
  token: string;
  server: ProtocolServerInfo;
  /** Handlers de una conexión ya autenticada. `core.hello` lo pone el servidor. */
  handlers: (conn: ClientConnection) => RequestHandlers;
  /** Envuelve la ejecución de cada petición (contabilidad de operaciones en curso). */
  onRequest?: (conn: ClientConnection, method: MethodName) => () => void;
  onAuthenticated?: (conn: ClientConnection) => void;
  onDisconnected?: (conn: ClientConnection) => void;
  /** La salida de una conexión vuelve a admitir datos. */
  onDrain?: (conn: ClientConnection) => void;
  handshakeTimeoutMs?: number;
  maxConnections?: number;
  /** Por encima, la conexión deja de recibir eventos hasta que vacíe. */
  highWaterBytes?: number;
  /** Por encima, la conexión se corta. */
  maxBufferedBytes?: number;
  /**
   * Cómo se acredita un aprobador. Sin esto, ninguna conexión obtiene la
   * capacidad `approve`.
   */
  approver?: ApproverAuth | null;
  /** Retraso de la respuesta a una clave de aprobador errónea (tests). */
  approverFailureDelayMs?: number;
}

/**
 * Cuánto tarda en contestarse una clave de aprobador errónea. Lo paga solo la
 * conexión que la presentó: frena a quien prueba claves sin frenar a nadie más.
 */
const APPROVER_FAILURE_DELAY_MS = 1_000;

const DEFAULT_HIGH_WATER = 1024 * 1024;
const DEFAULT_MAX_BUFFERED = 16 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 64;

function tokensMatch(a: string, b: string): boolean {
  // Sobre el hash: `timingSafeEqual` exige la misma longitud, y compararla
  // antes ya diría algo del token.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

class Connection implements ClientConnection {
  authenticated = false;
  /** Hay un `core.hello` comprobándose: no se atiende otro. */
  greeting = false;
  capabilities: Capability[] = [];
  client: ClientConnection['client'] = null;
  readonly connectedAt = Date.now();
  readonly verification = peerVerification();
  peer!: RpcPeer;
  closing = false;
  /** La salida vuelve a admitir datos. */
  onWritable: () => void = () => undefined;
  private readonly flushed = (): void => {
    if (this.ready()) this.onWritable();
  };

  constructor(
    readonly id: number,
    readonly socket: Socket,
    private readonly highWater: number,
    private readonly maxBuffered: number,
  ) {}

  get bufferedBytes(): number {
    return this.socket.writableLength;
  }

  ready(): boolean {
    return !this.socket.destroyed && this.socket.writable && this.bufferedBytes < this.highWater;
  }

  /** Entrega una línea al socket. `false` si la conexión ya no vale. */
  send(line: string): boolean {
    if (this.socket.destroyed || !this.socket.writable) return false;
    // Una trama mayor que el límite rompería al cliente: no sale. Es un fallo
    // de quien la compuso (los lotes y las fotos están acotados), no del cliente.
    if (
      line.length > MAX_MESSAGE_BYTES / 4 &&
      Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES
    ) {
      log.error('outgoing message exceeds the frame limit, dropped', { connectionId: this.id });
      return false;
    }
    // El aviso de «vuelve a caber» sale de cada escritura completada y no del
    // `drain` del socket: el umbral de aquí puede ser menor que el suyo, y
    // entonces `drain` no llegaría nunca.
    this.socket.write(line, this.flushed);
    if (this.bufferedBytes > this.maxBuffered) {
      log.warn('client not reading, connection dropped', {
        connectionId: this.id,
        bufferedBytes: this.bufferedBytes,
      });
      this.socket.destroy();
      return false;
    }
    return true;
  }

  notify<N extends NotificationName>(name: N, params: NotificationParams<N>): void {
    if (this.authenticated) this.peer.notify(name, params);
  }

  sendEncoded(line: string): void {
    // Las mismas condiciones que `notify`: autenticada y con el peer abierto.
    if (this.authenticated && !this.peer.isClosed) this.send(line);
  }

  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: RequestOptions,
  ): Promise<MethodResult<M>> {
    return this.peer.request(method, params, options);
  }
}

export class ControlServer {
  private readonly server: Server;
  private readonly connections = new Set<Connection>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: ControlServerOptions) {
    this.server = createServer((socket) => this.accept(socket));
    this.server.on('error', (err) => log.error('server error', { err }));
  }

  /** Empieza a escuchar. Rechaza si el canal no se puede abrir. */
  listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.opts.ipcPath, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  /** Conexiones autenticadas. */
  get clients(): ClientConnection[] {
    return [...this.connections].filter((c) => c.authenticated);
  }

  private accept(socket: Socket): void {
    if (
      this.closed ||
      this.connections.size >= (this.opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS)
    ) {
      socket.destroy();
      return;
    }
    const conn = new Connection(
      this.nextId++,
      socket,
      this.opts.highWaterBytes ?? DEFAULT_HIGH_WATER,
      this.opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED,
    );
    const decoder = new LineDecoder(MAX_UNAUTHENTICATED_MESSAGE_BYTES);
    this.connections.add(conn);
    log.debug('client connected', { connectionId: conn.id, verification: conn.verification.check });

    const handlers: RequestHandlers = {
      ...this.wrap(conn, this.opts.handlers(conn)),
      'core.hello': (params) => this.hello(conn, decoder, params),
    };
    conn.peer = new RpcPeer({
      send: (line) => conn.send(line),
      handlers,
      // El único punto de autorización: ver `authorize.ts`.
      guard: (method) => authorize(conn, method),
      maxMessageBytes: MAX_MESSAGE_BYTES,
      onProtocolError: (detail) => log.debug('protocol error', { connectionId: conn.id, detail }),
    });

    // Quien no se presenta a tiempo no se queda con un hueco.
    const handshakeTimer = setTimeout(() => {
      // Con el saludo ya recibido y su clave comprobándose, el plazo no corta:
      // esa espera es del servidor, y termina aceptando o cerrando la conexión.
      if (!conn.authenticated && !conn.greeting) {
        log.info('handshake timeout', { connectionId: conn.id });
        socket.destroy();
      }
    }, this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref();

    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        const limit = err instanceof FrameTooLargeError ? err.limit : 0;
        log.info('frame too large, connection closed', { connectionId: conn.id, limit });
        this.endWith(
          conn,
          encodeMessage(
            errorResponse(null, {
              code: 'FRAME_TOO_LARGE',
              message: 'Message too large.',
              data: { limit },
            }),
          ),
        );
        return;
      }
      for (const line of lines) {
        if (conn.closing) return;
        conn.peer.handleLine(line);
      }
    });
    conn.onWritable = () => this.opts.onDrain?.(conn);
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      conn.peer.close();
      this.connections.delete(conn);
      log.debug('client disconnected', {
        connectionId: conn.id,
        client: conn.client?.kind,
        authenticated: conn.authenticated,
      });
      if (conn.authenticated) {
        try {
          this.opts.onDisconnected?.(conn);
        } catch (err) {
          log.error('disconnect hook failed', { connectionId: conn.id, err });
        }
      }
    });
  }

  /** Envuelve cada handler para contar las operaciones en curso. */
  private wrap(conn: Connection, handlers: RequestHandlers): RequestHandlers {
    const track = this.opts.onRequest;
    if (!track) return handlers;
    const out: Record<string, unknown> = {};
    for (const [method, handler] of Object.entries(handlers)) {
      const fn = handler as (params: unknown) => unknown;
      out[method] = async (params: unknown) => {
        const done = track(conn, method as MethodName);
        try {
          return await fn(params);
        } finally {
          done();
        }
      };
    }
    return out as RequestHandlers;
  }

  /** Comprobaciones de clave en curso, de una en una (ver `verifyApprover`). */
  private approverQueue: Promise<unknown> = Promise.resolve();

  /**
   * ¿Acredita esa clave a un aprobador? Sin acreditación configurada, nunca.
   *
   * Freno contra quien prueba claves, **sin bloqueo global**: que alguien falle
   * no le quita a nadie más la posibilidad de aprobar.
   *
   *  - Una conexión tiene **un** intento: un fallo rechaza el handshake y la
   *    cierra. Reintentar es abrir otra.
   *  - Las comprobaciones van **de una en una**, en orden de llegada: el ritmo
   *    al que se pueden probar claves es el de la derivación (scrypt), por
   *    muchas conexiones que se abran, y no ocupa más de un núcleo.
   *  - El fallo se contesta con retraso, y ese retraso lo espera solo la
   *    conexión que falló, fuera de la cola.
   *
   * Lo que queda: quien tiene el token del canal puede llenar la cola y
   * retrasar unos segundos el handshake de un aprobador legítimo (la cola no
   * pasa del número de conexiones admitidas). No puede impedirlo.
   */
  private async verifyApprover(key: string): Promise<boolean> {
    const auth = this.opts.approver;
    if (!auth) return false;
    const turn = this.approverQueue.then(
      () => auth.verify(key),
      () => auth.verify(key),
    );
    this.approverQueue = turn.catch(() => undefined);
    let ok = false;
    try {
      ok = await turn;
    } catch {
      ok = false;
    }
    if (ok) return true;
    log.warn('approver verification failed');
    const delay = this.opts.approverFailureDelayMs ?? APPROVER_FAILURE_DELAY_MS;
    if (delay > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref();
      });
    }
    return false;
  }

  private async hello(
    conn: Connection,
    decoder: LineDecoder,
    params: HelloParams,
  ): Promise<HelloResult> {
    // La clave de aprobador no sale de aquí: ni al log ni a `conn.client`.
    const { approverKey } = params;
    const client = { ...params.client };
    const reject = (err: ProtocolError): never => {
      log.info('handshake rejected', {
        connectionId: conn.id,
        client: client.kind,
        code: err.code,
      });
      // La respuesta sale primero; después no se atiende nada más de esta conexión.
      conn.closing = true;
      setImmediate(() => conn.socket.end());
      throw err;
    };
    if (params.protocol !== STRATUM_PROTOCOL_VERSION) {
      reject(
        new ProtocolError('PROTOCOL_MISMATCH', 'Unsupported protocol version.', {
          protocol: STRATUM_PROTOCOL_VERSION,
        }),
      );
    }
    if (!tokensMatch(params.token, this.opts.token)) {
      reject(new ProtocolError('UNAUTHORIZED', 'Invalid token.'));
    }
    if (conn.greeting) {
      throw new ProtocolError('INVALID_REQUEST', 'Handshake already in progress.');
    }
    let approverVerified = false;
    if (approverKey !== undefined) {
      conn.greeting = true;
      try {
        approverVerified = await this.verifyApprover(approverKey);
      } finally {
        conn.greeting = false;
      }
      // Una clave que no vale no degrada a observador en silencio: quien la
      // tecleó tiene que saberlo.
      if (!approverVerified) {
        reject(new ProtocolError('UNAUTHORIZED', 'Invalid approver key.'));
      }
      if (conn.closing) throw new ProtocolError('UNAVAILABLE', 'Connection closed.');
    }
    const capabilities = grantCapabilities(params.roles, { approverVerified });
    if (capabilities.length === 0) {
      reject(new ProtocolError('FORBIDDEN', 'None of the requested roles is available.'));
    }
    conn.authenticated = true;
    conn.capabilities = capabilities;
    conn.client = client;
    decoder.setLimit(MAX_MESSAGE_BYTES);
    log.info('client authenticated', {
      connectionId: conn.id,
      client: client.kind,
      name: client.name,
      roles: params.roles,
      capabilities,
    });
    this.opts.onAuthenticated?.(conn);
    return {
      protocol: STRATUM_PROTOCOL_VERSION,
      server: this.opts.server,
      connectionId: conn.id,
      capabilities,
      features: this.opts.approver ? [FEATURE_REMOTE_APPROVALS] : [],
    };
  }

  private endWith(conn: Connection, line: string): void {
    conn.closing = true;
    conn.socket.end(line, () => conn.socket.destroy());
  }

  /** Avisa a todos los clientes (`goodbye`) y deja de aceptar. Idempotente. */
  async close(reason: ProtocolNotifications['goodbye']['reason'] = 'shutdown'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closing = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const conn of this.connections) {
      conn.closing = true;
      if (conn.authenticated) conn.peer.notify('goodbye', { reason });
      conn.socket.end();
    }
    // Un cliente que no cierra su lado no retiene el apagado.
    const force = setTimeout(() => this.destroyAll(), 500);
    force.unref();
    await closing;
    clearTimeout(force);
  }

  /** Corta todas las conexiones sin avisar, como un proceso que muere. */
  destroyAll(): void {
    for (const conn of this.connections) conn.socket.destroy();
  }

  /** Cierra el canal sin despedirse ni limpiar nada (un daemon que cae). Solo tests. */
  abort(): Promise<void> {
    this.closed = true;
    const closing = new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.destroyAll();
    return closing;
  }
}

/** Métodos que un cliente puede pedir, para comprobar que no queda ninguno sin atender. */
export const CLIENT_METHODS = (Object.keys(METHODS) as MethodName[]).filter(
  (m) => METHODS[m].direction === 'client-to-server',
);
