import type { ProtocolErrorPayload } from './errors.js';

/**
 * Sobre de los mensajes. Tiene la **forma** de JSON-RPC 2.0 —petición con
 * `id` + `method`, respuesta con el mismo `id`, notificación sin `id`— pero no
 * pretende ser compatible con librerías JSON-RPC: no lleva el campo `jsonrpc`,
 * no admite lotes y el código de error es una cadena (`ProtocolErrorCode`).
 *
 * Transporte: un mensaje por línea (NDJSON, UTF-8). Los dos extremos pueden
 * enviar peticiones: el cliente al servidor, y el servidor a un anfitrión par.
 */

/** Correlación de una petición. Lo elige quien la envía; único entre sus peticiones abiertas. */
export type MessageId = string | number;

export interface RequestMessage {
  id: MessageId;
  method: string;
  params?: unknown;
}

export interface SuccessResponseMessage {
  id: MessageId;
  result: unknown;
}

export interface ErrorResponseMessage {
  /** `null` si el mensaje que provocó el error no traía un `id` legible. */
  id: MessageId | null;
  error: ProtocolErrorPayload;
}

export type ResponseMessage = SuccessResponseMessage | ErrorResponseMessage;

/** Mensaje sin `id`: no tiene respuesta. */
export interface NotificationMessage {
  method: string;
  params?: unknown;
}

export type ProtocolMessage = RequestMessage | ResponseMessage | NotificationMessage;

export type MessageKind = 'request' | 'response' | 'notification';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageId(value: unknown): value is MessageId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Clasifica un valor ya parseado. Devuelve `null` si no tiene forma de mensaje:
 * la validación fina (longitudes, campos de más) es de los schemas.
 */
export function messageKind(value: unknown): MessageKind | null {
  if (!isObject(value)) return null;
  const hasMethod = typeof value.method === 'string';
  const hasOutcome = 'result' in value || 'error' in value;
  if (hasMethod && hasOutcome) return null;
  if (hasMethod) {
    if (!('id' in value)) return 'notification';
    return isMessageId(value.id) ? 'request' : null;
  }
  if (!hasOutcome || ('result' in value && 'error' in value)) return null;
  if ('error' in value) return value.id === null || isMessageId(value.id) ? 'response' : null;
  return isMessageId(value.id) ? 'response' : null;
}

export function isErrorResponse(message: ResponseMessage): message is ErrorResponseMessage {
  return 'error' in message;
}
