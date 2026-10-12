/**
 * Un extremo del canal: correlaciona peticiones con respuestas, reparte
 * notificaciones y atiende las peticiones del otro lado. No sabe de sockets —
 * recibe líneas y entrega líneas—, así que vale para el cliente, para un
 * servidor y para los tests.
 */
import {
  METHODS,
  isErrorResponse,
  type MessageId,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationName,
  type NotificationParams,
  type ProtocolErrorPayload,
} from '../protocol/index.js';
import { getLogger } from '../logging/index.js';
import {
  ProtocolError,
  decodeMessage,
  encodeMessage,
  errorResponse,
  successResponse,
  toErrorPayload,
  validateNotification,
  validateRequest,
  validateResult,
  type ValidatedNotification,
} from './codec.js';

const log = getLogger('ipc').child('peer');

/**
 * La conexión se perdió (o venció el plazo) con la petición ya enviada y sin
 * respuesta. **No se sabe si se ejecutó.** Para un método que cambia estado
 * (`mutating`) eso significa que no se puede reenviar a ciegas: quien llama
 * tiene que averiguar qué pasó (leer el estado) antes de decidir.
 */
export class UnknownOutcomeError extends Error {
  override readonly name = 'UnknownOutcomeError';
  readonly outcome = 'unknown';

  constructor(
    readonly method: MethodName,
    readonly reason: 'connection-lost' | 'timeout' | 'aborted',
  ) {
    super(
      `${method}: ${reason} before a response arrived; whether it was applied is unknown.` +
        (METHODS[method].mutating ? ' It changes state and was not retried.' : ''),
    );
  }

  /** `true` si el método cambia estado: reenviarlo podría aplicarlo dos veces. */
  get mutating(): boolean {
    return METHODS[this.method].mutating;
  }
}

/** La petición no llegó a salir (sin conexión, o cancelada antes de enviarla). Reenviarla es seguro. */
export class NotSentError extends Error {
  override readonly name = 'NotSentError';
  readonly outcome = 'not-sent';

  constructor(
    readonly method: MethodName,
    readonly reason: 'not-connected' | 'aborted' = 'not-connected',
  ) {
    super(`${method}: ${reason}; the request was not sent.`);
  }
}

/** El otro extremo contestó algo que no cumple el contrato del método. */
export class ProtocolViolationError extends Error {
  override readonly name = 'ProtocolViolationError';

  constructor(readonly method: MethodName) {
    super(`${method}: the response does not match the protocol.`);
  }
}

export type RequestHandler<M extends MethodName> = (
  params: MethodParams<M>,
) => MethodResult<M> | Promise<MethodResult<M>>;

export type RequestHandlers = { [M in MethodName]?: RequestHandler<M> };

export interface RequestOptions {
  /** Plazo de la respuesta. `0` = sin plazo. Por defecto, el del peer. */
  timeoutMs?: number;
  /** Deja de esperar. La petición ya salió: el resultado queda como desconocido. */
  signal?: AbortSignal;
}

export interface RpcPeerOptions {
  /**
   * Entrega una línea al transporte. Devuelve `false` si no se pudo enviar
   * (conexión cerrada). No debe lanzar ni bloquear.
   */
  send: (line: string) => boolean;
  /** Peticiones que este extremo atiende. Lo que no esté aquí es `METHOD_NOT_FOUND`. */
  handlers?: RequestHandlers;
  /**
   * Se consulta antes de atender una petición ya validada. Devolver un error la
   * rechaza (sin handshake, sin capacidad). Es el punto de autorización.
   */
  guard?: (method: MethodName) => ProtocolErrorPayload | null;
  onNotification?: (notification: ValidatedNotification) => void;
  /** Línea que no era un mensaje válido, o respuesta que nadie esperaba. Solo diagnóstico. */
  onProtocolError?: (detail: string) => void;
  /** Plazo por defecto de las peticiones salientes. `0` = sin plazo. */
  requestTimeoutMs?: number;
  /**
   * Tamaño máximo de un mensaje saliente, en bytes. Una petición mayor no se
   * envía (`FRAME_TOO_LARGE` local): el otro extremo cerraría la conexión.
   */
  maxMessageBytes?: number;
}

interface Pending {
  method: MethodName;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export class RpcPeer {
  private readonly pending = new Map<MessageId, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: RpcPeerOptions) {}

  /** Peticiones enviadas que aún esperan respuesta. */
  get pendingCount(): number {
    return this.pending.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Envía una petición y espera su respuesta. Rechaza con:
   *  - `ProtocolError` — el otro extremo contestó con un error;
   *  - `NotSentError` — no salió; se puede reenviar;
   *  - `UnknownOutcomeError` — salió y no hubo respuesta; **no** se reenvía sola;
   *  - `ProtocolViolationError` — la respuesta no cumple el contrato.
   */
  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options: RequestOptions = {},
  ): Promise<MethodResult<M>> {
    if (this.closed) return Promise.reject(new NotSentError(method));
    if (options.signal?.aborted) return Promise.reject(new NotSentError(method, 'aborted'));

    const id = this.nextId++;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.opts.requestTimeoutMs ?? 0;
      let timer: NodeJS.Timeout | undefined;
      const onAbort = (): void => fail('aborted');
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (reason: UnknownOutcomeError['reason']): void => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(new UnknownOutcomeError(method, reason));
      };

      this.pending.set(id, {
        method,
        resolve: (result) => {
          const checked = validateResult(method, result);
          if (checked.ok) resolve(checked.result);
          else reject(new ProtocolViolationError(method));
        },
        reject,
        cleanup,
      });

      const line = encodeMessage({ id, method, params });
      const max = this.opts.maxMessageBytes ?? 0;
      if (max > 0 && Buffer.byteLength(line, 'utf8') > max) {
        this.pending.delete(id);
        reject(
          new ProtocolError('FRAME_TOO_LARGE', 'Request exceeds the maximum message size.', {
            limit: max,
          }),
        );
        return;
      }
      if (!this.opts.send(line)) {
        this.pending.delete(id);
        reject(new NotSentError(method));
        return;
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => fail('timeout'), timeoutMs);
        timer.unref?.();
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Envía una notificación. No hay respuesta ni garantía de entrega. */
  notify<N extends NotificationName>(name: N, params: NotificationParams<N>): boolean {
    if (this.closed) return false;
    return this.opts.send(encodeMessage({ method: name, params }));
  }

  /** Procesa una línea recibida. Nunca lanza. */
  handleLine(line: string): void {
    if (this.closed) return;
    const decoded = decodeMessage(line);
    switch (decoded.kind) {
      case 'response': {
        const entry = this.pending.get(decoded.message.id as MessageId);
        if (!entry) {
          // Tardía (ya venció su plazo) o inventada: no es de nadie.
          this.opts.onProtocolError?.('response without a pending request');
          return;
        }
        this.pending.delete(decoded.message.id as MessageId);
        entry.cleanup();
        if (isErrorResponse(decoded.message)) {
          const { code, message, data } = decoded.message.error;
          entry.reject(new ProtocolError(code, message, data));
        } else {
          entry.resolve(decoded.message.result);
        }
        return;
      }
      case 'notification': {
        const notification = validateNotification(decoded.message.method, decoded.message.params);
        // Desconocida o mal formada: se ignora, no rompe la conexión.
        if (notification) this.opts.onNotification?.(notification);
        else this.opts.onProtocolError?.(`ignored notification: ${decoded.message.method}`);
        return;
      }
      case 'request':
        void this.serve(decoded.message.id, decoded.message.method, decoded.message.params);
        return;
      case 'invalid':
        this.opts.onProtocolError?.(decoded.error.message);
        // Si parecía una petición, se contesta: quien la envió no se queda esperando.
        if (decoded.id !== null)
          this.opts.send(encodeMessage(errorResponse(decoded.id, decoded.error)));
        return;
    }
  }

  private async serve(id: MessageId, method: string, params: unknown): Promise<void> {
    const reply = (error: ProtocolErrorPayload): void => {
      this.opts.send(encodeMessage(errorResponse(id, error)));
    };
    const request = validateRequest(method, params);
    if (!request.ok) return reply(request.error);
    const denied = this.opts.guard?.(request.method);
    if (denied) return reply(denied);
    const handler = this.opts.handlers?.[request.method] as
      | ((p: unknown) => unknown | Promise<unknown>)
      | undefined;
    if (!handler) return reply({ code: 'METHOD_NOT_FOUND', message: 'Method not available here.' });
    try {
      const result = await handler(request.params);
      if (!this.closed) this.opts.send(encodeMessage(successResponse(id, result ?? {})));
    } catch (err) {
      // El detalle (stack, rutas) se queda aquí; al otro lado solo va el código.
      if (!(err instanceof ProtocolError)) log.error('request handler failed', { method, err });
      if (!this.closed) reply(toErrorPayload(err));
    }
  }

  /**
   * La conexión terminó. Toda petición sin respuesta queda con resultado
   * desconocido; ninguna se reenvía. Idempotente.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup();
      entry.reject(new UnknownOutcomeError(entry.method, 'connection-lost'));
    }
  }
}
