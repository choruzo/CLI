/**
 * Pausa cooperativa de un run (PRD de Stratum Dot, M5; §10.5).
 *
 * Pausar **no** congela nada: ni threads, ni procesos, ni jobs, ni sockets. Lo
 * único que hace es que el runtime no **empiece** trabajo nuevo del agente a
 * partir de un punto seguro. Lo que ya estaba en curso —una llamada al modelo,
 * una tool, un job en segundo plano— termina por su cuenta.
 *
 *   running ──requestPause()──▶ pause-requested ──(todos en punto seguro)──▶ paused
 *      ▲                              │                                        │
 *      └────────────── resume() ──────┴────────────────────────────────────────┘
 *
 *   cualquier estado ──end()──▶ idle        (el turno terminó, o se canceló)
 *
 * Una sola pieza y una sola autoridad por sesión (`StratumAgent.pause`): el
 * loop del agente principal, los de sus subagentes y el dispatcher consultan
 * **el mismo** controlador, así que una pausa del run alcanza a todos. No hay
 * otra implementación para el daemon ni para la CLI.
 *
 * `paused` no significa «se pidió»: significa que **ya no hay nada del agente
 * avanzando**. Cada loop se registra (`enter`) y el estado solo pasa a `paused`
 * cuando todos los que podrían empezar algo esperan en un punto seguro. Un loop
 * que aguarda a sus subagentes se aparta de la cuenta (`park`): los que cuentan
 * entonces son ellos.
 *
 * Cancelar es otro camino y siempre gana: la espera de un punto seguro termina
 * en cuanto se aborta la señal de quien espera, sin pasar por `resume`.
 *
 * Sin imports, a propósito: es una primitiva de runtime y no sabe de
 * anfitriones, protocolos ni terminales.
 */

export type PauseState = 'idle' | 'running' | 'pause-requested' | 'paused';

/**
 * Resultado de pedir una pausa. Pedirla dos veces no es un error:
 *  - `requested` — hay trabajo en curso; el run quedará en pausa en su
 *    siguiente punto seguro;
 *  - `already-requested` — ya estaba pedida y aún no se ha alcanzado;
 *  - `already-paused` — ya está en pausa;
 *  - `not-running` — no hay ningún run que pausar.
 */
export type PauseRequestStatus =
  | 'requested'
  | 'already-requested'
  | 'already-paused'
  | 'not-running';

/**
 * Resultado de reanudar:
 *  - `resumed` — estaba en pausa (o con la pausa pedida, que se retira) y sigue;
 *  - `not-paused` — hay un run, pero no estaba en pausa;
 *  - `not-running` — no hay ningún run.
 */
export type ResumeStatus = 'resumed' | 'not-paused' | 'not-running';

export type PauseListener = (state: PauseState, previous: PauseState) => void;

/** Lo que un punto seguro necesita del controlador. */
export interface SafePointGate {
  /** Hay una pausa pedida o vigente: quien llegue a un punto seguro debe esperar. */
  readonly pauseRequested: boolean;
  /**
   * Espera en un punto seguro mientras dure la pausa. Resuelve al reanudar, al
   * abortarse `signal` (cancelación) o al terminar el turno. Nunca rechaza. Sin
   * pausa pedida resuelve en el acto.
   */
  waitAtSafePoint(signal?: AbortSignal): Promise<void>;
}

/** Un loop registrado en el controlador. */
export interface PauseUnit {
  /**
   * El loop deja de poder empezar trabajo propio porque espera al de otros (sus
   * subagentes). Devuelve la función que lo reincorpora (idempotente).
   */
  park(): () => void;
  /** El loop terminó. Idempotente. */
  leave(): void;
}

export class PauseController implements SafePointGate {
  private current: PauseState = 'idle';
  /** Loops registrados y, de ellos, los apartados porque esperan a otros. */
  private active = 0;
  private parked = 0;
  /** Esperas abiertas en un punto seguro: una función que las suelta, por cada una. */
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<PauseListener>();

  get state(): PauseState {
    return this.current;
  }

  get pauseRequested(): boolean {
    return this.current === 'pause-requested' || this.current === 'paused';
  }

  /** Cuántos esperan ahora en un punto seguro (diagnóstico y tests). */
  get waiting(): number {
    return this.waiters.size;
  }

  /** Empieza un turno: desde aquí se puede pedir una pausa. */
  begin(): void {
    if (this.current === 'idle') this.set('running');
  }

  /**
   * El turno terminó —completo, cancelado o abandonado—. La pausa era suya y
   * se va con él: ninguna espera queda abierta y el siguiente turno empieza sin
   * pausa. Idempotente.
   */
  end(): void {
    if (this.current !== 'idle') this.set('idle');
    this.releaseAll();
  }

  requestPause(): PauseRequestStatus {
    switch (this.current) {
      case 'idle':
        return 'not-running';
      case 'pause-requested':
        return 'already-requested';
      case 'paused':
        return 'already-paused';
      case 'running':
        this.set('pause-requested');
        // Puede que ya estén todos parados (p. ej. nadie registrado todavía).
        this.settle();
        return 'requested';
    }
  }

  resume(): ResumeStatus {
    switch (this.current) {
      case 'idle':
        return 'not-running';
      case 'running':
        return 'not-paused';
      case 'pause-requested':
      case 'paused':
        // Primero el estado: quien despierte ya ve `running`.
        this.set('running');
        this.releaseAll();
        return 'resumed';
    }
  }

  waitAtSafePoint(signal?: AbortSignal): Promise<void> {
    if (!this.pauseRequested || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const release = (): void => {
        if (!this.waiters.delete(release)) return;
        signal?.removeEventListener('abort', release);
        resolve();
      };
      this.waiters.add(release);
      signal?.addEventListener('abort', release, { once: true });
      this.settle();
    });
  }

  enter(): PauseUnit {
    this.active++;
    let left = false;
    let parks = 0;
    return {
      park: () => {
        if (left) return () => undefined;
        let back = false;
        parks++;
        this.parked++;
        this.settle();
        return () => {
          if (back || left) return;
          back = true;
          parks--;
          this.parked--;
        };
      },
      leave: () => {
        if (left) return;
        left = true;
        this.active--;
        this.parked -= parks;
        parks = 0;
        // Quien se va puede ser el último que faltaba por pararse.
        this.settle();
      },
    };
  }

  /** Avisa de cada cambio de estado, de forma síncrona. Devuelve cómo darse de baja. */
  subscribe(listener: PauseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * ¿Se alcanzó la pausa? Solo si alguien espera en un punto seguro y no queda
   * ningún loop que pueda empezar algo.
   */
  private settle(): void {
    if (this.current !== 'pause-requested') return;
    if (this.waiters.size === 0) return;
    if (this.waiters.size < this.active - this.parked) return;
    this.set('paused');
  }

  private releaseAll(): void {
    for (const release of [...this.waiters]) release();
  }

  private set(next: PauseState): void {
    const previous = this.current;
    if (previous === next) return;
    this.current = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next, previous);
      } catch {
        /* quien escucha no puede romper el control del run */
      }
    }
  }
}

/**
 * Un plazo que no corre mientras el run está en pausa. Es el reloj del
 * presupuesto de un subagente: una pausa no caduca sola, así que tampoco puede
 * gastarle el tiempo a quien está esperando a que se retire. Solo se detiene en
 * `paused`; con la pausa pedida y trabajo aún en curso el tiempo sigue contando.
 *
 * `dispose()` suelta el temporizador y la suscripción; hay que llamarlo siempre.
 */
export function pausableTimeout(
  ms: number,
  pause?: PauseController,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let remaining = ms;
  let startedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const start = (): void => {
    if (timer !== null || controller.signal.aborted) return;
    startedAt = Date.now();
    timer = setTimeout(
      () => {
        timer = null;
        controller.abort();
      },
      Math.max(0, remaining),
    );
    // Como `AbortSignal.timeout`: el plazo no retiene el proceso.
    (timer as { unref?: () => void }).unref?.();
  };
  const stop = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - startedAt;
  };

  const unsubscribe = pause?.subscribe((state) => {
    if (state === 'paused') stop();
    else start();
  });
  if (pause?.state !== 'paused') start();

  return {
    signal: controller.signal,
    dispose: () => {
      unsubscribe?.();
      stop();
    },
  };
}
