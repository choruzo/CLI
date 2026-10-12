/**
 * `operationId` en el servidor: reconoce el **reenvío deliberado** de una
 * petición que cambia estado, para que no se aplique dos veces.
 *
 *   mismo cliente + mismo `operationId` + misma petición  → el resultado ya conocido
 *   mismo cliente + mismo `operationId` + otra petición    → `INVALID_PARAMS`
 *   `operationId` desconocido                              → se ejecuta
 *
 * Una operación en curso también cuenta: el reenvío espera a la misma promesa.
 *
 * Límites, a propósito:
 *  - **en memoria**: no sobrevive a un reinicio del daemon;
 *  - **acotada**: como mucho `max` entradas, cada una durante `ttlMs`; pasado
 *    eso el `operationId` vuelve a ser desconocido y la petición se ejecuta;
 *  - el «cliente» es lo que la conexión declaró ser (`kind` + `name`), no una
 *    identidad verificada: sirve contra duplicados accidentales, no es una
 *    medida de seguridad;
 *  - un fallo interno no se recuerda (reintentar tiene sentido); un error del
 *    protocolo (`BUSY`, `NOT_FOUND`…) sí: es el resultado de esa operación.
 */
import { createHash } from 'crypto';
import { ProtocolError } from '../ipc/codec.js';
import { canonicalJson } from '../tools/canonical-json.js';

export interface OperationCacheOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface OperationKey {
  /** Identidad declarada del cliente (`kind:name`). */
  client: string;
  operationId: string;
  method: string;
  /** Parámetros de la petición. `operationId` no entra en la comparación. */
  params: unknown;
}

interface Entry {
  fingerprint: string;
  outcome: Promise<unknown>;
  expiresAt: number;
}

export const DEFAULT_OPERATION_TTL_MS = 10 * 60_000;
export const DEFAULT_OPERATION_CACHE_SIZE = 1_000;

function fingerprint(method: string, params: unknown): string {
  const rest: Record<string, unknown> =
    typeof params === 'object' && params !== null ? { ...(params as object) } : {};
  delete rest.operationId;
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(JSON.stringify(canonicalJson(rest)))
    .digest('hex');
}

export class OperationCache {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: OperationCacheOptions = {}) {
    this.max = Math.max(1, opts.max ?? DEFAULT_OPERATION_CACHE_SIZE);
    this.ttlMs = opts.ttlMs ?? DEFAULT_OPERATION_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Ejecuta `exec` una sola vez por operación. Un reenvío recibe el mismo
   * resultado (o el mismo error) sin volver a ejecutar.
   */
  run<T>(key: OperationKey, exec: () => Promise<T>): Promise<T> {
    const id = `${key.client}\n${key.operationId}`;
    const print = fingerprint(key.method, key.params);
    const now = this.now();

    const known = this.entries.get(id);
    if (known && known.expiresAt > now) {
      if (known.fingerprint !== print) {
        return Promise.reject(
          new ProtocolError(
            'INVALID_PARAMS',
            'operationId was already used for a different request.',
            {
              issues: [{ path: 'operationId', message: 'reused with a different request' }],
            },
          ),
        );
      }
      return known.outcome as Promise<T>;
    }

    this.evict(now);
    const outcome = exec();
    const entry: Entry = { fingerprint: print, outcome, expiresAt: now + this.ttlMs };
    this.entries.set(id, entry);
    outcome.catch((err: unknown) => {
      // Un fallo interno no es el resultado de la operación: se puede reintentar.
      if (!(err instanceof ProtocolError) && this.entries.get(id) === entry)
        this.entries.delete(id);
    });
    return outcome;
  }

  private evict(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
    // Sigue llena: fuera las más antiguas (el `Map` conserva el orden de inserción).
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
