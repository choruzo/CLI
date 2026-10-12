/**
 * Errores del protocolo. El **código** es para los clientes; el `message` es
 * para personas y puede cambiar sin avisar: ningún cliente decide por él.
 *
 * Un error que viaja por el protocolo nunca lleva stack trace, variables de
 * entorno, config ni secretos. El detalle técnico se queda en el log local del
 * proceso que falló.
 */
export const PROTOCOL_ERROR_CODES = [
  /** Versiones de protocolo incompatibles. Solo en respuesta a `core.hello`. */
  'PROTOCOL_MISMATCH',
  /** Sin handshake, o con un token que no vale. */
  'UNAUTHORIZED',
  /** Autenticado, pero su rol no tiene la capacidad que exige el método. */
  'FORBIDDEN',
  /** El mensaje no tiene forma de petición, respuesta ni notificación. */
  'INVALID_REQUEST',
  'METHOD_NOT_FOUND',
  /** Los parámetros no validan contra el schema del método. */
  'INVALID_PARAMS',
  /** La sesión, el run, la aprobación… no existe (o no es visible para quien pregunta). */
  'NOT_FOUND',
  /** La sesión ya tiene un turno en curso. */
  'BUSY',
  /** La aprobación, pregunta o plan ya se resolvió: otro cliente llegó antes. */
  'ALREADY_RESOLVED',
  /** La petición parte de un estado que ya no es el vigente (un `runId` que ya no es el actual). */
  'STALE_STATE',
  /** Un mensaje supera el tamaño máximo. La conexión se cierra tras avisar. */
  'FRAME_TOO_LARGE',
  /** No se puede atender ahora: el anfitrión de la sesión no está conectado, el servidor se apaga. */
  'UNAVAILABLE',
  /** Fallo del servidor. Sin más detalle: está en su log. */
  'INTERNAL_ERROR',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** Cuerpo de error de una respuesta. */
export interface ProtocolErrorPayload {
  code: ProtocolErrorCode;
  /** Texto para personas. No es parte del contrato. */
  message: string;
  /** Datos estructurados propios del código (ver `ProtocolErrorData`). */
  data?: ProtocolErrorData;
}

/** Datos que acompañan a algunos códigos. Todos opcionales y sin información interna. */
export interface ProtocolErrorData {
  /** `PROTOCOL_MISMATCH`: la versión que habla el servidor. */
  protocol?: number;
  /** `INVALID_PARAMS`: qué campos no validan (`path` con puntos; `''` = el objeto). */
  issues?: Array<{ path: string; message: string }>;
  /** `FORBIDDEN`: la capacidad que hacía falta. */
  capability?: string;
  /** `ALREADY_RESOLVED`: cómo quedó resuelto. */
  resolution?: string;
  /**
   * `UNAVAILABLE`: por qué. `host-unavailable` = el anfitrión par de la sesión
   * no está conectado; `peer-hosted` = eso solo puede hacerlo el proceso que la
   * aloja.
   */
  reason?: string;
  /** `FRAME_TOO_LARGE`: el límite en bytes. */
  limit?: number;
}

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}
