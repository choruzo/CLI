/**
 * Códec del Stratum Protocol sobre el framing NDJSON: de línea a mensaje
 * validado y de mensaje a línea, más la traducción de errores. Lo comparten los
 * dos extremos del canal; no sabe de sockets ni de sesiones.
 */
import type { ZodError } from 'zod';
import {
  isMethodName,
  isNotificationName,
  messageKind,
  type MessageId,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type NotificationMessage,
  type NotificationName,
  type NotificationParams,
  type ProtocolErrorCode,
  type ProtocolErrorData,
  type ProtocolErrorPayload,
  type ProtocolMessage,
  type RequestMessage,
  type ResponseMessage,
} from '../protocol/index.js';
import {
  NOTIFICATION_PARAMS,
  PARAMS,
  RESULTS,
  errorResponseSchema,
  notificationMessageSchema,
  requestMessageSchema,
  successResponseSchema,
} from '../protocol/schemas.js';
import { encodeLine } from './framing.js';

/**
 * Error del protocolo: lo lanza un handler para contestar con un código
 * concreto, y es en lo que se convierte la respuesta de error que recibe un
 * cliente. Su `message` viaja tal cual, así que no debe llevar rutas internas,
 * variables ni secretos.
 */
export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';

  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
    readonly data?: ProtocolErrorData,
  ) {
    super(message);
  }

  toPayload(): ProtocolErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

/** Texto fijo de un fallo interno: el detalle se queda en el log de quien falló. */
export const INTERNAL_ERROR_MESSAGE = 'Internal error.';

/**
 * Lo que se le cuenta al otro extremo de un error cualquiera. Solo un
 * `ProtocolError` conserva su código y su mensaje; todo lo demás —una excepción
 * de un handler, con su stack y sus rutas— sale como `INTERNAL_ERROR` genérico.
 */
export function toErrorPayload(err: unknown): ProtocolErrorPayload {
  if (err instanceof ProtocolError) return err.toPayload();
  return { code: 'INTERNAL_ERROR', message: INTERNAL_ERROR_MESSAGE };
}

export function encodeMessage(message: ProtocolMessage): string {
  return encodeLine(message);
}

export function successResponse(id: MessageId, result: unknown): ResponseMessage {
  return { id, result };
}

export function errorResponse(id: MessageId | null, error: ProtocolErrorPayload): ResponseMessage {
  return { id, error };
}

export type DecodedMessage =
  | { kind: 'request'; message: RequestMessage }
  | { kind: 'response'; message: ResponseMessage }
  | { kind: 'notification'; message: NotificationMessage }
  /** No es un mensaje válido. `id` es el de la petición que lo parecía, si se pudo leer. */
  | { kind: 'invalid'; id: MessageId | null; error: ProtocolErrorPayload };

function invalid(id: MessageId | null, message: string): DecodedMessage {
  return { kind: 'invalid', id, error: { code: 'INVALID_REQUEST', message } };
}

function readableId(value: unknown): MessageId | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
}

/** De línea a mensaje. Nunca lanza: lo que no vale sale como `invalid`. */
export function decodeMessage(line: string): DecodedMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return invalid(null, 'Message is not valid JSON.');
  }
  const kind = messageKind(value);
  if (kind === 'request') {
    const parsed = requestMessageSchema.safeParse(value);
    return parsed.success
      ? { kind, message: parsed.data }
      : invalid(readableId(value), 'Malformed request.');
  }
  if (kind === 'notification') {
    const parsed = notificationMessageSchema.safeParse(value);
    return parsed.success
      ? { kind, message: parsed.data }
      : invalid(null, 'Malformed notification.');
  }
  if (kind === 'response') {
    const schema = 'error' in (value as object) ? errorResponseSchema : successResponseSchema;
    const parsed = schema.safeParse(value);
    return parsed.success ? { kind, message: parsed.data } : invalid(null, 'Malformed response.');
  }
  return invalid(readableId(value), 'Message is not a request, a response or a notification.');
}

function issuesOf(error: ZodError): Array<{ path: string; message: string }> {
  // Solo ruta y motivo: nunca el valor recibido, que puede ser sensible.
  return error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export type ValidatedRequest<M extends MethodName = MethodName> =
  | { ok: true; method: M; params: MethodParams<M> }
  | { ok: false; error: ProtocolErrorPayload };

/** Valida una petición entrante: que el método exista y que sus parámetros cumplan su schema. */
export function validateRequest(method: string, params: unknown): ValidatedRequest {
  if (!isMethodName(method)) {
    return { ok: false, error: { code: 'METHOD_NOT_FOUND', message: 'Unknown method.' } };
  }
  // Sin `params` equivale a `{}`: un método sin parámetros no obliga a enviarlos.
  const parsed = PARAMS[method].safeParse(params ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_PARAMS',
        message: `Invalid params for ${method}.`,
        data: { issues: issuesOf(parsed.error) },
      },
    };
  }
  return { ok: true, method, params: parsed.data };
}

/** Valida el resultado de un método. `null` si no cumple el contrato. */
export function validateResult<M extends MethodName>(
  method: M,
  result: unknown,
): { ok: true; result: MethodResult<M> } | { ok: false } {
  const parsed = RESULTS[method].safeParse(result);
  return parsed.success ? { ok: true, result: parsed.data as MethodResult<M> } : { ok: false };
}

export type ValidatedNotification = {
  [N in NotificationName]: { name: N; params: NotificationParams<N> };
}[NotificationName];

/**
 * Valida una notificación entrante. `null` si es desconocida o no cumple su
 * schema: quien la recibe la ignora (un servidor más nuevo puede enviar
 * notificaciones que este cliente no conoce).
 */
export function validateNotification(
  method: string,
  params: unknown,
): ValidatedNotification | null {
  if (!isNotificationName(method)) return null;
  const parsed = NOTIFICATION_PARAMS[method].safeParse(params);
  return parsed.success ? ({ name: method, params: parsed.data } as ValidatedNotification) : null;
}
