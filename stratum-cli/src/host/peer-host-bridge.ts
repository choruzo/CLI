/**
 * Puente de un anfitrión par: publica en `stratumd` una sesión que **vive en
 * este proceso** y atiende las órdenes de control que el daemon le reenvía.
 *
 *   sesión → SessionPublisher → [este puente] → host.publish → stratumd
 *                                             ← host.cancel / host.steer
 *                                             ← host.pause / host.resume
 *
 * El puente es transporte y nada más:
 *
 *  - **No es dueño del runtime.** Nunca desmonta la sesión ni la detiene: si el
 *    daemon desaparece, la sesión sigue igual y el puente vuelve a intentarlo.
 *  - **No guarda estado de la sesión.** Lo único suyo es la conexión, la cola
 *    de salida y lo necesario para reclamar la sesión al reconectar. El estado
 *    está en el `SessionPublisher` —el mismo que usa una sesión del daemon—, y
 *    el `seq` es el suyo.
 *  - **Publicar es opcional.** Sin daemon, con uno incompatible, con el token
 *    rechazado o con cualquier error del protocolo, la sesión funciona como si
 *    el puente no existiera. Ningún método de aquí lanza.
 *  - **Nunca reenvía historia.** Lo que no se pudo enviar se sustituye por una
 *    foto (`publisher.snapshot()`), que es la autoridad.
 */
import { StratumClient, ServerUnavailableError } from '../client/client.js';
import type { Connector } from '../client/connection.js';
import { fileDiscovery, type Discovery } from '../client/discovery.js';
import { ProtocolMismatchError } from '../client/handshake.js';
import { createBackoff, type BackoffOptions } from '../client/reconnect.js';
import { ProtocolError } from '../ipc/codec.js';
import type { RequestHandlers } from '../ipc/peer.js';
import { getLogger } from '../logging/index.js';
import {
  FEATURE_REMOTE_APPROVALS,
  isStateEvent,
  type PauseStatus,
  type ProtocolEvent,
  type ProtocolResolver,
  type ProtocolRun,
  type ResumeStatus,
  type StateEventData,
  type SteerStatus,
} from '../protocol/index.js';
import type { PendingInteractions, RemoteResolver } from './interactions.js';
import {
  SessionPublisher,
  type PublishedSession,
  type PublisherSink,
} from './session-publisher.js';

const log = getLogger('host').child('bridge');

/** Lo que el daemon puede pedirle a la sesión. Lo decide el runtime, no el puente. */
export interface PeerHostControl {
  /** Cancela el turno en curso. */
  cancel(): void;
  /** Mensaje del usuario con el turno en curso (Runtime Inbox). */
  steer(text: string): { status: SteerStatus };
  /**
   * Pausa cooperativa del turno en curso, y su retirada. La decide el runtime
   * (`StratumAgent.pause`): el puente no guarda ni publica ningún estado de
   * pausa por su cuenta — el que haya lo cuenta el `SessionPublisher`.
   */
  pause(): PauseStatus;
  resume(): ResumeStatus;
}

export interface PeerHostBridgeOptions {
  session: PublishedSession;
  control: PeerHostControl;
  /** Nombre con el que este proceso se presenta (`stratum run`, `stratum chat`). */
  name: string;
  version: string;
  discovery?: Discovery;
  connector?: Connector;
  /**
   * Arranca el daemon si no hay ninguno (`daemon.autoStart`). Se llama **una**
   * vez, en el primer intento; lo que tarde está acotado por `start()`.
   */
  autoStart?: () => Promise<void>;
  /** Espera entre intentos de conexión. */
  retry?: BackoffOptions;
  /** Eventos que esperan a salir antes de sustituirlos por una foto. */
  maxQueue?: number;
  requestTimeoutMs?: number;
  pid?: number;
}

/** Tras tantos rechazos seguidos del daemon, se deja de insistir. */
const MAX_REJECTIONS = 6;
const BATCH_EVENTS = 128;
const BATCH_CHARS = 256_000;

function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    // Esperar al daemon nunca retiene el proceso.
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Del `by` que manda el daemon solo se toma quién fue: que es remoto lo dice el camino. */
function remoteResolver(by: ProtocolResolver): RemoteResolver {
  return {
    ...(by.client ? { client: by.client } : {}),
    ...(by.connectionId !== undefined ? { connectionId: by.connectionId } : {}),
  };
}

export class PeerHostBridge implements PublisherSink {
  /** El publicador de la sesión: la misma pieza que usa una sesión del daemon. */
  readonly publisher: SessionPublisher;

  private readonly lifetime = new AbortController();
  private readonly maxQueue: number;
  private readonly requestTimeoutMs: number;
  /** Conexión con la sesión ya registrada, o `null`. */
  private client: StratumClient | null = null;
  /** El daemon al que se está conectado acredita aprobadores. */
  private approvers = false;
  /** Se registró (o se está registrando): los eventos se encolan desde la foto enviada. */
  private attached = false;
  /** Para reclamar la sesión si el daemon la conserva tras una desconexión. */
  private claim: string | null = null;
  private queue: ProtocolEvent[] = [];
  /** `seq` de la última foto enviada: lo anterior ya va dentro de ella. */
  private baseSeq = 0;
  private needSnapshot = false;
  private sendTask: Promise<void> | null = null;
  private rejections = 0;
  private autoStartPending: boolean;
  private started = false;
  private closed = false;
  private wakeDetached: (() => void) | null = null;

  constructor(private readonly opts: PeerHostBridgeOptions) {
    this.maxQueue = Math.max(16, opts.maxQueue ?? 2048);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.autoStartPending = opts.autoStart !== undefined;
    this.publisher = new SessionPublisher({
      host: opts.session,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink: this,
    });
  }

  get sessionId(): string {
    return this.opts.session.sessionId;
  }

  /** ¿Está la sesión registrada ahora mismo en un daemon? */
  get connected(): boolean {
    return this.client !== null;
  }

  /**
   * ¿Puede ahora un cliente remoto resolver lo que esta sesión pida? Solo con
   * la sesión registrada en un daemon que acredita aprobadores. Es lo que
   * decide si una sesión sin terminal pregunta o deniega.
   */
  get remoteApprovals(): boolean {
    return this.client !== null && this.approvers;
  }

  /**
   * Empieza a publicar. Espera, como mucho `waitMs`, a que el primer intento de
   * conexión termine (para que la sesión se vea desde su primer evento), y en
   * cualquier caso devuelve: si no hay daemon o tarda, se sigue intentando en
   * segundo plano. `true` si la sesión quedó registrada.
   */
  async start(waitMs = this.opts.autoStart ? 8_000 : 1_500): Promise<boolean> {
    if (this.started || this.closed) return this.connected;
    this.started = true;
    let first!: () => void;
    const firstAttempt = new Promise<void>((resolve) => (first = resolve));
    void this.loop(first);
    await Promise.race([firstAttempt, pause(waitMs, this.lifetime.signal)]);
    // A partir de aquí el publicador numera y observa: con daemon o sin él.
    this.publisher.start();
    return this.connected;
  }

  /** Datos del próximo run que `observe()` no trae (ver `SessionPublisher.expectRun`). */
  expectRun(next: { mode?: ProtocolRun['mode']; input?: string }): void {
    this.publisher.expectRun(next);
  }

  /** Algo del resumen cambió fuera de un turno (modelo, perfil, read-only). */
  sessionChanged(): void {
    this.publisher.sessionChanged();
  }

  // ---------------------------------------------------------------------------
  // Conexión
  // ---------------------------------------------------------------------------

  private async loop(first: () => void): Promise<void> {
    const backoff = createBackoff({ initialMs: 500, maxMs: 5_000, ...this.opts.retry });
    const signal = this.lifetime.signal;
    for (let failures = 0; !signal.aborted; ) {
      const link = await this.attach();
      first();
      if (link) {
        failures = 0;
        await link.ended;
        if (!signal.aborted) log.debug('detached from daemon', { sessionId: this.sessionId });
      } else {
        failures++;
      }
      if (this.rejections >= MAX_REJECTIONS) {
        log.info('daemon keeps rejecting this session, publishing disabled', {
          sessionId: this.sessionId,
        });
        return;
      }
      const delay = backoff.delay(Math.max(1, failures));
      if (delay === null || !(await pause(delay, signal))) return;
    }
  }

  /**
   * Un intento: conectar, presentarse como anfitrión y registrar la sesión con
   * su foto actual. Devuelve `ended`, que se resuelve cuando esa conexión
   * termina, o `null` si no llegó a establecerse. (Dentro de un objeto: una
   * promesa devuelta tal cual se aplanaría, y esperar el intento sería esperar
   * a la desconexión.)
   */
  private async attach(): Promise<{ ended: Promise<void> } | null> {
    const client = await this.connect();
    if (!client) return null;

    let wake!: () => void;
    const ended = new Promise<void>((resolve) => (wake = resolve));
    this.wakeDetached = wake;

    // Desde esta foto se encola: lo anterior va dentro de ella.
    const snapshot = this.publisher.snapshot();
    this.queue = [];
    this.needSnapshot = false;
    this.baseSeq = snapshot.seq;
    this.attached = true;
    try {
      const result = await client.request('host.register', {
        snapshot,
        pid: this.opts.pid ?? process.pid,
        ...(this.claim ? { claim: this.claim } : {}),
      });
      this.claim = result.claim;
    } catch (err) {
      this.rejected(err, 'register');
      this.attached = false;
      this.queue = [];
      client.close();
      return null;
    }
    if (this.lifetime.signal.aborted || client.status !== 'ready') {
      this.attached = false;
      client.close();
      return null;
    }
    this.client = client;
    this.rejections = 0;
    log.info('session published', { sessionId: this.sessionId, seq: snapshot.seq });
    this.pump();
    return { ended };
  }

  private async connect(): Promise<StratumClient | null> {
    for (let again = false; ; again = true) {
      const client = new StratumClient({
        discovery: this.opts.discovery ?? fileDiscovery(),
        identity: {
          kind: 'cli',
          name: this.opts.name,
          version: this.opts.version,
          roles: ['host'],
        },
        ...(this.opts.connector ? { connector: this.opts.connector } : {}),
        // La reconexión es de este puente: cada conexión nueva vuelve a registrar.
        reconnect: false,
        requestTimeoutMs: this.requestTimeoutMs,
        handlers: this.handlers(),
        onStatus: (status) => {
          if (status === 'closed') this.onClientClosed(client);
        },
      });
      try {
        const hello = await client.connect();
        if (!hello.capabilities.includes('host')) {
          // Un daemon que no admite anfitriones pares: no hay nada que publicar.
          this.rejections = MAX_REJECTIONS;
          client.close();
          return null;
        }
        this.approvers = hello.features.includes(FEATURE_REMOTE_APPROVALS);
        return client;
      } catch (err) {
        if (
          err instanceof ServerUnavailableError &&
          err.discovery !== 'invalid' &&
          this.autoStartPending &&
          !again
        ) {
          this.autoStartPending = false;
          try {
            await this.opts.autoStart?.();
            continue;
          } catch (startErr) {
            log.warn('could not start the daemon', { err: startErr });
          }
        } else if (err instanceof ProtocolMismatchError) {
          // Otra versión del protocolo: no va a cambiar mientras viva este proceso.
          log.info('daemon speaks another protocol version, publishing disabled');
          this.rejections = MAX_REJECTIONS;
        } else if (err instanceof ProtocolError) {
          this.rejected(err, 'handshake');
        } else {
          log.debug('daemon not reachable', {
            reason: err instanceof ServerUnavailableError ? err.discovery : 'connect',
          });
        }
        this.autoStartPending = false;
        return null;
      }
    }
  }

  private rejected(err: unknown, step: string): void {
    if (err instanceof ProtocolError) {
      this.rejections++;
      log.debug('daemon rejected the session', { step, code: err.code });
    } else {
      log.debug('daemon did not answer', { step });
    }
  }

  private onClientClosed(client: StratumClient): void {
    if (this.client === client) {
      this.client = null;
      this.approvers = false;
      this.attached = false;
      this.queue = [];
    }
    const wake = this.wakeDetached;
    this.wakeDetached = null;
    wake?.();
  }

  /** Suelta la conexión actual: el bucle volverá a registrar con una foto. */
  private drop(client: StratumClient): void {
    client.close();
    this.onClientClosed(client);
  }

  // ---------------------------------------------------------------------------
  // Órdenes del daemon
  // ---------------------------------------------------------------------------

  private own(sessionId: string): void {
    if (sessionId !== this.sessionId) throw new ProtocolError('NOT_FOUND', 'Session not found.');
  }

  /** El run sobre el que llega una orden: con `runId`, tiene que seguir siendo el vigente. */
  private current(params: { sessionId: string; runId?: string }): ProtocolRun | null {
    this.own(params.sessionId);
    const active = this.publisher.activeRun;
    if (params.runId !== undefined && active?.id !== params.runId) {
      throw new ProtocolError('STALE_STATE', 'That run is no longer the current one.');
    }
    return active;
  }

  private handlers(): RequestHandlers {
    return {
      'host.cancel': (params) => {
        if (!this.current(params)) return { status: 'not-running' };
        this.opts.control.cancel();
        return { status: 'cancelled' };
      },
      // Pausa cooperativa: se entrega al runtime y se contesta lo que él diga.
      // Que el run esté en pausa no se afirma aquí: lo publica la sesión cuando
      // alcanza su punto seguro.
      'host.pause': (params) => {
        if (!this.current(params)) return { status: 'not-running' };
        return { status: this.opts.control.pause() };
      },
      'host.resume': (params) => {
        if (!this.current(params)) return { status: 'not-running' };
        return { status: this.opts.control.resume() };
      },
      'host.steer': (params) => {
        this.own(params.sessionId);
        return { status: this.opts.control.steer(params.text).status };
      },
      // Decisiones que llegan de otro cliente. Aquí no se decide quién gana:
      // se entregan a `PendingInteractions`, donde compiten con el prompt local,
      // y lo que conteste (también `ALREADY_RESOLVED`) es la respuesta.
      'host.resolveApproval': (params) => {
        this.pending(params.sessionId).resolveApproval(
          params.approvalId,
          params.decision,
          params.phrase,
          remoteResolver(params.by),
        );
        return {};
      },
      'host.answerQuestions': (params) => {
        this.pending(params.sessionId).answerQuestions(
          params.requestId,
          params.answers,
          remoteResolver(params.by),
        );
        return {};
      },
      'host.decidePlan': (params) => {
        this.pending(params.sessionId).decidePlan(
          params.requestId,
          params.decision,
          params.plan,
          remoteResolver(params.by),
        );
        return {};
      },
    };
  }

  private pending(sessionId: string): PendingInteractions {
    this.own(sessionId);
    const interactions = this.opts.session.interactions;
    if (!interactions) throw new ProtocolError('NOT_FOUND', 'No such pending request.');
    return interactions;
  }

  // ---------------------------------------------------------------------------
  // Salida: lo que publica la sesión
  // ---------------------------------------------------------------------------

  onEvents(events: ProtocolEvent[]): void {
    // Sin daemon no se guarda nada: al conectar viaja una foto.
    if (!this.attached) return;
    for (const event of events) this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      this.queue = this.queue.filter(isStateEvent);
      if (this.queue.length > this.maxQueue) this.resync();
    }
    this.pump();
  }

  onOverflow(): void {
    if (this.attached) this.resync();
    this.pump();
  }

  /** Lo pendiente ya no es una secuencia completa: se sustituye por una foto. */
  private resync(): void {
    this.queue = [];
    this.needSnapshot = true;
  }

  private pump(): void {
    if (this.sendTask || !this.client) return;
    if (!this.needSnapshot && this.queue.length === 0) return;
    const client = this.client;
    const task = this.send(client).finally(() => {
      if (this.sendTask === task) this.sendTask = null;
      // Lo que llegó mientras se cerraba la última petición.
      if (this.client === client) this.pump();
    });
    this.sendTask = task;
  }

  /** Una petición en vuelo cada vez: el orden es el de la cola, y el daemon marca el ritmo. */
  private async send(client: StratumClient): Promise<void> {
    while (this.client === client) {
      let snapshot;
      if (this.needSnapshot) {
        this.needSnapshot = false;
        snapshot = this.publisher.snapshot();
        this.baseSeq = snapshot.seq;
      }
      const events = snapshot ? [] : this.nextBatch();
      if (!snapshot && events.length === 0) return;
      try {
        await client.request('host.publish', {
          sessionId: this.sessionId,
          ...(snapshot ? { snapshot } : {}),
          events,
        });
      } catch (err) {
        if (err instanceof ProtocolError && err.code === 'STALE_STATE') {
          // El daemon vio un hueco: la foto manda.
          this.resync();
          continue;
        }
        this.rejected(err, 'publish');
        if (this.client === client) this.drop(client);
        return;
      }
    }
  }

  private nextBatch(): ProtocolEvent[] {
    const batch: ProtocolEvent[] = [];
    let chars = 0;
    while (this.queue.length > 0 && batch.length < BATCH_EVENTS && chars < BATCH_CHARS) {
      const event = this.queue.shift()!;
      // Numerado antes de la última foto: ya va dentro de ella.
      if (isStateEvent(event) ? event.seq <= this.baseSeq : event.after < this.baseSeq) continue;
      chars += JSON.stringify(event).length;
      batch.push(event);
    }
    return batch;
  }

  // ---------------------------------------------------------------------------
  // Cierre
  // ---------------------------------------------------------------------------

  /**
   * La sesión termina: publica su estado final (`session.closed`), la da de
   * baja y cierra la conexión. Espera como mucho `waitMs` a que salga lo
   * pendiente. **No** desmonta la sesión: eso es de quien la aloja.
   */
  async close(
    reason: StateEventData['session.closed']['reason'] = 'closed',
    waitMs = 2_000,
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const deadline = new AbortController();
    try {
      this.publisher.close(reason);
      const client = this.client;
      if (client) {
        const flushed = (async () => {
          this.pump();
          while (this.sendTask) await this.sendTask;
          if (this.client === client) {
            await client.request('host.unregister', { sessionId: this.sessionId });
          }
        })();
        await Promise.race([flushed.catch(() => undefined), pause(waitMs, deadline.signal)]);
      }
    } catch (err) {
      log.debug('close failed', { err });
    } finally {
      deadline.abort();
      this.lifetime.abort();
      const client = this.client;
      this.client = null;
      this.attached = false;
      this.queue = [];
      client?.close();
      this.wakeDetached?.();
    }
  }
}
