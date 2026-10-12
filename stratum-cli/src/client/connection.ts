/**
 * Una conexión al servidor: bytes ↔ líneas sobre un named pipe / unix socket.
 * No sabe de mensajes, peticiones ni handshake.
 */
import { createConnection } from 'net';
import { FrameTooLargeError, LineDecoder } from '../ipc/framing.js';
import { MAX_MESSAGE_BYTES } from '../protocol/index.js';

export type CloseReason =
  /** La cerró este lado (`close()`). */
  | 'local'
  /** La cerró el otro extremo o se cortó. */
  | 'remote'
  /** Llegó una trama mayor que el límite: no se puede seguir leyendo. */
  | 'frame-too-large'
  | 'error';

export interface CloseInfo {
  reason: CloseReason;
  /** Bytes de una trama a medias que se descartaron al cerrar. */
  discardedBytes: number;
}

export interface Connection {
  /** Envía una línea ya terminada en `\n`. `false` si la conexión está cerrada. */
  send(line: string): boolean;
  close(): void;
  /** Se resuelve una vez, cuando la conexión termina por cualquier motivo. Nunca rechaza. */
  readonly closed: Promise<CloseInfo>;
}

export interface ConnectionHandlers {
  /** Una línea completa. Una trama cortada por una desconexión **no** llega aquí. */
  onLine: (line: string) => void;
}

/** Abre una conexión. Rechaza si no se puede establecer. */
export type Connector = (ipcPath: string, handlers: ConnectionHandlers) => Promise<Connection>;

export interface SocketConnectorOptions {
  /** Límite de una trama entrante. */
  maxMessageBytes?: number;
  connectTimeoutMs?: number;
}

/** Conector real: `net` sobre el pipe o socket del endpoint. */
export function socketConnector(options: SocketConnectorOptions = {}): Connector {
  const maxBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;

  return (ipcPath, handlers) =>
    new Promise<Connection>((resolve, reject) => {
      const socket = createConnection(ipcPath);
      const decoder = new LineDecoder(maxBytes);
      let reason: CloseReason = 'remote';
      let established = false;
      let resolveClosed!: (info: CloseInfo) => void;
      const closed = new Promise<CloseInfo>((r) => (resolveClosed = r));

      const timer = setTimeout(() => {
        socket.destroy(new Error('connect timeout'));
      }, connectTimeoutMs);
      timer.unref?.();

      socket.on('data', (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (err) {
          reason = err instanceof FrameTooLargeError ? 'frame-too-large' : 'error';
          socket.destroy();
          return;
        }
        for (const line of lines) {
          try {
            handlers.onLine(line);
          } catch {
            /* un consumidor que lanza no puede tumbar la lectura del socket */
          }
        }
      });
      socket.on('error', (err) => {
        if (!established) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        if (reason === 'remote') reason = 'error';
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolveClosed({ reason, discardedBytes: decoder.bufferedBytes });
      });
      socket.once('connect', () => {
        established = true;
        clearTimeout(timer);
        resolve({
          send(line: string): boolean {
            if (socket.destroyed || !socket.writable) return false;
            // El valor de retorno de `write` es presión de salida, no un fallo:
            // la línea queda en el buffer del socket. Quien publique en volumen
            // pone su propia cola acotada por delante (ver docs/protocol.md).
            socket.write(line);
            return true;
          },
          close(): void {
            if (reason === 'remote') reason = 'local';
            socket.destroy();
          },
          closed,
        });
      });
    });
}
