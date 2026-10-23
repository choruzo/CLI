/**
 * `trace.subscribe`: la traza de una sesión del daemon, retransmitida a un
 * cliente según se escribe.
 *
 *  - Se lee **siempre del fichero** (`~/.stratum/traces/<id>.jsonl`), que el
 *    runtime ya escribe redactado y recortado: aquí no se reconstruye nada ni se
 *    vuelve a redactar.
 *  - El primer `trace.records` de una suscripción lleva `reset: true` (aunque
 *    vaya vacío) y nunca sale antes de la respuesta de `subscribe`. Si el
 *    fichero se trunca o se sustituye, otra vez `reset: true` y desde el principio.
 *  - El fichero es el búfer: se lee por tramos (`READ_BYTES`) y solo mientras
 *    la salida del cliente admite datos, así que en memoria hay como mucho un
 *    tramo por suscripción, por grande que sea la traza. Nada se descarta por
 *    ir lento.
 *  - Una línea que no es un objeto JSON se salta; una mayor que el tope, también
 *    (no cabría en una trama). Los topes son de bytes, como el de la trama.
 */
import type { NotificationName, NotificationParams } from '../protocol/index.js';
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import { TRACE_FORMAT_VERSION } from '../trace/records.js';
import { FileTail } from '../trace/tail.js';

const log = getLogger('daemon').child('trace');

/** El extremo de un cliente, visto desde aquí. Lo implementa su conexión. */
export interface TraceClient {
  readonly id: number;
  ready(): boolean;
  notify<N extends NotificationName>(name: N, params: NotificationParams<N>): void;
}

export interface TraceFeedsOptions {
  /** Cada cuánto se mira si el fichero creció. */
  pollMs?: number;
  /** Suscripciones de traza por cliente. */
  maxSubscriptions?: number;
}

/** Registros por notificación y bytes de sus registros (la trama es de 1 MiB). */
const BATCH_RECORDS = 200;
const BATCH_BYTES = 512 * 1024;
/** Una línea mayor no cabría en una trama: se salta. */
const MAX_LINE_BYTES = 512 * 1024;
/** Lo que se lee del fichero de una vez. */
const READ_BYTES = 256 * 1024;

interface Feed {
  id: string;
  sessionId: string;
  client: TraceClient;
  tail: FileTail;
  /** Registros leídos y aún sin enviar, con su tamaño en bytes. */
  pending: Array<{ record: Record<string, unknown>; bytes: number }>;
  /** Hay un `tick` en curso: otro no lee ni envía el reset vacío. */
  busy: boolean;
  /** El siguiente envío empieza de cero. */
  reset: boolean;
  timer: ReturnType<typeof setInterval> | null;
  closed: boolean;
}

export class TraceFeeds {
  private readonly pollMs: number;
  private readonly maxSubscriptions: number;
  private readonly byClient = new Map<TraceClient, Map<string, Feed>>();
  private next = 1;

  constructor(opts: TraceFeedsOptions = {}) {
    this.pollMs = Math.max(10, opts.pollMs ?? 250);
    this.maxSubscriptions = opts.maxSubscriptions ?? 8;
  }

  /**
   * Abre una suscripción sobre `file`. La entrega empieza después de que salga
   * la respuesta (`setImmediate`).
   *
   * @throws ProtocolError `UNAVAILABLE` con demasiadas suscripciones.
   */
  subscribe(client: TraceClient, sessionId: string, file: string): { subscriptionId: string } {
    let feeds = this.byClient.get(client);
    if (!feeds) {
      feeds = new Map();
      this.byClient.set(client, feeds);
    }
    if (feeds.size >= this.maxSubscriptions) {
      throw new ProtocolError('UNAVAILABLE', 'Too many trace subscriptions on this connection.');
    }
    const feed: Feed = {
      id: `trace_${this.next++}`,
      sessionId,
      client,
      tail: new FileTail(
        file,
        (line) => this.onLine(feed, line),
        () => {
          // Truncado o sustituido: lo leído y sin enviar ya no vale.
          feed.pending = [];
          feed.reset = true;
        },
      ),
      pending: [],
      busy: false,
      reset: true,
      timer: null,
      closed: false,
    };
    feeds.set(feed.id, feed);
    setImmediate(() => {
      if (feed.closed) return;
      void this.tick(feed);
      feed.timer = setInterval(() => void this.tick(feed), this.pollMs);
      // Seguir una traza no mantiene vivo el proceso.
      feed.timer.unref?.();
    });
    return { subscriptionId: feed.id };
  }

  /** Repetirla, o con un id que no es de este cliente, no es un error. */
  unsubscribe(client: TraceClient, subscriptionId: string): void {
    const feeds = this.byClient.get(client);
    const feed = feeds?.get(subscriptionId);
    if (!feeds || !feed) return;
    this.stop(feed);
    feeds.delete(subscriptionId);
    if (feeds.size === 0) this.byClient.delete(client);
  }

  dropClient(client: TraceClient): void {
    const feeds = this.byClient.get(client);
    if (!feeds) return;
    for (const feed of feeds.values()) this.stop(feed);
    this.byClient.delete(client);
  }

  /** La salida del cliente vuelve a admitir datos. */
  pump(client: TraceClient): void {
    const feeds = this.byClient.get(client);
    if (!feeds) return;
    for (const feed of feeds.values()) void this.tick(feed);
  }

  closeAll(): void {
    for (const client of [...this.byClient.keys()]) this.dropClient(client);
  }

  subscriptions(client: TraceClient): number {
    return this.byClient.get(client)?.size ?? 0;
  }

  private stop(feed: Feed): void {
    feed.closed = true;
    if (feed.timer) clearInterval(feed.timer);
    feed.timer = null;
    feed.pending = [];
  }

  private onLine(feed: Feed, line: string): void {
    // Lo que ocupa la línea es lo que ocupará el registro serializado (o más:
    // un `é` del fichero sale como `é`).
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_LINE_BYTES) {
      log.warn('trace record too large, skipped', { sessionId: feed.sessionId, bytes });
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return; // una línea ilegible no es de la traza
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    feed.pending.push({ record: record as Record<string, unknown>, bytes });
  }

  /**
   * Envía lo pendiente y, mientras la salida admita más, lee del fichero por
   * tramos. Uno a la vez por suscripción: el temporizador y `pump` pueden
   * coincidir, y el segundo no debe tomar un sondeo ocupado por una traza vacía.
   */
  private async tick(feed: Feed): Promise<void> {
    if (feed.closed || feed.busy) return;
    feed.busy = true;
    try {
      for (;;) {
        this.flush(feed);
        if (feed.closed || !feed.client.ready() || feed.pending.length > 0) return;
        const read = await feed.tail.poll(READ_BYTES);
        if (feed.closed) return;
        if (!read) break;
      }
      // Una suscripción a una traza que aún no existe (o vacía) recibe su reset.
      if (feed.reset && feed.client.ready()) this.send(feed, []);
    } finally {
      feed.busy = false;
    }
  }

  private flush(feed: Feed): void {
    while (feed.pending.length > 0 && feed.client.ready()) {
      let count = 0;
      let bytes = 0;
      while (count < feed.pending.length && count < BATCH_RECORDS) {
        const size = feed.pending[count]!.bytes;
        if (count > 0 && bytes + size > BATCH_BYTES) break;
        bytes += size;
        count++;
      }
      this.send(
        feed,
        feed.pending.splice(0, count).map((p) => p.record),
      );
    }
  }

  private send(feed: Feed, records: Record<string, unknown>[]): void {
    const reset = feed.reset;
    feed.reset = false;
    feed.client.notify('trace.records', {
      subscriptionId: feed.id,
      sessionId: feed.sessionId,
      reset,
      format: TRACE_FORMAT_VERSION,
      records,
    });
  }
}
