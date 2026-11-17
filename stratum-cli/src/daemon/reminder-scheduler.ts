/**
 * M21 — planificador de los recordatorios del daemon (`docs/protocol.md` §30).
 *
 * Solo decide *cuándo* avisar y a quién se lo pasa: la entrega (la sesión del
 * `companion`, y los canales externos) la pone el daemon por constructor, así
 * que este módulo no importa nada de `daemon.ts`.
 *
 * Reglas que no se negocian:
 *  - **primero se publica, después se da por entregado**: un aviso no se puede
 *    perder porque no hubiera dónde publicarlo. Si `deliver` falla, sigue
 *    pendiente y se reintenta, espaciado (1 min, y luego cada 5), sin bucle;
 *  - si publicó pero no se pudo marcar en disco, no se repite **en este
 *    proceso** (queda anotado en memoria) y se registra sin el texto;
 *  - un aviso perdido (el daemon estaba apagado) sí se entrega al arrancar,
 *    marcado `late` contra la hora real de la entrega: un aviso que no llega es
 *    peor que uno tarde;
 *  - `setTimeout` no admite más de 2^31−1 ms: un vencimiento más lejano se arma
 *    por tramos, y cada tramo recalcula;
 *  - los timers no retienen el proceso (`unref`): el daemon se apaga solo
 *    cuando le toca;
 *  - el texto de un aviso es de la persona y **nunca** va a los logs.
 */
import { REMINDER_LIMITS, type ProtocolReminder } from '../protocol/index.js';
import { getLogger } from '../logging/index.js';
import type { NewReminder, ReminderStore } from '../reminders/store.js';
import { MAX_TIMER_MS } from './routine-scheduler.js';

const log = getLogger('daemon').child('reminders');

/** Espera del primer reintento tras una entrega fallida. */
export const RETRY_FIRST_MS = 60_000;
/** Espera de los reintentos siguientes: sin bucle apretado. */
export const RETRY_AFTER_MS = 5 * 60_000;

export interface ReminderSchedulerOptions {
  store: ReminderStore;
  /**
   * Publica el aviso donde lo tenga que ver la persona (la sesión principal del
   * `companion`, y los canales). Lanza si no pudo publicarlo: entonces el aviso
   * sigue pendiente y se reintenta.
   */
  deliver(reminder: ProtocolReminder): void | Promise<void>;
  /** El aviso ya publicado y marcado, para los canales externos (Telegram). */
  onDelivered?(reminder: ProtocolReminder): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Armed {
  handle: unknown;
  due: number;
}

function messageOf(err: unknown): string {
  // Solo el mensaje: nada de pila.
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

export class ReminderScheduler {
  private readonly store: ReminderStore;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private armed: Armed | null = null;
  /** Cuándo se puede reintentar una entrega que falló, y cuánto se espera después. */
  private retryAt: number | null = null;
  private retryDelay = RETRY_FIRST_MS;
  /** Publicados que no se pudieron marcar en disco: no se repiten en este proceso. */
  private readonly consumed = new Set<string>();
  /** Las entregas van en serie: nunca dos avisos a la vez ni uno repetido. */
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(private readonly opts: ReminderSchedulerOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Lee el almacén, entrega lo que ya venció y arma el siguiente. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.store.load();
    log.info('reminders loaded', {
      pending: this.store.pending().length,
      readOnly: this.store.readOnly,
    });
    this.pump();
  }

  /** Quita el timer. No cancela una entrega en vuelo. */
  stop(): void {
    this.stopped = true;
    this.disarm();
  }

  /** Tras crear o cancelar: el siguiente vencimiento cambia. Nunca lanza. */
  refresh(): void {
    if (!this.started || this.stopped) return;
    this.arm();
  }

  /** Hay algo pendiente (el daemon no se apaga solo mientras tanto). */
  get hasPending(): boolean {
    return this.nextPending() !== undefined;
  }

  /** El almacén no se puede modificar (fichero de un Stratum más nuevo o dañado). */
  get readOnly(): boolean {
    return this.store.readOnly;
  }

  /** Pendientes y terminados de la ventana, por `dueAt`. */
  list(now: number): ProtocolReminder[] {
    return this.store.list(now);
  }

  add(input: NewReminder, now: number): ProtocolReminder {
    const reminder = this.store.add(input, now);
    this.refresh();
    return reminder;
  }

  /** Cancelar solo resta; el planificador deja de contar con él. */
  cancel(id: string, now: number): ProtocolReminder {
    const reminder = this.store.cancel(id, now);
    this.refresh();
    return reminder;
  }

  // ─── internos ──────────────────────────────────────────────────────────────

  /** El siguiente que hay que entregar, saltando los que ya se dieron por entregados. */
  private nextPending(): ProtocolReminder | undefined {
    return this.store.pending().find((r) => !this.consumed.has(r.id));
  }

  private disarm(): void {
    if (!this.armed) return;
    const { handle } = this.armed;
    this.armed = null;
    this.clearTimer(handle);
  }

  /** Arma el siguiente vencimiento (o ninguno), en tramos. Nunca lanza. */
  private arm(): void {
    this.disarm();
    if (this.stopped) return;
    const due = this.nextPending()?.dueAt;
    if (due === undefined) return;
    const now = this.now();
    const waited = this.retryAt === null ? 0 : Math.max(0, this.retryAt - now);
    const delay = Math.min(Math.max(Math.max(0, due - now), waited), MAX_TIMER_MS);
    const handle = this.setTimer(() => this.onTimer(due), delay);
    (handle as { unref?: () => void } | null)?.unref?.();
    this.armed = { handle, due };
  }

  private onTimer(due: number): void {
    // Un timer que ya no es el vigente (re-armado o parado) no hace nada.
    if (!this.armed || this.armed.due !== due) return;
    this.armed = null;
    if (this.stopped) return;
    // Tramo intermedio de un vencimiento lejano (o timer adelantado): se recalcula.
    if (this.now() < due) {
      this.arm();
      return;
    }
    this.pump();
  }

  /** Entrega lo vencido en serie y, al terminar, arma el siguiente. Nunca lanza. */
  private pump(): void {
    this.queue = this.queue
      .then(async () => {
        if (this.stopped) return;
        await this.deliverDue();
        this.arm();
      })
      .catch((err: unknown) => {
        log.warn('reminder pump failed', { reason: messageOf(err) });
      });
  }

  private async deliverDue(): Promise<void> {
    for (const reminder of this.store.pending()) {
      if (this.stopped) return;
      if (this.consumed.has(reminder.id)) continue;
      if (reminder.dueAt > this.now()) continue;
      await this.deliverOne(reminder);
    }
  }

  /** Publica y **solo entonces** lo da por entregado. Nunca lanza. */
  private async deliverOne(reminder: ProtocolReminder): Promise<void> {
    // La hora real de la entrega: de ahí sale el `late`.
    const at = this.now();
    const late = at - reminder.dueAt > REMINDER_LIMITS.lateAfterMs;
    const delivered: ProtocolReminder = {
      ...reminder,
      status: 'delivered',
      endedAt: at,
      ...(late ? { late: true } : {}),
    };
    try {
      await this.opts.deliver(delivered);
    } catch (err) {
      // No salió: sigue pendiente y se reintenta, espaciado.
      this.retryAt = this.now() + this.retryDelay;
      this.retryDelay = RETRY_AFTER_MS;
      log.warn('reminder not delivered, it stays pending', {
        reminderId: reminder.id,
        reason: messageOf(err),
      });
      return;
    }
    this.retryAt = null;
    this.retryDelay = RETRY_FIRST_MS;
    try {
      this.store.markDelivered(reminder.id, at, late);
    } catch (err) {
      // Ya salió: aunque el disco no lo registre, en este proceso no se repite.
      this.consumed.add(reminder.id);
      log.error('reminder delivered but not marked as delivered', {
        reminderId: reminder.id,
        reason: messageOf(err),
      });
      return;
    }
    try {
      this.opts.onDelivered?.(delivered);
    } catch (err) {
      log.warn('reminder delivery hook failed', {
        reminderId: reminder.id,
        reason: messageOf(err),
      });
    }
  }
}
