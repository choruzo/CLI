/**
 * Política de reconexión: cuánto esperar entre intentos. Solo decide tiempos;
 * qué se hace al reconectar es del cliente. Reconectar **nunca** reenvía
 * peticiones: lo único que se restablece son las suscripciones.
 */
export interface BackoffOptions {
  /** Espera del primer reintento. */
  initialMs?: number;
  /** Tope de la espera. */
  maxMs?: number;
  factor?: number;
  /** Fracción aleatoria que se suma (0 = sin jitter). */
  jitter?: number;
  /** Intentos antes de rendirse. `Infinity` = no rendirse. */
  maxAttempts?: number;
  /** Inyectable para tests. */
  random?: () => number;
}

export interface Backoff {
  /** Espera antes del intento `attempt` (1 = primer reintento), o `null` si ya no hay más. */
  delay(attempt: number): number | null;
}

export function createBackoff(options: BackoffOptions = {}): Backoff {
  const initialMs = options.initialMs ?? 250;
  const maxMs = options.maxMs ?? 10_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 0.2;
  const maxAttempts = options.maxAttempts ?? Infinity;
  const random = options.random ?? Math.random;
  return {
    delay(attempt: number): number | null {
      if (attempt > maxAttempts) return null;
      const base = Math.min(maxMs, initialMs * factor ** Math.max(0, attempt - 1));
      return Math.round(base * (1 + jitter * random()));
    },
  };
}

/** Espera que se puede cortar. Resuelve `false` si se cortó. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
