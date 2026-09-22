import { createHash, timingSafeEqual } from 'crypto';
import { chmodSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { getLogger } from '../logging/index.js';
import { FrameTooLargeError, LineDecoder, encodeFrame, parseInboundFrame } from './codec.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_UNAUTHENTICATED_FRAME_BYTES,
  type ConversationFrame,
  type ConversationOutboundFrame,
  type CoreInfo,
  type HandshakeErrorFrame,
  type NativeProbe,
  type OutboundFrame,
  type SidecarErrorFrame,
  type WorkspacesInfo,
} from './protocol.js';

const log = getLogger('desktop.server');

export interface DesktopServerOptions {
  /** Named pipe (`\\.\pipe\…`) o ruta de unix socket, elegida por Tauri. */
  ipcPath: string;
  /** Token del arranque (15.1). */
  token: string;
  core: CoreInfo;
  /** Resultado del sondeo de nativos; se espera antes de responder al handshake. */
  natives: () => Promise<NativeProbe[]>;
  /**
   * Problema detectado al arrancar (config incompatible o inválida). Se envía
   * justo después del `handshake_ok` a cada conexión: el sidecar sigue vivo
   * para poder explicar por qué no puede trabajar, en vez de morir sin más.
   */
  startupError?: SidecarErrorFrame | null;
  handshakeTimeoutMs?: number;
  /** Destino de las tramas de conversación (D1). Sin él, se contestan con error de protocolo. */
  conversations?: ConversationSink;
  /** Raíz y límites de los workspaces (D2), para Rust. */
  workspaces?: WorkspacesInfo;
}

/**
 * Lo que el servidor necesita del `ConversationHost`. Solo recibe tramas de
 * conexiones **autenticadas**: una conexión sin token no llega nunca aquí (15.1).
 */
export interface ConversationSink {
  attach(connectionId: number, send: (frame: ConversationOutboundFrame) => void): void;
  detach(connectionId: number): void | Promise<void>;
  handle(frame: ConversationFrame, connectionId: number): void;
}

export interface DesktopServer {
  readonly server: Server;
  /** Conexiones abiertas, autenticadas o no. */
  connectionCount(): number;
  close(): Promise<void>;
}

/** Comparación en tiempo constante, también con longitudes distintas. */
export function tokensMatch(expected: string, received: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(received, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function startDesktopServer(opts: DesktopServerOptions): Promise<DesktopServer> {
  const sockets = new Set<Socket>();
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const lease: ClientLease = { nextId: 1, active: null };

  const server = createServer((socket) => {
    sockets.add(socket);
    const connectionId = lease.nextId++;
    socket.on('close', () => {
      sockets.delete(socket);
      if (lease.active?.id === connectionId) {
        lease.active = null;
        void opts.conversations?.detach(connectionId);
      }
    });
    // Un error de E/S en un cliente no puede tumbar el sidecar.
    socket.on('error', (err) => log.debug('socket error', { err }));
    handleConnection(socket, connectionId, opts, handshakeTimeoutMs, lease);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.ipcPath, () => {
      server.off('error', reject);
      server.on('error', (err) => log.error('server error', { err }));
      // Un unix socket hereda la umask: se restringe al usuario. En Windows el
      // named pipe no admite esto desde Node; ahí la defensa es el nombre
      // aleatorio que elige Tauri más el token.
      if (process.platform !== 'win32') chmodSync(opts.ipcPath, 0o600);
      log.info('listening', { ipcPath: opts.ipcPath });
      resolve({
        server,
        connectionCount: () => sockets.size,
        close: () => closeServer(server, sockets),
      });
    });
  });
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    // `close` elimina además el fichero del unix socket.
    server.close(() => resolve());
  });
}

/**
 * Cliente autenticado activo. Solo hay uno (el relay de Rust): uno nuevo lo
 * sustituye. El orden importa — primero se mueve el lease y después se destruye
 * el socket viejo, así su `close` ya no es del activo y no cancela nada.
 */
interface ClientLease {
  nextId: number;
  active: { id: number; socket: Socket } | null;
}

function handleConnection(
  socket: Socket,
  connectionId: number,
  opts: DesktopServerOptions,
  timeoutMs: number,
  lease: ClientLease,
): void {
  const decoder = new LineDecoder(MAX_UNAUTHENTICATED_FRAME_BYTES);
  let authenticated = false;
  let rejected = false;
  // Mientras se espera al sondeo de nativos llegan más tramas: se encolan para
  // procesarlas en orden una vez autenticado.
  let handshaking = false;
  const backlog: string[] = [];

  const send = (frame: OutboundFrame): void => {
    if (!socket.destroyed) socket.write(encodeFrame(frame));
  };

  const reject = (reason: HandshakeErrorFrame['reason']): void => {
    if (rejected) return;
    rejected = true;
    log.warn('handshake rejected', { reason });
    clearTimeout(timer);
    socket.removeAllListeners('data');
    if (socket.destroyed) return;
    // `end` solo cierra la escritura: sin `destroy` un cliente que no cierre su
    // lado mantendría la conexión viva. Se destruye cuando el rechazo ya salió.
    socket.end(encodeFrame({ type: 'handshake_error', reason }), () => socket.destroy());
  };

  const timer = setTimeout(() => reject('timeout'), timeoutMs);
  timer.unref();

  const handleAuthenticated = (line: string): void => {
    const frame = parseInboundFrame(line);
    if (frame === null) {
      send({
        type: 'sidecar_error',
        fatal: false,
        code: 'protocol',
        message: 'Trama no reconocida.',
      });
      return;
    }
    switch (frame.type) {
      case 'ping':
        send({ type: 'pong', ...(frame.id !== undefined ? { id: frame.id } : {}), ts: Date.now() });
        return;
      case 'handshake':
        send({
          type: 'sidecar_error',
          fatal: false,
          code: 'protocol',
          message: 'Handshake duplicado en una conexión ya autenticada.',
        });
        return;
      default:
        // Una conexión que perdió el lease ya no habla por las conversaciones.
        if (lease.active?.id !== connectionId) return;
        if (!opts.conversations) {
          send({
            type: 'sidecar_error',
            fatal: false,
            code: 'protocol',
            message: 'Este sidecar no admite conversaciones.',
          });
          return;
        }
        opts.conversations.handle(frame, connectionId);
        return;
    }
  };

  const handleHandshake = (line: string): void => {
    const frame = parseInboundFrame(line);
    if (frame === null) return reject('malformed');
    if (frame.type !== 'handshake') return reject('expected_handshake');
    if (!tokensMatch(opts.token, frame.token)) return reject('bad_token');

    clearTimeout(timer);
    handshaking = true;
    // El token ya es válido: las tramas que se encolen mientras llega el sondeo
    // de nativos pueden tener el tamaño normal.
    decoder.setLimit(MAX_FRAME_BYTES);
    void opts.natives().then((natives) => {
      // El cliente pudo irse mientras se sondeaban los nativos.
      if (socket.destroyed) return;
      authenticated = true;
      handshaking = false;
      log.info('client authenticated', { connectionId });
      // `handshake_ok` va primero: Rust espera la respuesta al handshake en la
      // primera línea, y en cuanto este cliente tenga el lease las
      // conversaciones vivas pueden empezar a emitirle tramas.
      send({
        type: 'handshake_ok',
        core: opts.core,
        natives,
        ...(opts.workspaces ? { workspaces: opts.workspaces } : {}),
      });
      if (opts.startupError) send(opts.startupError);
      const previous = lease.active;
      lease.active = { id: connectionId, socket };
      opts.conversations?.attach(connectionId, send);
      if (previous && previous.socket !== socket) {
        log.info('replacing previous client', { previous: previous.id, connectionId });
        previous.socket.destroy();
      }
      for (const queued of backlog.splice(0)) handleAuthenticated(queued);
    });
  };

  socket.on('data', (chunk: Buffer) => {
    let lines: string[];
    try {
      lines = decoder.push(chunk);
    } catch (err) {
      if (!(err instanceof FrameTooLargeError)) throw err;
      if (!authenticated) return reject('frame_too_large');
      send({ type: 'sidecar_error', fatal: false, code: 'protocol', message: err.message });
      socket.destroy();
      return;
    }
    for (const line of lines) {
      if (authenticated) handleAuthenticated(line);
      else if (handshaking) backlog.push(line);
      else handleHandshake(line);
      if (rejected || socket.destroyed) return;
    }
  });
}
