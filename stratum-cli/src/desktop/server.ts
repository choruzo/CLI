import { createHash, timingSafeEqual } from 'crypto';
import { chmodSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { getLogger } from '../logging/index.js';
import { FrameTooLargeError, LineDecoder, encodeFrame, parseInboundFrame } from './codec.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_UNAUTHENTICATED_FRAME_BYTES,
  type CoreInfo,
  type HandshakeErrorFrame,
  type NativeProbe,
  type OutboundFrame,
  type SidecarErrorFrame,
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

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Un error de E/S en un cliente no puede tumbar el sidecar.
    socket.on('error', (err) => log.debug('socket error', { err }));
    handleConnection(socket, opts, handshakeTimeoutMs);
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

function handleConnection(socket: Socket, opts: DesktopServerOptions, timeoutMs: number): void {
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
      authenticated = true;
      handshaking = false;
      log.info('client authenticated');
      send({ type: 'handshake_ok', core: opts.core, natives });
      if (opts.startupError) send(opts.startupError);
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
