/**
 * Servidor de pruebas del Stratum Protocol. **No es un daemon**: no aloja
 * sesiones ni guarda estado. Habla el protocolo de verdad —mismo framing, mismo
 * códec, mismo `RpcPeer`— sobre un pipe real, con los handlers que le dé cada
 * test, y deja provocar las averías que un servidor sano no provoca (cortar a
 * mitad de trama, no contestar, mandar basura).
 */
import { randomBytes } from 'crypto';
import { createServer, type Server, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MAX_MESSAGE_BYTES,
  MAX_UNAUTHENTICATED_MESSAGE_BYTES,
  STRATUM_PROTOCOL_VERSION,
  capabilitiesOf,
  type Capability,
  type HelloParams,
  type MethodName,
} from '../../protocol/index.js';
import { ProtocolError, encodeMessage, errorResponse } from '../../ipc/codec.js';
import { FrameTooLargeError, LineDecoder } from '../../ipc/framing.js';
import { RpcPeer, type RequestHandlers } from '../../ipc/peer.js';
import { METHODS } from '../../protocol/index.js';
import type { Endpoint } from '../discovery.js';

export interface FakeServerOptions {
  handlers?: RequestHandlers;
  /** Versión que dice hablar (para simular una incompatible). */
  protocol?: number;
  /** Versión que devuelve en `core.hello` aunque haya aceptado la del cliente (servidor incoherente). */
  reportProtocol?: number;
  /** Capacidades que concede; por defecto, las de los roles pedidos. */
  grant?: (hello: HelloParams) => Capability[];
  /** Métodos que recibe y no contesta nunca. */
  silent?: MethodName[];
}

export interface FakeConnection {
  readonly id: number;
  readonly socket: Socket;
  peer: RpcPeer;
  authenticated: boolean;
  capabilities: Capability[];
}

export interface FakeServer {
  readonly endpoint: Endpoint;
  /** Peticiones recibidas (ya validadas), en orden, de todas las conexiones. */
  readonly received: Array<{ connectionId: number; method: string; params: unknown }>;
  readonly connections: FakeConnection[];
  /** Conexiones aceptadas desde el arranque. */
  readonly accepted: number;
  /** Corta todas las conexiones, como un servidor que muere. */
  dropAll(): void;
  /** Espera a que haya `n` conexiones autenticadas en total (acumulado). */
  waitForAuthenticated(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export function testIpcPath(): string {
  const name = `stratum-test-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const token = randomBytes(32).toString('hex');
  const ipcPath = testIpcPath();
  const protocol = options.protocol ?? STRATUM_PROTOCOL_VERSION;
  const received: FakeServer['received'] = [];
  const connections: FakeConnection[] = [];
  const silent = new Set<string>(options.silent ?? []);
  let accepted = 0;
  let authenticatedTotal = 0;
  const waiters: Array<() => void> = [];

  const server: Server = createServer((socket) => {
    const decoder = new LineDecoder(MAX_UNAUTHENTICATED_MESSAGE_BYTES);
    const conn: FakeConnection = {
      id: ++accepted,
      socket,
      authenticated: false,
      capabilities: [],
      peer: undefined as unknown as RpcPeer,
    };

    const record =
      <M extends MethodName>(method: M) =>
      (params: unknown): unknown => {
        received.push({ connectionId: conn.id, method, params });
        if (silent.has(method)) return new Promise(() => undefined);
        const handler = options.handlers?.[method] as ((p: unknown) => unknown) | undefined;
        if (!handler) throw new ProtocolError('METHOD_NOT_FOUND', 'Method not available here.');
        return handler(params);
      };

    const handlers: Record<string, (params: unknown) => unknown> = {};
    for (const method of Object.keys(METHODS) as MethodName[]) handlers[method] = record(method);
    handlers['core.hello'] = (params: unknown) => {
      const hello = params as HelloParams;
      received.push({
        connectionId: conn.id,
        method: 'core.hello',
        params: { ...hello, token: '…' },
      });
      if (hello.protocol !== protocol) {
        throw new ProtocolError('PROTOCOL_MISMATCH', 'Unsupported protocol version.', { protocol });
      }
      if (hello.token !== token) throw new ProtocolError('UNAUTHORIZED', 'Bad token.');
      conn.authenticated = true;
      conn.capabilities = options.grant?.(hello) ?? capabilitiesOf(hello.roles);
      decoder.setLimit(MAX_MESSAGE_BYTES);
      authenticatedTotal++;
      for (const w of waiters.splice(0)) w();
      return {
        protocol: options.reportProtocol ?? protocol,
        server: { version: '0.0.0-test', platform: process.platform },
        connectionId: conn.id,
        capabilities: conn.capabilities,
        features: [],
      };
    };

    conn.peer = new RpcPeer({
      send: (line) => (socket.destroyed ? false : (socket.write(line), true)),
      handlers: handlers as RequestHandlers,
      guard: (method) => {
        if (method === 'core.hello') return null;
        if (!conn.authenticated) return { code: 'UNAUTHORIZED', message: 'Handshake required.' };
        const needed = METHODS[method].capability;
        return needed && !conn.capabilities.includes(needed)
          ? { code: 'FORBIDDEN', message: 'Missing capability.', data: { capability: needed } }
          : null;
      },
    });
    connections.push(conn);

    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        const limit = err instanceof FrameTooLargeError ? err.limit : 0;
        socket.end(
          encodeMessage(
            errorResponse(null, {
              code: 'FRAME_TOO_LARGE',
              message: 'Message too large.',
              data: { limit },
            }),
          ),
          () => socket.destroy(),
        );
        return;
      }
      for (const line of lines) conn.peer.handleLine(line);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      conn.peer.close();
      const i = connections.indexOf(conn);
      if (i !== -1) connections.splice(i, 1);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ipcPath, resolve);
  });

  return {
    endpoint: {
      protocol,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: '0.0.0-test',
      ipcPath,
      token,
    },
    received,
    connections,
    get accepted() {
      return accepted;
    },
    dropAll(): void {
      for (const c of [...connections]) c.socket.destroy();
    },
    waitForAuthenticated(n: number, timeoutMs = 5_000): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout waiting for ${n} authenticated connections`)),
          timeoutMs,
        );
        const check = (): void => {
          if (authenticatedTotal >= n) {
            clearTimeout(timer);
            resolve();
          } else waiters.push(check);
        };
        check();
      });
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const c of [...connections]) c.socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}
