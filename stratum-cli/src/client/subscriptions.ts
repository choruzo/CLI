/**
 * Suscripciones del cliente: qué se quiere seguir, por dónde iba cada una y
 * cómo se restablecen tras una reconexión. Es lo **único** que el cliente
 * repite solo al reconectar: suscribirse no cambia estado en el servidor.
 *
 * Reglas de entrega (ver `protocol/events.ts`):
 *  - un evento de estado con `seq` ya visto se descarta (entrega *at-least-once*);
 *  - un hueco de `seq` en una suscripción de sesión significa que se perdió
 *    algo: se pide una foto nueva y se ignora lo que llegue hasta recibirla;
 *  - una foto **sustituye**: desde ella se sigue por su `seq`;
 *  - los eventos volátiles no se reenvían ni se echan de menos.
 */
import {
  isStateEvent,
  type ProtocolEvent,
  type ProtocolOverviewSnapshot,
  type ProtocolSessionSnapshot,
  type ProtocolStateEvent,
  type SubscriptionScope,
} from '../protocol/index.js';
import type { ValidatedNotification } from '../ipc/codec.js';
import type { RpcPeer } from '../ipc/peer.js';

export interface SessionSubscriptionHandlers {
  /** Foto de la sesión: sustituye lo que se tuviera de ella. */
  onSnapshot: (snapshot: ProtocolSessionSnapshot) => void;
  /** Eventos posteriores a la última foto (o al último `seq` conocido), en orden. */
  onEvent: (event: ProtocolEvent) => void;
  /** No se pudo (re)suscribir: la sesión no existe, falta la capacidad… */
  onError?: (err: unknown) => void;
}

export interface OverviewSubscriptionHandlers {
  onOverview: (overview: ProtocolOverviewSnapshot) => void;
  onEvent: (event: ProtocolStateEvent) => void;
  onError?: (err: unknown) => void;
}

export interface TraceSubscriptionHandlers {
  /** `reset`: la traza empieza de cero; lo recibido antes se descarta. */
  onRecords: (records: Array<Record<string, unknown>>, reset: boolean, format: number) => void;
  onError?: (err: unknown) => void;
}

export interface Subscription {
  /** Deja de seguir. Idempotente. */
  close(): void;
}

type Entry =
  | {
      kind: 'session';
      sessionId: string;
      volatile: boolean;
      handlers: SessionSubscriptionHandlers;
      serverId: string | null;
      /** `null`: aún no hay foto ni evento del que partir. */
      lastSeq: number | null;
      /** Se pidió una foto: lo que llegue antes de ella se ignora. */
      awaitingSnapshot: boolean;
    }
  | {
      kind: 'overview';
      handlers: OverviewSubscriptionHandlers;
      serverId: string | null;
      seqBySession: Map<string, number>;
    }
  | {
      kind: 'trace';
      sessionId: string;
      handlers: TraceSubscriptionHandlers;
      serverId: string | null;
    };

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* un consumidor que lanza no puede romper el reparto */
  }
}

export class Subscriptions {
  private readonly entries = new Set<Entry>();
  private peer: RpcPeer | null = null;

  get size(): number {
    return this.entries.size;
  }

  subscribeSession(
    sessionId: string,
    handlers: SessionSubscriptionHandlers,
    options: { volatile?: boolean; sinceSeq?: number } = {},
  ): Subscription {
    return this.add({
      kind: 'session',
      sessionId,
      volatile: options.volatile ?? true,
      handlers,
      serverId: null,
      lastSeq: options.sinceSeq ?? null,
      awaitingSnapshot: false,
    });
  }

  subscribeOverview(handlers: OverviewSubscriptionHandlers): Subscription {
    return this.add({ kind: 'overview', handlers, serverId: null, seqBySession: new Map() });
  }

  subscribeTrace(sessionId: string, handlers: TraceSubscriptionHandlers): Subscription {
    return this.add({ kind: 'trace', sessionId, handlers, serverId: null });
  }

  private add(entry: Entry): Subscription {
    this.entries.add(entry);
    if (this.peer) void this.open(entry, this.peer);
    return {
      close: () => {
        if (!this.entries.delete(entry)) return;
        const peer = this.peer;
        const serverId = entry.serverId;
        entry.serverId = null;
        if (!peer || !serverId) return;
        const method = entry.kind === 'trace' ? 'trace.unsubscribe' : 'events.unsubscribe';
        void peer.request(method, { subscriptionId: serverId }).catch(() => undefined);
      },
    };
  }

  /** Hay conexión lista: se abren (o reabren) todas las suscripciones. */
  async attach(peer: RpcPeer): Promise<void> {
    this.peer = peer;
    await Promise.all([...this.entries].map((entry) => this.open(entry, peer)));
  }

  /** La conexión se perdió: los ids del servidor dejan de valer. Lo demás se conserva. */
  detach(): void {
    this.peer = null;
    for (const entry of this.entries) entry.serverId = null;
  }

  private async open(entry: Entry, peer: RpcPeer): Promise<void> {
    try {
      if (entry.kind === 'trace') {
        const { subscriptionId } = await peer.request('trace.subscribe', {
          sessionId: entry.sessionId,
        });
        this.bind(entry, peer, subscriptionId);
        return;
      }
      const scope: SubscriptionScope =
        entry.kind === 'overview'
          ? { kind: 'overview' }
          : {
              kind: 'session',
              sessionId: entry.sessionId,
              volatile: entry.volatile,
              // Sin `seq` conocido (o tras un hueco) se pide foto, no reenvío.
              ...(entry.lastSeq !== null && !entry.awaitingSnapshot
                ? { sinceSeq: entry.lastSeq }
                : {}),
            };
      const { subscriptionId, mode } = await peer.request('events.subscribe', { scope });
      if (entry.kind === 'session' && mode === 'snapshot') entry.awaitingSnapshot = true;
      this.bind(entry, peer, subscriptionId);
    } catch (err) {
      // Una conexión que cae a mitad no es un error de la suscripción: se
      // reabrirá en el siguiente `attach`.
      if (this.peer === peer && this.entries.has(entry)) {
        safely(() => entry.handlers.onError?.(err));
      }
    }
  }

  private bind(entry: Entry, peer: RpcPeer, serverId: string): void {
    // Se cerró o se reconectó mientras se esperaba la respuesta.
    if (this.peer !== peer || !this.entries.has(entry)) {
      const method = entry.kind === 'trace' ? 'trace.unsubscribe' : 'events.unsubscribe';
      void peer.request(method, { subscriptionId: serverId }).catch(() => undefined);
      return;
    }
    entry.serverId = serverId;
  }

  private find(serverId: string): Entry | undefined {
    for (const entry of this.entries) if (entry.serverId === serverId) return entry;
    return undefined;
  }

  /** Reparte una notificación. Devuelve `false` si no era de ninguna suscripción. */
  dispatch(notification: ValidatedNotification): boolean {
    if (notification.name === 'goodbye') return false;
    const entry = this.find(notification.params.subscriptionId);
    if (!entry) return false;

    switch (notification.name) {
      case 'snapshot':
        if (entry.kind !== 'session') return false;
        entry.lastSeq = notification.params.snapshot.seq;
        entry.awaitingSnapshot = false;
        safely(() => entry.handlers.onSnapshot(notification.params.snapshot));
        return true;
      case 'overview': {
        if (entry.kind !== 'overview') return false;
        const { overview } = notification.params;
        entry.seqBySession = new Map(overview.sessions.map((s) => [s.id, s.seq]));
        safely(() => entry.handlers.onOverview(overview));
        return true;
      }
      case 'trace.records': {
        if (entry.kind !== 'trace') return false;
        const { records, reset, format } = notification.params;
        safely(() => entry.handlers.onRecords(records, reset, format));
        return true;
      }
      case 'events':
        if (entry.kind === 'session') this.deliverSession(entry, notification.params.events);
        else if (entry.kind === 'overview') {
          this.deliverOverview(entry, notification.params.events);
        } else return false;
        return true;
    }
  }

  private deliverSession(
    entry: Extract<Entry, { kind: 'session' }>,
    events: ProtocolEvent[],
  ): void {
    for (const event of events) {
      if (entry.awaitingSnapshot) return;
      if (event.sessionId !== entry.sessionId) continue;
      if (!isStateEvent(event)) {
        // Un fragmento anterior a lo ya visto llega tarde: no aporta nada.
        if (entry.lastSeq !== null && event.after < entry.lastSeq) continue;
        safely(() => entry.handlers.onEvent(event));
        continue;
      }
      if (entry.lastSeq !== null) {
        if (event.seq <= entry.lastSeq) continue;
        if (event.seq > entry.lastSeq + 1) {
          this.resync(entry);
          return;
        }
      }
      entry.lastSeq = event.seq;
      safely(() => entry.handlers.onEvent(event));
    }
  }

  private deliverOverview(
    entry: Extract<Entry, { kind: 'overview' }>,
    events: ProtocolEvent[],
  ): void {
    for (const event of events) {
      if (!isStateEvent(event)) continue;
      // El resumen solo recibe algunos tipos: los huecos de `seq` son normales
      // aquí. Lo que sí vale es descartar lo ya visto.
      const last = entry.seqBySession.get(event.sessionId);
      if (last !== undefined && event.seq <= last) continue;
      if (event.type === 'session.closed') entry.seqBySession.delete(event.sessionId);
      else entry.seqBySession.set(event.sessionId, event.seq);
      safely(() => entry.handlers.onEvent(event));
    }
  }

  /** Se perdió algo: se cambia la suscripción por una nueva que empieza con foto. */
  private resync(entry: Extract<Entry, { kind: 'session' }>): void {
    const peer = this.peer;
    const stale = entry.serverId;
    entry.awaitingSnapshot = true;
    entry.serverId = null;
    if (!peer) return;
    if (stale)
      void peer.request('events.unsubscribe', { subscriptionId: stale }).catch(() => undefined);
    void this.open(entry, peer);
  }
}
