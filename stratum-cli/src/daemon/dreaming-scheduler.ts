/**
 * M19 — pasada automática de dreaming (`memory.dreaming.schedule`).
 *
 * No es una rutina de M16: una pasada no es un run del agente, usa su propio
 * modelo con topes y solo propone. Reutiliza el horario de las rutinas
 * (`parseSchedule`/`nextFire`) y sus reglas:
 *  - nunca dos pasadas a la vez de una memoria (`skipped-busy`);
 *  - un vencimiento perdido (daemon parado, máquina dormida) no se recupera;
 *  - un fallo de una memoria no afecta a las otras ni lanza fuera de aquí;
 *  - nunca `force`: «nada nuevo» y el tope diario los decide `dream()`;
 *  - los timers no mantienen vivo al daemon (no cuenta en `isIdle`).
 * Los logs llevan recuentos, nunca texto de la memoria ni de las conversaciones.
 */
import { getLogger } from '../logging/index.js';
import { nextFire, parseSchedule, type Schedule } from '../routines/schedule.js';

const log = getLogger('daemon').child('dreaming-schedule');

export const DREAM_MISSED_GRACE_MS = 60_000;
export const DREAM_MAX_TIMER_MS = 2_147_483_647;

export type DreamAgent = 'companion' | 'assistant';
export type DreamFireOutcome = 'ran' | 'skipped-busy' | 'missed' | 'failed';

export interface DreamFire {
  agent: DreamAgent;
  at: number;
  outcome: DreamFireOutcome;
  /** Estado de la pasada si se llegó a hacer (`done`, `skipped`, `failed`). */
  status?: string;
  reason?: string;
  proposals?: number;
}

export interface DreamingSchedulerOptions {
  every: string;
  targets: readonly DreamAgent[];
  /** Lanza la pasada de esa memoria. Puede lanzar: aquí se contiene. */
  run(agent: DreamAgent): Promise<{ status: string; reason?: string; proposals: unknown[] }>;
  isRunning(agent: DreamAgent): boolean;
  onFire?(fire: DreamFire): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class DreamingScheduler {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly schedule: Schedule | null;
  private readonly anchor: Date;
  private handle: unknown = null;
  private due: number | null = null;
  private stopped = false;
  private readonly _error: string | null;
  private readonly firing = new Set<DreamAgent>();
  private last: DreamFire[] = [];

  constructor(private readonly opts: DreamingSchedulerOptions) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.anchor = new Date(this.now());
    const parsed = parseSchedule(opts.every);
    this.schedule = parsed.ok ? parsed.schedule : null;
    this._error = parsed.ok ? null : parsed.error;
  }

  /** Por qué no se arma (horario inválido), o `null`. */
  get error(): string | null {
    return this._error;
  }

  get nextFireAt(): number | null {
    return this.due;
  }

  get lastFires(): readonly DreamFire[] {
    return this.last;
  }

  start(): void {
    this.stopped = false;
    if (!this.schedule) {
      log.warn('dreaming schedule unusable, not armed', { reason: this._error });
      return;
    }
    this.arm();
    log.info('dreaming schedule armed', { targets: this.opts.targets.length });
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = null;
    this.due = null;
  }

  private arm(): void {
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = null;
    this.due = null;
    if (this.stopped || !this.schedule) return;
    const next = nextFire(this.schedule, new Date(this.now()), this.anchor);
    if (!next) return;
    const due = next.getTime();
    const delay = Math.min(Math.max(0, due - this.now()), DREAM_MAX_TIMER_MS);
    const handle = this.setTimer(() => this.onTimer(due), delay);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.handle = handle;
    this.due = due;
  }

  private onTimer(due: number): void {
    if (this.stopped || this.due !== due) return;
    this.handle = null;
    const now = this.now();
    if (now < due) {
      this.arm();
      return;
    }
    const missed = now - due > DREAM_MISSED_GRACE_MS;
    // El siguiente se arma antes de esperar a nada.
    this.arm();
    if (missed) {
      for (const agent of this.opts.targets) this.record({ agent, at: now, outcome: 'missed' });
      return;
    }
    void this.fireAll();
  }

  /** Pasa por cada memoria, una tras otra (no se compite por el mismo modelo). Nunca lanza. */
  async fireAll(): Promise<DreamFire[]> {
    const out: DreamFire[] = [];
    for (const agent of this.opts.targets) {
      if (this.stopped) break;
      out.push(await this.fire(agent));
    }
    return out;
  }

  private async fire(agent: DreamAgent): Promise<DreamFire> {
    const base = { agent, at: this.now() };
    if (this.firing.has(agent) || this.opts.isRunning(agent)) {
      return this.record({ ...base, outcome: 'skipped-busy' });
    }
    this.firing.add(agent);
    try {
      const result = await this.opts.run(agent);
      return this.record({
        ...base,
        outcome: 'ran',
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        proposals: result.proposals.length,
      });
    } catch (err) {
      log.warn('scheduled dreaming failed', {
        agent,
        err: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
      return this.record({ ...base, outcome: 'failed' });
    } finally {
      this.firing.delete(agent);
    }
  }

  private record(fire: DreamFire): DreamFire {
    this.last = [...this.last.filter((f) => f.agent !== fire.agent), fire];
    try {
      this.opts.onFire?.(fire);
    } catch (err) {
      log.warn('onFire handler failed', { err });
    }
    return fire;
  }
}
