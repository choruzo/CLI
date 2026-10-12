/**
 * Reparto de eventos a los clientes: guarda, distribuye, filtra, reconstruye y
 * detecta huecos. **No numera**: el `seq` lo puso el anfitrión de cada sesión y
 * sale de aquí tal como entró. No hay ningún contador global.
 *
 *   publicador de la sesión → ingest() → cola por suscripción → cliente
 *
 * Dos carriles, con garantías distintas:
 *
 *  - **Estado** (`seq`). No se pierde en silencio. Se guardan los últimos
 *    `bufferSize` por sesión para reenviarlos tras una reconexión.
 *  - **Volátil** (`after`). El texto según se genera: se agrupa, se descarta
 *    para un cliente lento y no se reenvía.
 *
 * Un cliente lento nunca frena a nadie: `ingest()` solo encola. La cola de cada
 * suscripción está acotada, y al llenarse:
 *
 *  1. se descartan sus eventos volátiles;
 *  2. si aun así no cabe, la suscripción queda **desincronizada**: se vacía y,
 *     cuando el cliente vuelva a admitir datos, recibe un snapshot —que
 *     **sustituye** su estado— y sigue desde ahí.
 *
 * Nada se «fusiona como se pueda»: o el cliente tiene todos los eventos de
 * estado en orden, o tiene un snapshot.
 */
import {
  OVERVIEW_EVENT_TYPES,
  isStateEvent,
  type NotificationName,
  type NotificationParams,
  type ProtocolEvent,
  type ProtocolOverviewSnapshot,
  type ProtocolSessionSnapshot,
  type ProtocolStateEvent,
  type ProtocolVolatileEvent,
  type StateEventType,
  type SubscriptionScope,
} from '../protocol/index.js';
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('daemon').child('events');

/** El extremo de un cliente, visto desde el bus. Lo implementa su conexión. */
export interface HubClient {
  readonly id: number;
  /** ¿Admite más datos ahora? `false` mientras su salida esté llena. */
  ready(): boolean;
  /** Envía una notificación. No bloquea ni lanza. */
  notify<N extends NotificationName>(name: N, params: NotificationParams<N>): void;
}

export interface EventHubOptions {
  /** Eventos de estado que se conservan por sesión (`daemon.eventBuffer`). */
  bufferSize?: number;
  /** Eventos que puede acumular una suscripción antes de descartar. */
  maxQueue?: number;
  /** Eventos por notificación. */
  batchSize?: number;
  /** Suscripciones por cliente. */
  maxSubscriptions?: number;
  /** Foto actual de una sesión, o `null` si ya no existe. La da su anfitrión. */
  snapshotOf: (sessionId: string) => ProtocolSessionSnapshot | null;
  overviewOf: () => ProtocolOverviewSnapshot;
}

interface Channel {
  /** `seq` del último evento de estado recibido; `null` tras una pérdida del anfitrión. */
  lastSeq: number | null;
  buffer: ProtocolStateEvent[];
}

interface Subscription {
  id: string;
  client: HubClient;
  kind: 'session' | 'overview';
  sessionId: string | null;
  volatile: boolean;
  queue: ProtocolEvent[];
  /** Sesión: hasta qué `seq` está cubierto el cliente (por eventos o por un snapshot). */
  cursor: number;
  /** Desincronizada: lo siguiente que recibe es una foto. */
  needsSnapshot: boolean;
  /** La sesión terminó sin un evento de su anfitrión: esta foto es lo último que recibe. */
  final: ProtocolSessionSnapshot | null;
}

interface ClientState {
  subscriptions: Map<string, Subscription>;
  scheduled: boolean;
  volatileDropped: number;
  resyncs: number;
}

export interface HubClientStats {
  subscriptions: number;
  queued: number;
  /** Eventos volátiles descartados o agrupados para este cliente. */
  volatileDropped: number;
  /** Veces que se le forzó un snapshot por ir atrasado o por un hueco. */
  resyncs: number;
}

const OVERVIEW_TYPES: ReadonlySet<StateEventType> = new Set(OVERVIEW_EVENT_TYPES);
/** Tope del texto de un fragmento agrupado y del tamaño aproximado de una notificación. */
const DELTA_CHARS = 32_000;
const BATCH_CHARS = 256_000;

export class EventHub {
  private readonly bufferSize: number;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly maxSubscriptions: number;
  private readonly channels = new Map<string, Channel>();
  private readonly clients = new Map<HubClient, ClientState>();
  private nextSubscription = 1;

  constructor(private readonly opts: EventHubOptions) {
    this.bufferSize = Math.max(1, opts.bufferSize ?? 2000);
    this.maxQueue = Math.max(4, opts.maxQueue ?? 1024);
    this.batchSize = Math.max(1, opts.batchSize ?? 64);
    this.maxSubscriptions = opts.maxSubscriptions ?? 64;
  }

  // ---------------------------------------------------------------------------
  // Lado del anfitrión
  // ---------------------------------------------------------------------------

  /** `seq`: el del último evento de estado que ya ocurrió (una sesión par se registra en marcha). */
  openSession(sessionId: string, seq = 0): void {
    if (!this.channels.has(sessionId)) this.channels.set(sessionId, { lastSeq: seq, buffer: [] });
  }

  /**
   * La sesión dejó de existir y su anfitrión no lo contó con un evento (murió,
   * o se dio de baja). Nadie numera uno en su nombre: quien la seguía recibe
   * esta foto, que es la última, y quien sigue el conjunto, la foto de conjunto.
   */
  endSession(sessionId: string, final: ProtocolSessionSnapshot): void {
    this.channels.delete(sessionId);
    for (const [client, state] of this.clients) {
      for (const sub of state.subscriptions.values()) {
        if (sub.kind === 'session' && sub.sessionId === sessionId) {
          sub.queue = [];
          sub.final = final;
          sub.needsSnapshot = true;
        } else if (sub.kind === 'overview') {
          this.desync(sub, state, 'session-ended');
        } else continue;
        this.schedule(client);
      }
    }
  }

  /** La sesión terminó. Lo ya encolado para cada cliente se entrega igualmente. */
  closeSession(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.channels.has(sessionId);
  }

  /** `seq` del último evento de estado recibido de esa sesión. */
  lastSeq(sessionId: string): number | null {
    return this.channels.get(sessionId)?.lastSeq ?? null;
  }

  /**
   * Eventos de una sesión, en el orden y con el `seq` que les dio su anfitrión.
   * Solo guarda y encola: no espera a ningún cliente.
   */
  ingest(sessionId: string, events: readonly ProtocolEvent[]): void {
    const channel = this.channels.get(sessionId);
    if (!channel) return;
    for (const event of events) {
      if (event.sessionId !== sessionId) continue;
      if (!isStateEvent(event)) {
        this.distribute(sessionId, event);
        continue;
      }
      if (channel.lastSeq !== null) {
        if (event.seq <= channel.lastSeq) continue; // repetido
        if (event.seq !== channel.lastSeq + 1) {
          // Falta algo y no se puede inventar: quien siga la sesión resincroniza.
          log.warn('gap in session events, forcing resync', {
            sessionId,
            expected: channel.lastSeq + 1,
            received: event.seq,
          });
          this.resync(sessionId);
        }
      }
      channel.lastSeq = event.seq;
      channel.buffer.push(event);
      if (channel.buffer.length > this.bufferSize) {
        channel.buffer.splice(0, channel.buffer.length - this.bufferSize);
      }
      this.distribute(sessionId, event);
    }
  }

  /**
   * El anfitrión perdió eventos (su cola local se llenó): lo guardado ya no es
   * una secuencia completa. Se descarta, y todo el que siga la sesión recibe un
   * snapshot. Con `seq`, el del snapshot que lo sustituye: lo siguiente que se
   * espera es `seq + 1`.
   */
  resync(sessionId: string, seq?: number): void {
    const channel = this.channels.get(sessionId);
    if (channel) {
      channel.buffer = [];
      channel.lastSeq = seq ?? null;
    }
    for (const [client, state] of this.clients) {
      for (const sub of state.subscriptions.values()) {
        if (sub.kind === 'overview' || sub.sessionId === sessionId) {
          this.desync(sub, state, 'host-gap');
          this.schedule(client);
        }
      }
    }
  }

  private distribute(sessionId: string, event: ProtocolEvent): void {
    for (const [client, state] of this.clients) {
      for (const sub of state.subscriptions.values()) {
        if (sub.kind === 'session') {
          if (sub.sessionId !== sessionId) continue;
        } else if (!isStateEvent(event) || !OVERVIEW_TYPES.has(event.type)) continue;
        if (this.enqueue(sub, state, event)) this.schedule(client);
      }
    }
  }

  /** Devuelve `true` si hay algo nuevo que entregar. */
  private enqueue(sub: Subscription, state: ClientState, event: ProtocolEvent): boolean {
    // Lo que venga mientras espera una foto ya irá dentro de ella.
    if (sub.needsSnapshot) return false;
    if (isStateEvent(event)) {
      if (sub.kind === 'session') {
        if (event.seq <= sub.cursor) return false;
        sub.cursor = event.seq;
      }
      sub.queue.push(event);
    } else {
      if (!sub.volatile || event.after < sub.cursor) return false;
      if (!this.coalesce(sub, event)) sub.queue.push(event);
      else state.volatileDropped++;
    }
    if (sub.queue.length > this.maxQueue) this.shed(sub, state);
    return true;
  }

  /** Une un fragmento con el anterior si son del mismo bloque. */
  private coalesce(sub: Subscription, event: ProtocolVolatileEvent): boolean {
    const last = sub.queue[sub.queue.length - 1];
    if (
      !last ||
      isStateEvent(last) ||
      last.type !== event.type ||
      last.after !== event.after ||
      last.subagentId !== event.subagentId ||
      last.data.text.length + event.data.text.length > DELTA_CHARS
    ) {
      return false;
    }
    // Copia: el mismo evento está en las colas de otros clientes.
    sub.queue[sub.queue.length - 1] = {
      ...last,
      data: { text: last.data.text + event.data.text },
    } as ProtocolVolatileEvent;
    return true;
  }

  /** La cola se llenó: primero se pierde lo volátil; si no basta, se desincroniza. */
  private shed(sub: Subscription, state: ClientState): void {
    const before = sub.queue.length;
    sub.queue = sub.queue.filter(isStateEvent);
    const dropped = before - sub.queue.length;
    if (dropped > 0) {
      state.volatileDropped += dropped;
      log.debug('volatile events dropped for slow client', {
        connectionId: sub.client.id,
        subscriptionId: sub.id,
        dropped,
      });
    }
    if (sub.queue.length > this.maxQueue) this.desync(sub, state, 'slow-client');
  }

  private desync(sub: Subscription, state: ClientState, reason: string): void {
    sub.queue = [];
    if (sub.needsSnapshot) return;
    sub.needsSnapshot = true;
    state.resyncs++;
    log.info('subscription desynchronized, snapshot forced', {
      connectionId: sub.client.id,
      subscriptionId: sub.id,
      sessionId: sub.sessionId ?? undefined,
      reason,
    });
  }

  // ---------------------------------------------------------------------------
  // Lado del cliente
  // ---------------------------------------------------------------------------

  private stateOf(client: HubClient): ClientState {
    let state = this.clients.get(client);
    if (!state) {
      state = { subscriptions: new Map(), scheduled: false, volatileDropped: 0, resyncs: 0 };
      this.clients.set(client, state);
    }
    return state;
  }

  /**
   * Abre una suscripción. Lo primero que recibe el cliente llega **después** de
   * la respuesta de esta llamada (la entrega nunca es síncrona).
   *
   * @throws ProtocolError `NOT_FOUND` si la sesión no existe.
   */
  subscribe(
    client: HubClient,
    scope: SubscriptionScope,
  ): { subscriptionId: string; mode: 'replay' | 'snapshot' } {
    const state = this.stateOf(client);
    if (state.subscriptions.size >= this.maxSubscriptions) {
      throw new ProtocolError('UNAVAILABLE', 'Too many subscriptions on this connection.');
    }
    const sub: Subscription = {
      id: `sub_${this.nextSubscription++}`,
      client,
      kind: scope.kind,
      sessionId: scope.kind === 'session' ? scope.sessionId : null,
      volatile: scope.kind === 'session' ? scope.volatile !== false : false,
      queue: [],
      cursor: 0,
      needsSnapshot: true,
      final: null,
    };
    let mode: 'replay' | 'snapshot' = 'snapshot';

    if (scope.kind === 'session') {
      const channel = this.channels.get(scope.sessionId);
      if (!channel) throw new ProtocolError('NOT_FOUND', 'Session not found.');
      const since = scope.sinceSeq;
      if (since !== undefined && channel.lastSeq !== null && since <= channel.lastSeq) {
        // ¿Está en el buffer todo lo posterior a `since`?
        const oldest = channel.buffer[0]?.seq ?? channel.lastSeq + 1;
        const missing = channel.lastSeq - since;
        if (since >= oldest - 1 && missing <= this.maxQueue) {
          sub.queue = channel.buffer.filter((e) => e.seq > since);
          sub.cursor = channel.lastSeq;
          sub.needsSnapshot = false;
          mode = 'replay';
        }
      }
    }
    state.subscriptions.set(sub.id, sub);
    this.schedule(client);
    return { subscriptionId: sub.id, mode };
  }

  unsubscribe(client: HubClient, subscriptionId: string): boolean {
    return this.clients.get(client)?.subscriptions.delete(subscriptionId) ?? false;
  }

  /** La conexión terminó: se olvida todo lo suyo. */
  dropClient(client: HubClient): void {
    this.clients.delete(client);
  }

  stats(client: HubClient): HubClientStats {
    const state = this.clients.get(client);
    let queued = 0;
    for (const sub of state?.subscriptions.values() ?? []) queued += sub.queue.length;
    return {
      subscriptions: state?.subscriptions.size ?? 0,
      queued,
      volatileDropped: state?.volatileDropped ?? 0,
      resyncs: state?.resyncs ?? 0,
    };
  }

  /** La salida del cliente vuelve a admitir datos (`drain`). */
  pump(client: HubClient): void {
    if (this.clients.has(client)) this.schedule(client);
  }

  private schedule(client: HubClient): void {
    const state = this.clients.get(client);
    if (!state || state.scheduled) return;
    state.scheduled = true;
    setImmediate(() => {
      state.scheduled = false;
      if (this.clients.get(client) === state) this.flush(client, state);
    });
  }

  /** Entrega ya lo pendiente de todos (apagado). No espera a que nadie pueda recibirlo. */
  flushAll(): void {
    for (const [client, state] of this.clients) this.flush(client, state, true);
  }

  private flush(client: HubClient, state: ClientState, force = false): void {
    for (const sub of state.subscriptions.values()) {
      while (force || client.ready()) {
        if (sub.needsSnapshot) {
          sub.needsSnapshot = false;
          if (!this.sendSnapshot(sub)) break;
          continue;
        }
        if (sub.queue.length === 0) break;
        const events: ProtocolEvent[] = [];
        let chars = 0;
        while (sub.queue.length > 0 && events.length < this.batchSize && chars < BATCH_CHARS) {
          const event = sub.queue.shift()!;
          chars += JSON.stringify(event).length;
          events.push(event);
        }
        client.notify('events', { subscriptionId: sub.id, events });
      }
    }
  }

  /** `false` si no había nada que fotografiar (la sesión ya no existe). */
  private sendSnapshot(sub: Subscription): boolean {
    if (sub.kind === 'overview') {
      sub.client.notify('overview', { subscriptionId: sub.id, overview: this.opts.overviewOf() });
      return true;
    }
    if (sub.final) {
      const final = sub.final;
      sub.final = null;
      sub.queue = [];
      sub.client.notify('snapshot', { subscriptionId: sub.id, snapshot: final });
      return false;
    }
    const snapshot = this.opts.snapshotOf(sub.sessionId!);
    if (!snapshot) return false;
    // La foto cubre hasta su `seq`: lo anterior que quedase en cola sobra, y lo
    // que el anfitrión ya contó pero aún no ha llegado aquí se saltará al llegar.
    sub.cursor = snapshot.seq;
    sub.queue = sub.queue.filter((e) =>
      isStateEvent(e) ? e.seq > snapshot.seq : e.after >= snapshot.seq,
    );
    sub.client.notify('snapshot', { subscriptionId: sub.id, snapshot });
    return true;
  }
}
