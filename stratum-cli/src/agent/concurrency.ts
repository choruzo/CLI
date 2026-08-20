/**
 * Hito 8C — Primitivas de concurrencia (§12.16). Cero dependencias.
 *
 * `Semaphore` acota la ejecución paralela de subagentes a `agents.maxConcurrency`
 * (nunca más de N hijos vivos a la vez). `Mutex` serializa el acceso a los
 * recursos compartidos por un único dueño: la TTY del padre para las
 * confirmaciones destructivas (§Confirmaciones, nunca dos prompts a la vez) y el
 * store de memoria singleton (§12.7, escrituras `store_decision` serializadas).
 */

/**
 * Semáforo contador clásico. `acquire()` resuelve cuando hay un permiso libre;
 * el llamador debe invocar el `release` devuelto exactamente una vez.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  /** Adquiere un permiso. Devuelve la función de liberación (idempotente). */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // Al despertar ya se nos "cedió" el permiso (no se re-incrementó available).
    return this.makeRelease();
  }

  /** Ejecuta `fn` con un permiso adquirido, liberándolo pase lo que pase. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        // Ceder el permiso directamente al siguiente en cola (no toca available).
        next();
      } else {
        this.available++;
      }
    };
  }
}

/**
 * Mutex de exclusión mutua basado en cadena de promesas. Serializa secciones
 * críticas asíncronas preservando el orden FIFO de llegada.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Ejecuta `fn` en exclusión mutua. El orden de entrada se respeta (FIFO). */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Encadenamos sobre la cola actual; el nuevo `tail` no resuelve hasta que
    // esta sección crítica termina, forzando a la siguiente a esperar.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
