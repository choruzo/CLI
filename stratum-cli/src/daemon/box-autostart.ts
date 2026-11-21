/**
 * M23 — la caja arranca con el daemon (`box.autostart`, solo de la config
 * global, apagado por defecto).
 *
 * Tras iniciar sesión, el daemon suele arrancar antes que el runtime de
 * contenedores (Docker Desktop tarda en levantar su servicio): sin runtime se
 * reintenta cada `retryMs` durante `windowMs`, y después se deja de intentar.
 * No sustituye a `box.start`: es el mismo `BoxManager.start()`, una vez.
 *
 * - Otra operación de la caja en curso (`BoxBusyError`): alguien ya la está
 *   arrancando o parando; no se insiste.
 * - El runtime rechaza una orden (`BoxCommandError`): no se reintenta. Repetir
 *   una orden que falla no la arregla, y `stratum doctor` lo cuenta.
 * - Nunca bloquea el arranque del daemon ni lo mantiene vivo (timers `unref`).
 *
 * No importa `daemon.ts`: la caja, el reloj y los timers entran por constructor.
 */
import { BoxBusyError, BoxUnavailableError, type BoxStatus } from '../box/manager.js';

export type BoxAutostartPhase =
  /** `box.autostart` apagado. */
  | 'off'
  /** Encendido, aún sin empezar (antes de `start()`). */
  | 'pending'
  /** Arrancando la caja (la primera vez puede construir la imagen). */
  | 'starting'
  /** Sin runtime de contenedores: se reintenta. */
  | 'waiting-runtime'
  | 'started'
  /** Otra operación de la caja estaba en curso: no se insistió. */
  | 'skipped-busy'
  /** Se rindió: sin runtime en toda la ventana, o el runtime rechazó una orden. */
  | 'failed';

export interface BoxAutostartState {
  phase: BoxAutostartPhase;
  /** Cuándo cambió por última vez (ms epoch), o `null` si nunca. */
  at: number | null;
  /** Con `failed` o `waiting-runtime`: por qué, para personas. */
  reason: string | null;
  attempts: number;
}

export interface BoxAutostartOptions {
  enabled: boolean;
  start: () => Promise<BoxStatus>;
  log: (event: string, data: Record<string, unknown>) => void;
  now?: () => number;
  /** Espera entre intentos sin runtime. Por defecto 30 s. */
  retryMs?: number;
  /** Cuánto se sigue intentando sin runtime desde el primer intento. Por defecto 10 min. */
  windowMs?: number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (t: unknown) => void;
}

export const BOX_AUTOSTART_RETRY_MS = 30_000;
export const BOX_AUTOSTART_WINDOW_MS = 10 * 60_000;

export class BoxAutostart {
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly windowMs: number;
  private current: BoxAutostartState;
  private firstAttemptAt: number | null = null;
  private timer: unknown = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: BoxAutostartOptions) {
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? BOX_AUTOSTART_RETRY_MS;
    this.windowMs = opts.windowMs ?? BOX_AUTOSTART_WINDOW_MS;
    this.current = {
      phase: opts.enabled ? 'pending' : 'off',
      at: null,
      reason: null,
      attempts: 0,
    };
  }

  state(): BoxAutostartState {
    return { ...this.current };
  }

  /** Lanza el primer intento sin esperarlo. Una sola vez. */
  start(): void {
    if (!this.opts.enabled || this.stopped || this.current.phase !== 'pending') return;
    this.attempt();
  }

  /** Deja de reintentar. Un arranque ya lanzado sigue (es una orden del runtime). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
      this.timer = null;
    }
  }

  /** Para tests: resuelve cuando termina el intento en curso. */
  idle(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private set(phase: BoxAutostartPhase, reason: string | null = null): void {
    this.current = { phase, at: this.now(), reason, attempts: this.current.attempts };
  }

  private attempt(): void {
    if (this.stopped) return;
    this.timer = null;
    this.firstAttemptAt ??= this.now();
    this.current = { ...this.current, attempts: this.current.attempts + 1 };
    this.set('starting');
    this.inFlight = this.opts
      .start()
      .then((status) => {
        if (status.state === 'running') {
          this.set('started');
          this.opts.log('box autostarted', { attempts: this.current.attempts });
        } else {
          // `start` contestó sin dejarla en marcha: no se adivina por qué.
          this.set('failed', `The box ended up ${status.state}.`);
          this.opts.log('box autostart failed', { state: status.state });
        }
      })
      .catch((err: unknown) => this.failed(err))
      .finally(() => {
        this.inFlight = null;
      });
  }

  private failed(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BoxBusyError) {
      this.set('skipped-busy', message);
      this.opts.log('box autostart skipped', { reason: 'busy' });
      return;
    }
    if (err instanceof BoxUnavailableError) {
      const elapsed = this.now() - (this.firstAttemptAt ?? this.now());
      if (!this.stopped && elapsed + this.retryMs <= this.windowMs) {
        this.set('waiting-runtime', message);
        const t = (this.opts.setTimer ?? setTimeout)(() => this.attempt(), this.retryMs);
        t.unref?.();
        this.timer = t;
        return;
      }
      this.set('failed', message);
      this.opts.log('box autostart gave up', {
        reason: 'no-runtime',
        attempts: this.current.attempts,
      });
      return;
    }
    this.set('failed', message);
    this.opts.log('box autostart failed', { reason: 'command' });
  }
}
