import { redactSecrets } from '../security/redact-output.js';

/**
 * Errores del cliente del LLM con su clasificación (§12.3).
 *
 * El loop decide con `retryable` si vuelve a intentar la misma petición contra
 * el mismo provider (backoff 1s/2s/4s); el fallback a otro provider no depende
 * de esto, solo de que no se haya emitido nada visible todavía.
 *
 * - `http`: el backend respondió con un status ≠ 2xx.
 * - `network`: no se pudo hablar con el backend (conexión rechazada, DNS, reset).
 * - `timeout`: el backend dejó de mandar bytes más tiempo del permitido.
 * - `stream`: el backend mandó un `{"error": …}` dentro del stream SSE.
 */
export type ProviderErrorKind = 'http' | 'network' | 'timeout' | 'stream';

export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly retryable: boolean,
    readonly details: { status?: number; code?: string; retryAfterMs?: number } = {},
  ) {
    super(message);
  }
}

/**
 * Status que merece la pena reintentar: el backend está ocupado, cargando el
 * modelo (llama.cpp y Ollama responden 503 mientras cargan) o un proxy
 * intermedio falló. Un 4xx de petición (400 por contexto desbordado, 401, 404)
 * falla igual al reintentar: reintentarlo solo retrasaba el error 7 s.
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/**
 * Errores de red de undici/Node que suelen ser transitorios. Los timeouts de
 * conexión (`ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`) no están: el SO o undici
 * ya esperaron 10–20 s, y repetirlos tres veces solo alarga el cuelgue antes
 * del fallback a otro provider.
 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
]);

/** Cuánto se lee como mucho del cuerpo de una respuesta de error. */
export const ERROR_BODY_READ_LIMIT = 64 * 1024;
/** Cuánto del mensaje del backend llega al error (UI, historial, logs). */
export const ERROR_MESSAGE_LIMIT = 500;
/** Un `Retry-After` mayor que esto no se espera: se falla y decide el usuario. */
export const MAX_RETRY_AFTER_MS = 30_000;

/** Origen de la URL sin credenciales ni ruta: lo único que el error necesita nombrar. */
export function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<baseUrl inválida>';
  }
}

function clip(text: string, limit = ERROR_MESSAGE_LIMIT): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/**
 * Resume el cuerpo de una respuesta de error en una frase segura: el
 * `error.message` si es el JSON de OpenAI/llama.cpp/Ollama, una nota si es una
 * página HTML (un proxy, un portal cautivo) y, si no, el texto recortado.
 * Siempre pasa por el núcleo de redacción: hay backends que devuelven la
 * cabecera `Authorization` recibida en el mensaje de error.
 */
export function describeErrorBody(body: string, contentType = ''): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  let message: string | undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      message = extractErrorMessage(parsed);
    } catch {
      // No es JSON: se trata como texto.
    }
  }
  if (message === undefined) {
    const looksHtml = contentType.includes('html') || /^<!doctype html|^<html[\s>]/i.test(trimmed);
    message = looksHtml
      ? `respuesta HTML (${trimmed.length} bytes), probablemente de un proxy`
      : trimmed;
  }
  return redactSecrets(clip(message)).text;
}

/**
 * `error.message` de los formatos habituales: `{error: {message}}` (OpenAI,
 * llama.cpp, vLLM, LiteLLM), `{error: "…"}` (Ollama) o `{message}`.
 */
export function extractErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const err = obj['error'];
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const msg = (err as Record<string, unknown>)['message'];
    if (typeof msg === 'string') return msg;
    return JSON.stringify(err);
  }
  if (typeof obj['message'] === 'string') return obj['message'];
  return undefined;
}

/** `Retry-After` en segundos o como fecha HTTP; `undefined` si no hay o no se entiende. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export function httpError(
  status: number,
  statusText: string,
  body: string,
  contentType: string,
  retryAfterHeader: string | null,
): ProviderError {
  const detail = describeErrorBody(body, contentType);
  const head = `LLM API error ${status}${statusText ? ` ${statusText}` : ''}`;
  return new ProviderError(
    detail ? `${head}: ${detail}` : head,
    'http',
    isRetryableStatus(status),
    {
      status,
      retryAfterMs: parseRetryAfter(retryAfterHeader),
    },
  );
}

/** Código de sistema de un fallo de `fetch` (undici lo anida en `cause`, a veces dos niveles). */
export function networkErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Traduce un fallo de red de `fetch` o de la lectura del cuerpo a un
 * `ProviderError`. `phase` distingue «no se pudo conectar» de «se cortó a
 * mitad»: lo segundo nunca se reintenta desde el loop si ya se emitieron
 * chunks, pero el mensaje tiene que decirlo.
 */
export function networkError(
  err: unknown,
  origin: string,
  phase: 'connect' | 'stream',
): ProviderError {
  const code = networkErrorCode(err);
  const retryable = code === undefined || RETRYABLE_NETWORK_CODES.has(code);
  const what =
    phase === 'connect'
      ? `LLM connection failed to ${origin}`
      : `LLM stream from ${origin} was interrupted`;
  const reason = code ?? (err instanceof Error ? clip(err.message, 200) : 'unknown error');
  return new ProviderError(`${what}: ${reason}`, 'network', retryable, { code });
}

export function timeoutError(
  origin: string,
  idleMs: number,
  phase: 'headers' | 'body',
): ProviderError {
  const secs =
    idleMs < 10_000 ? `${Number((idleMs / 1000).toFixed(1))}` : `${Math.round(idleMs / 1000)}`;
  const msg =
    phase === 'headers'
      ? `LLM request timeout: ${origin} did not answer within ${secs}s`
      : `LLM stream timeout: ${origin} sent nothing for ${secs}s`;
  // No se reintenta contra el mismo backend: ya se esperó el tiempo entero, y
  // repetirlo tres veces convertiría un cuelgue de 5 min en uno de 20. Sí puede
  // conmutar a otro provider (eso lo decide el loop).
  return new ProviderError(msg, 'timeout', false);
}

export function streamError(payload: unknown, origin: string): ProviderError {
  const message = extractErrorMessage(payload) ?? 'unknown error';
  return new ProviderError(
    `LLM stream error from ${origin}: ${redactSecrets(clip(message)).text}`,
    'stream',
    false,
  );
}

/** ¿Merece la pena repetir la petición contra el mismo provider? */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) return err.retryable;
  // Errores que no salen del cliente HTTP (providers de terceros, mocks): se
  // conserva el comportamiento anterior, que reintentaba todo.
  return true;
}
