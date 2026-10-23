import type { Readable, Writable } from 'node:stream';

/**
 * JSON-RPC 2.0 con el *framing* de LSP (`Content-Length: N` + CRLF CRLF) sobre
 * un `Readable`/`Writable` cualesquiera. Puro respecto a procesos: el
 * `LspClient` le pasa los pipes de `execa` y los tests, streams en memoria.
 *
 * El parser es incremental: un chunk puede traer medio mensaje, un mensaje
 * entero o cinco, y las cabeceras pueden llegar partidas. También contesta lo
 * que el servidor pregunta y no implementamos, en vez de dejarlo colgado (un
 * `workspace/configuration` sin respuesta bloquea el arranque del server).
 */

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** Error JSON-RPC devuelto por el servidor (o por el transporte). */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export interface JsonRpcConnectionOptions {
  /** De donde llegan los mensajes del servidor. */
  readable: Readable;
  /** A donde se escriben los nuestros. */
  writable: Writable;
  /**
   * Se llama UNA vez al cerrar la conexión, con el motivo si lo hubo. El
   * `LspClient` lo usa para saber que el transporte se rompió (no que lo
   * cerráramos nosotros) y dar el servidor por muerto.
   */
  onClose?: (reason: Error) => void;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type NotificationHandler = (params: unknown) => void;
export type RequestHandler = (params: unknown) => unknown;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Código JSON-RPC de «método no encontrado». */
const METHOD_NOT_FOUND = -32601;
/**
 * Topes del *framing*. Sin ellos, un servidor roto (o un byte perdido en el
 * pipe) puede hacer que el buffer crezca sin fin o que se reserve un cuerpo de
 * gigabytes con solo decirlo en la cabecera.
 */
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Error de cancelación: el manager distingue «abortado» de «roto». */
export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function separatorIndex(buffer: Buffer): { start: number; end: number } | null {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { start: crlf, end: crlf + 4 };
  if (lf !== -1) return { start: lf, end: lf + 2 };
  return null;
}

function contentLengthOf(headerText: string): number | null {
  for (const line of headerText.split(/\r?\n/)) {
    const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
    if (match) return Number.parseInt(match[1]!, 10);
  }
  return null;
}

export class JsonRpcConnection {
  private readonly options: JsonRpcConnectionOptions;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Map<string, Set<NotificationHandler>>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private closed = false;

  constructor(options: JsonRpcConnectionOptions) {
    this.options = options;
    options.readable.on('data', this.onData);
    options.readable.on('error', this.onTransportError);
    options.readable.on('close', this.onTransportError);
    options.readable.on('end', this.onTransportError);
    options.writable.on('error', this.onTransportError);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Manda una petición y espera su respuesta (`timeoutMs` la aborta). */
  request<T = unknown>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(`JSON-RPC connection closed; "${method}" not sent`));
    }
    const { timeoutMs, signal } = options;
    if (signal?.aborted) {
      return Promise.reject(abortError(`JSON-RPC request "${method}" aborted`));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const fail = (message: string) => {
        this.settle(id);
        reject(new Error(message));
      };
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(
              () => fail(`JSON-RPC request "${method}" timed out after ${timeoutMs} ms`),
              timeoutMs,
            )
          : undefined;
      // No mantiene vivo el proceso solo por una petición pendiente.
      timer?.unref?.();

      const onAbort = () => {
        this.settle(id);
        reject(abortError(`JSON-RPC request "${method}" aborted`));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Notificación: sin `id`, nadie espera respuesta. */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Escucha una notificación del servidor. Devuelve el «desuscribirse». */
  onNotification(method: string, handler: NotificationHandler): () => void {
    const set = this.notifications.get(method) ?? new Set<NotificationHandler>();
    set.add(handler);
    this.notifications.set(method, set);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.notifications.delete(method);
    };
  }

  /**
   * Contesta una petición del servidor. Lo que no se registre aquí cae en los
   * valores por defecto (ver `answerServerRequest`).
   */
  onRequest(method: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  /** Corta la conexión: rechaza lo pendiente y deja de escuchar los streams. */
  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const { readable, writable } = this.options;
    readable.off('data', this.onData);
    readable.off('error', this.onTransportError);
    readable.off('close', this.onTransportError);
    readable.off('end', this.onTransportError);
    writable.off('error', this.onTransportError);
    const error = reason ?? new Error('JSON-RPC connection closed');
    for (const id of [...this.pending.keys()]) {
      const pending = this.pending.get(id);
      this.settle(id);
      pending?.reject(error);
    }
    try {
      this.options.onClose?.(error);
    } catch {
      // El observador no puede romper el cierre.
    }
  }

  // --- transporte -----------------------------------------------------------

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    this.options.writable.write(Buffer.concat([header, body]));
  }

  private readonly onTransportError = (): void => {
    // Un pipe cerrado no puede dejar promesas colgadas para siempre.
    if (this.closed) return;
    this.close(new Error('JSON-RPC transport closed'));
  };

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
    for (;;) {
      const separator = separatorIndex(this.buffer);
      if (separator === null) {
        // Sin separador no hay mensaje: si ya es enorme, no es framing.
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.close(
            new Error(
              `JSON-RPC framing lost: ${this.buffer.length} bytes without a header separator`,
            ),
          );
        }
        return;
      }
      if (separator.start > MAX_HEADER_BYTES) {
        this.close(new Error(`JSON-RPC header exceeds ${MAX_HEADER_BYTES} bytes`));
        return;
      }
      const headerText = this.buffer.subarray(0, separator.start).toString('ascii');
      const length = contentLengthOf(headerText);
      if (length === null) {
        // Cabecera ilegible: se tira el bloque en vez de atascar el parser.
        this.buffer = this.buffer.subarray(separator.end);
        continue;
      }
      if (length > MAX_BODY_BYTES) {
        this.close(
          new Error(`JSON-RPC body of ${length} bytes exceeds the ${MAX_BODY_BYTES} byte limit`),
        );
        return;
      }
      if (this.buffer.length < separator.end + length) return; // falta el cuerpo
      const body = this.buffer.subarray(separator.end, separator.end + length).toString('utf8');
      this.buffer = this.buffer.subarray(separator.end + length);
      this.handleBody(body);
    }
  };

  // --- mensajes entrantes ---------------------------------------------------

  private handleBody(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return; // un mensaje corrupto no puede tumbar la sesión
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return;
    const msg = message as Record<string, unknown>;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const id = msg.id;

    if (method !== undefined) {
      if (typeof id === 'number' || typeof id === 'string') {
        void this.answerServerRequest(id, method, msg.params);
      } else {
        this.dispatchNotification(method, msg.params);
      }
      return;
    }

    if (typeof id !== 'number') return;
    const pending = this.pending.get(id);
    if (pending === undefined) return; // respuesta de una petición que ya venció
    this.settle(id);
    const error = msg.error as JsonRpcErrorObject | undefined;
    if (error !== undefined && error !== null) {
      pending.reject(new JsonRpcError(error.message, error.code, error.data));
      return;
    }
    pending.resolve(msg.result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handlers = this.notifications.get(method);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      try {
        handler(params);
      } catch {
        // Un handler que lanza no puede romper el parser.
      }
    }
  }

  private async answerServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const custom = this.requestHandlers.get(method);
    if (custom !== undefined) {
      try {
        const result = await custom(params);
        this.write({ jsonrpc: '2.0', id, result: result ?? null });
      } catch (err) {
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: (err as Error).message },
        });
      }
      return;
    }
    try {
      this.write({ jsonrpc: '2.0', id, result: this.defaultResult(method, params) });
    } catch (err) {
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: METHOD_NOT_FOUND, message: (err as Error).message },
      });
    }
  }

  /**
   * Respuestas por defecto a peticiones del servidor que no implementamos. Son
   * las que ningún cliente real contesta y bloquean el arranque si se ignoran.
   */
  private defaultResult(method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/configuration': {
        // Un `null` por cada ítem pedido: «no tengo configuración propia».
        const items = (params as { items?: unknown } | undefined)?.items;
        return Array.isArray(items) ? items.map(() => null) : [];
      }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
        return null;
      default:
        throw new Error(`method not found: ${method}`);
    }
  }

  private settle(id: number): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    pending.cleanup();
  }
}
