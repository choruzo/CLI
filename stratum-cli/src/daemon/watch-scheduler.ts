/**
 * M22 — planificador de los vigilantes del daemon (PRD de Dot §23.11, M22
 * parte 1). Hermano del `RoutineScheduler` y del `ReminderScheduler`: no
 * importa `daemon.ts`. El almacén, la sonda (`watches/probe.ts`), la entrega del
 * aviso, el reloj y los timers entran por constructor.
 *
 * Reglas:
 *  - evalúa **sin el LLM**: cada `tickMs` mira qué vigilantes activos tocan, los
 *    agrupa por conector (una conexión por conector y ciclo) y pasa cada
 *    resultado por la máquina de estados (`watches/engine.ts`);
 *  - un ciclo a la vez: si uno se alarga, el siguiente espera;
 *  - el estado se guarda solo cuando cambia; con el almacén en solo lectura
 *    (fichero de un Stratum más nuevo o dañado) **no se evalúa nada**, porque
 *    sin poder guardar el estado se repetirían los avisos;
 *  - al arrancar, lo ocurrido con el daemon apagado no se recupera
 *    (`stateAfterRestart`): la primera evaluación compara con lo guardado;
 *  - un fallo al entregar un aviso se registra y no se reintenta: el estado ya
 *    cambió y la siguiente transición avisará;
 *  - el nombre y los argumentos de un vigilante **no** van a los logs;
 *  - los timers no retienen el proceso (`unref`).
 */
import type { ProtocolWatchNotice } from '../protocol/index.js';
import { getLogger } from '../logging/index.js';
import { stateAfterRestart, stepWatch, type WatchInput } from '../watches/engine.js';
import { watchNoticeText } from '../watches/notice.js';
import type { ProbeOutcome, WatchProbe } from '../watches/probe.js';
import type { WatchDefinition } from '../watches/define.js';
import type { StoredWatch, WatchStatus, WatchStore } from '../watches/store.js';

const log = getLogger('daemon').child('watches');

/** Cada cuánto se mira qué vigilantes tocan. */
export const WATCH_TICK_MS = 15_000;
/** Margen para que un vigilante de 60 s no se salte un ciclo por milisegundos. */
const DUE_SLACK_MS = 1_000;
/** Plazo de un ciclo entero por conector. */
const PROBE_DEADLINE_MS = 120_000;

export interface WatchSchedulerOptions {
  store: WatchStore;
  probe: WatchProbe;
  /** Publica el aviso (la sesión del `companion` y los canales). Puede lanzar. */
  notify(notice: ProtocolWatchNotice): void | Promise<void>;
  now?: () => number;
  tickMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/** Lo que dio la sonda para la llamada `i`. Sin resultado para ella, un fallo. */
function inputOf(outcome: ProbeOutcome, i: number): WatchInput {
  if (outcome.kind === 'suspended') return { kind: 'suspended', reason: outcome.reason };
  const r = outcome.outcomes[i];
  if (!r) return { kind: 'failure', reason: 'the check returned no result' };
  return r.ok ? { kind: 'result', result: r.result } : { kind: 'failure', reason: r.reason };
}

export class WatchScheduler {
  private readonly store: WatchStore;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  /** Cuándo se evaluó por última vez cada vigilante (solo en memoria). */
  private readonly checkedAt = new Map<string, number>();
  private cycle: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private started = false;
  private stopped = false;
  private readOnlyLogged = false;

  constructor(private readonly opts: WatchSchedulerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? WATCH_TICK_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Lee el almacén, olvida lo que pasó con el daemon apagado y lanza el primer ciclo. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.store.load();
    if (!this.store.readOnly) {
      for (const w of this.store.list()) {
        try {
          this.store.saveState(w.id, stateAfterRestart(w.state));
        } catch (err) {
          log.warn('watch state not reset after restart', {
            watchId: w.id,
            reason: messageOf(err),
          });
        }
      }
    }
    log.info('watches loaded', {
      watches: this.store.list().length,
      active: this.activeCount(),
      readOnly: this.store.readOnly,
    });
    this.arm(0);
  }

  /** Quita el timer y corta el ciclo en curso. */
  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** Hay vigilantes activos (el daemon no se apaga solo mientras tanto). */
  get hasActive(): boolean {
    return !this.store.readOnly && this.activeCount() > 0;
  }

  get readOnly(): boolean {
    return this.store.readOnly;
  }

  list(): StoredWatch[] {
    return this.store.list();
  }

  /** Un vigilante ya validado (`defineWatch`). Se evalúa en el siguiente ciclo. */
  add(def: WatchDefinition): StoredWatch {
    const watch = this.store.add(def, this.now());
    this.kick();
    return watch;
  }

  setStatus(id: string, status: WatchStatus): StoredWatch {
    const watch = this.store.setStatus(id, status);
    this.checkedAt.delete(id);
    if (status === 'active') this.kick();
    return watch;
  }

  remove(id: string): StoredWatch {
    const watch = this.store.remove(id);
    this.checkedAt.delete(id);
    return watch;
  }

  /** Espera al ciclo en curso (tests y apagado). */
  async idle(): Promise<void> {
    await this.cycle;
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  private activeCount(): number {
    return this.store.list().filter((w) => w.status === 'active').length;
  }

  private arm(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    const handle = this.setTimer(() => {
      this.timer = null;
      this.tick();
    }, ms);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.timer = handle;
  }

  /** Adelanta el siguiente ciclo (tras crear o reanudar), si no hay uno en curso. */
  private kick(): void {
    if (!this.started || this.stopped || this.cycle) return;
    this.arm(0);
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.cycle) {
      this.arm(this.tickMs);
      return;
    }
    this.cycle = this.runCycle()
      .catch((err: unknown) => log.warn('watch cycle failed', { reason: messageOf(err) }))
      .finally(() => {
        this.cycle = null;
        this.arm(this.tickMs);
      });
  }

  private due(now: number): StoredWatch[] {
    return this.store.list().filter((w) => {
      if (w.status !== 'active') return false;
      const last = this.checkedAt.get(w.id);
      return last === undefined || now - last >= w.intervalSec * 1000 - DUE_SLACK_MS;
    });
  }

  private async runCycle(): Promise<void> {
    if (this.store.readOnly) {
      if (!this.readOnlyLogged) {
        this.readOnlyLogged = true;
        log.warn('watches file cannot be modified; no watch is evaluated', {
          problem: this.store.loadProblem,
        });
      }
      return;
    }
    const due = this.due(this.now());
    if (due.length === 0) return;
    const byConnector = new Map<string, StoredWatch[]>();
    for (const w of due) {
      const group = byConnector.get(w.connector) ?? [];
      group.push(w);
      byConnector.set(w.connector, group);
    }
    for (const [connector, watches] of byConnector) {
      if (this.stopped) return;
      const at = this.now();
      for (const w of watches) this.checkedAt.set(w.id, at);
      const outcome = await this.probe(connector, watches);
      if (this.stopped) return;
      for (let i = 0; i < watches.length; i++) {
        await this.apply(watches[i]!.id, inputOf(outcome, i));
      }
    }
  }

  private async probe(connector: string, watches: StoredWatch[]): Promise<ProbeOutcome> {
    const abort = new AbortController();
    this.abort = abort;
    const deadline = setTimeout(() => abort.abort(), PROBE_DEADLINE_MS);
    deadline.unref?.();
    try {
      return await this.opts.probe.run(
        connector,
        watches.map((w) => ({ tool: w.check, args: w.args })),
        abort.signal,
      );
    } catch (err) {
      // No se pudo conectar: un fallo de cada comprobación, nunca un estado.
      const reason = messageOf(err);
      return { kind: 'ran', outcomes: watches.map(() => ({ ok: false as const, reason })) };
    } finally {
      clearTimeout(deadline);
      if (this.abort === abort) this.abort = null;
    }
  }

  /** Un paso de la máquina de estados: guarda y, si toca, avisa. Nunca lanza. */
  private async apply(id: string, input: WatchInput): Promise<void> {
    // Releído: se pudo pausar o borrar mientras se miraba.
    const watch = this.store.get(id);
    if (!watch || watch.status !== 'active') return;
    const now = this.now();
    const step = stepWatch(watch, watch.state, input, now);
    try {
      this.store.saveState(id, step.state);
    } catch (err) {
      // Sin guardar el estado, avisar ahora repetiría el aviso en el siguiente ciclo.
      log.error('watch state not saved; notice skipped', { watchId: id, reason: messageOf(err) });
      return;
    }
    if (!step.notice) return;
    const notice: ProtocolWatchNotice = {
      watchId: id,
      name: watch.name,
      kind: step.notice,
      text: watchNoticeText({
        kind: step.notice,
        name: watch.name,
        condition: watch.condition,
        ...(input.kind === 'result' ? { result: input.result } : { reason: input.reason }),
      }),
      at: now,
    };
    log.info('watch notice', { watchId: id, kind: notice.kind, connector: watch.connector });
    try {
      await this.opts.notify(notice);
    } catch (err) {
      log.warn('watch notice not delivered', { watchId: id, reason: messageOf(err) });
    }
  }
}
