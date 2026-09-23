/**
 * Límite de generaciones simultáneas entre conversaciones (D4, 15.15).
 *
 * Cada conversación tiene su `StratumAgent` y su router, pero todas comparten
 * el provider: con un llama.cpp local de un solo slot, dos generaciones a la vez
 * van a la mitad de velocidad cada una, y un provider remoto puede responder
 * con rate limit. Pasado `desktop.maxConcurrentTurns`, los turnos esperan en una
 * cola FIFO; la UI los muestra «En cola» y se pueden cancelar mientras esperan.
 */

export const DEFAULT_MAX_CONCURRENT_TURNS = 2;

export interface TurnTicket {
  /** Se resuelve cuando el turno puede empezar. Rechaza si se canceló en cola. */
  ready: Promise<void>;
  /** Libera el hueco (o sale de la cola). Idempotente. */
  release: () => void;
  /** Posición en la cola al pedirlo: 0 si arranca ya. */
  position: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  onPosition?: (position: number) => void;
}

export class TurnCancelledInQueue extends Error {
  constructor() {
    super('turno cancelado mientras esperaba en cola');
    this.name = 'TurnCancelledInQueue';
  }
}

export class TurnScheduler {
  private running = 0;
  private readonly queue: Waiter[] = [];

  private max: number;

  constructor(limit: number = DEFAULT_MAX_CONCURRENT_TURNS) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit debe ser un entero ≥ 1');
    this.max = limit;
  }

  get limit(): number {
    return this.max;
  }

  /**
   * Nuevo límite desde Ajustes (D5). Subirlo arranca ya los que esperaban;
   * bajarlo no corta los que están en marcha, solo retrasa a los siguientes.
   */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit debe ser un entero ≥ 1');
    this.max = limit;
    this.next();
  }

  get active(): number {
    return this.running;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Pide un hueco. `signal` cancela la espera (no el turno ya en marcha);
   * `onPosition` avisa cuando la cola avanza.
   */
  acquire(signal?: AbortSignal, onPosition?: (position: number) => void): TurnTicket {
    let released = false;
    let started = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (started) {
        this.running--;
        this.next();
      } else {
        const i = this.queue.indexOf(waiter);
        if (i !== -1) {
          this.queue.splice(i, 1);
          waiter.reject(new TurnCancelledInQueue());
          this.announce();
        }
      }
    };
    let waiter!: Waiter;
    const ready = new Promise<void>((resolve, reject) => {
      waiter = {
        resolve: () => {
          started = true;
          resolve();
        },
        reject,
        onPosition,
      };
    });
    // Sin nadie esperando la promesa, un rechazo no debe tumbar el proceso.
    ready.catch(() => undefined);

    if (signal?.aborted) {
      released = true;
      waiter.reject(new TurnCancelledInQueue());
      return { ready, release, position: 0 };
    }
    if (this.running < this.limit && this.queue.length === 0) {
      this.running++;
      waiter.resolve();
      return { ready, release, position: 0 };
    }
    this.queue.push(waiter);
    // Cancelar solo saca de la cola: un turno ya en marcha libera su hueco al
    // terminar de verdad, no al pedir la cancelación.
    signal?.addEventListener('abort', () => !started && release(), { once: true });
    return { ready, release, position: this.queue.length };
  }

  private next(): void {
    while (this.running < this.limit && this.queue.length > 0) {
      const w = this.queue.shift()!;
      this.running++;
      w.resolve();
    }
    this.announce();
  }

  private announce(): void {
    this.queue.forEach((w, i) => w.onPosition?.(i + 1));
  }
}
