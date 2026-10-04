import type { IProvider, CompletionRequest, OpenAIStreamChunk } from './base.js';
import { isRetryableError, MAX_RETRY_AFTER_MS, ProviderError } from './errors.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('provider');

/** Espera `ms` o hasta que `signal` se aborte (entonces rechaza con su motivo). */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  /** Intentos totales (§12.3: 4 = 3 reintentos con 1s/2s/4s). */
  maxAttempts?: number;
  /** Retraso base en ms; el intento n espera `base · 2^(n-1)`. Inyectable para tests. */
  baseDelayMs?: number;
  /** Se llama antes de cada reintento (el loop lo anota en la traza). */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Stream del provider con reintento (§12.3), con dos reglas que antes no se
 * cumplían:
 *
 * 1. **Solo se reintenta si todavía no se entregó ningún chunk.** Reiniciar un
 *    stream a medias le daba al consumidor la respuesta dos veces: texto
 *    duplicado y, peor, los fragmentos de argumentos de una tool call pegados a
 *    los del segundo intento (JSON corrupto). Un corte a mitad se propaga.
 * 2. **Solo se reintenta lo transitorio** (`ProviderError.retryable`): un 400
 *    por contexto desbordado o un 401 fallan igual la segunda vez.
 *
 * Un `Retry-After` del backend sustituye al backoff si cabe en
 * `MAX_RETRY_AFTER_MS`; si pide más, no se reintenta. La espera atiende a la
 * cancelación del usuario.
 */
export async function* streamWithRetry(
  provider: IProvider,
  request: CompletionRequest,
  opts: RetryOptions = {},
): AsyncGenerator<OpenAIStreamChunk> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      const retryAfter =
        lastErr instanceof ProviderError ? lastErr.details.retryAfterMs : undefined;
      const wait = retryAfter !== undefined ? Math.max(retryAfter, backoff) : backoff;
      log.warn('stream retry', { attempt, maxAttempts, backoffMs: wait, err: lastErr });
      opts.onRetry?.(attempt, lastErr);
      await abortableDelay(wait, request.signal);
    }

    let yielded = false;
    try {
      for await (const chunk of provider.complete(request)) {
        yielded = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (request.signal?.aborted) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (yielded || !isRetryableError(err)) throw err;
      const retryAfter = err instanceof ProviderError ? err.details.retryAfterMs : undefined;
      if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) throw err;
      lastErr = err;
    }
  }
  log.error('stream failed after retries', { maxAttempts, err: lastErr });
  throw lastErr;
}
