/**
 * Puente de un anfitrión par: publica en `stratumd` una sesión que **vive en
 * este proceso** y atiende las órdenes de control que el daemon le reenvía.
 *
 *   sesión → SessionPublisher → [este puente] → host.publish → stratumd
 *                                             ← host.cancel / host.steer
 *                                             ← host.pause / host.resume
 *                                             ← host.detach  (M10)
 *
 * El puente es transporte y nada más:
 *
 *  - **No es dueño del runtime.** Nunca desmonta la sesión ni la detiene: si el
 *    daemon desaparece, la sesión sigue igual y el puente vuelve a intentarlo.
 *  - **No guarda estado de la sesión.** Lo único suyo es la conexión, la cola
 *    de salida y lo necesario para reclamar la sesión al reconectar (`claim` y
 *    la época de propiedad). El estado está en el `SessionPublisher` —el mismo
 *    que usa una sesión del daemon—, y el `seq` es el suyo.
 *  - **Publicar es opcional.** Sin daemon, con uno incompatible, con el token
 *    rechazado o con cualquier error del protocolo, la sesión funciona como si
 *    el puente no existiera. Ningún método de aquí lanza.
 *  - **Nunca reenvía historia.** Lo que no se pudo enviar se sustituye por una
 *    foto (`publisher.snapshot()`), que es la autoridad.
 *
 * **Traspaso al daemon (M10).** `detach()` entrega la sesión a `stratumd`: la
 * sesión deja de empezar trabajo (`PeerHostControl.prepareHandoff`), se publica
 * todo hasta su último `seq`, se retiene lo que venga después, y el contexto
 * viaja troceado (`host.handoffBegin` → `host.handoffChunk` → `host.handoffCommit`).
 * El commit decide: o el daemon es su anfitrión (y este proceso deja de serlo
 * para siempre: `handedOff`), o este proceso lo sigue siendo. Si la respuesta
 * del commit no llega, **no se reintenta**: se pregunta al daemon quién es el
 * anfitrión volviendo a registrar la sesión (`resolveUnknown`).
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
  HANDOFF_FORMAT,
  HANDOFF_LIMITS,
  isStateEvent,
  splitHandoff,
  type ClientKind,
  type PauseStatus,
  type ProtocolChatMessage,
  type ProtocolErrorCode,
  type ProtocolEvent,
  type ProtocolResolver,
  type ProtocolRun,
  type ResumeStatus,
  type StateEventData,
  type SteerStatus,
} from '../protocol/index.js';
import type { HandoffPreparation } from './handoff.js';
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
  /**
   * M10 — deja la sesión lista para traspasarla al daemon, o dice por qué no se
   * puede. Sin esto, este anfitrión no sabe traspasar (`unsupported-host`).
   */
  prepareHandoff?(): HandoffPreparation;
}

/** Cómo terminó un `detach()`. */
export type DetachOutcome =
  /** El daemon es el anfitrión de la sesión. Este proceso ya no lo es. */
  | { status: 'detached' }
  /** No se traspasó: la sesión sigue siendo de este proceso. */
  | { status: 'kept'; code: ProtocolErrorCode; reason?: string; message: string }
  /**
   * No se pudo saber: el commit salió y no hubo forma de preguntar al daemon.
   * La sesión **no** vuelve a trabajar aquí (podría ser ya del daemon).
   */
  | { status: 'unknown'; message: string };

export type { HandoffPreparation } from './handoff.js';

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
  /** Plazo del commit de un traspaso: incluye que el daemon monte la sesión. */
  commitTimeoutMs?: number;
  /** Cuánto se intenta averiguar el desenlace de un commit sin respuesta. */
  resolveTimeoutMs?: number;
  pid?: number;
  /**
   * La sesión pasó a alojarla el daemon —por `detach()` o porque otro cliente
   * lo pidió (`sessions.detach`)—. Quien aloja la sesión deja de usarla.
   */
  onHandedOff?: () => void;
  /** M12 — desde qué cliente se inició (por defecto, la terminal). Solo procedencia. */
  origin?: ClientKind;
  /** M12 — conversación previa que no sale de eventos (ver `SessionPublisherOptions`). */
  transcript?: ProtocolChatMessage[];
  /** M12 — su título, con `transcript`. */
  title?: string;
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

/** El daemon dice que este proceso ya no es el anfitrión de la sesión. */
function isSuperseded(err: unknown): boolean {
  return (
    err instanceof ProtocolError &&
    err.code === 'STALE_STATE' &&
    (err.data?.reason === 'stale-epoch' || err.data?.reason === 'handed-off')
  );
}

/** Un traspaso en curso: mientras exista, el bucle de conexión espera. */
interface Handoff {
  /** Se resuelve al terminar, sea cual sea el desenlace. */
  done: Promise<void>;
  finish: () => void;
}

export class PeerHostBridge implements PublisherSink {
  /** El publicador de la sesión: la misma pieza que usa una sesión del daemon. */
  readonly publisher: SessionPublisher;

  private readonly lifetime = new AbortController();
  private readonly maxQueue: number;
  private readonly requestTimeoutMs: number;
  /** Conexión con la sesión ya registrada, o `null`. */
  private client: StratumClient | null = null;
  /** Fin de la conexión actual, para el bucle (ver `attach`). */
  private live: { ended: Promise<void> } | null = null;
  /** El daemon al que se está conectado acredita aprobadores. */
  private approvers = false;
  /** Se registró (o se está registrando): los eventos se encolan desde la foto enviada. */
  private attached = false;
  /** Para reclamar la sesión si el daemon la conserva tras una desconexión. */
  private claim: string | null = null;
  /** Época de propiedad que dio el daemon: va en cada `host.publish`. */
  private epoch = 0;
  /** Por qué falló el último registro (para decidir el desenlace de un traspaso). */
  private lastRegisterError: unknown = null;
  private queue: ProtocolEvent[] = [];
  /** `seq` de la última foto enviada: lo anterior ya va dentro de ella. */
  private baseSeq = 0;
  private needSnapshot = false;
  private sendTask: Promise<void> | null = null;
  /** Traspaso en curso: lo nuevo se retiene (no se publica) hasta su desenlace. */
  private holding = false;
  private handoff: Handoff | null = null;
  private handedOffFlag = false;
  /** El daemon dijo que la sesión ya no es de aquí mientras había un traspaso propio en curso. */
  private supersededSeen = false;
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
      origin: opts.origin ?? 'cli',
      ...(opts.transcript ? { seedTranscript: opts.transcript } : {}),
      ...(opts.title ? { seedTitle: opts.title } : {}),
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

  /** ¿Pasó la sesión al daemon? Definitivo. */
  get handedOff(): boolean {
    return this.handedOffFlag;
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
      // Durante un traspaso la conexión es de él: aquí no se registra nada.
      while (this.handoff) await this.handoff.done;
      if (signal.aborted || this.handedOffFlag) return;
      const link = this.live ?? (await this.attach());
      first();
      if (link) {
        failures = 0;
        await link.ended;
        if (!signal.aborted) log.debug('detached from daemon', { sessionId: this.sessionId });
      } else {
        failures++;
      }
      if (this.handedOffFlag) return;
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
    this.lastRegisterError = null;
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
      this.epoch = result.epoch;
    } catch (err) {
      this.lastRegisterError = err;
      this.attached = false;
      this.queue = [];
      client.close();
      if (isSuperseded(err)) {
        // El daemon la aloja ya: este proceso dejó de ser su anfitrión.
        this.superseded();
        return null;
      }
      // Un traspaso que se está montando no es un rechazo: se espera a su desenlace.
      if (!(err instanceof ProtocolError && err.data?.reason === 'handoff-in-progress')) {
        this.rejected(err, 'register');
      }
      return null;
    }
    if (this.lifetime.signal.aborted || client.status !== 'ready') {
      this.attached = false;
      client.close();
      return null;
    }
    this.client = client;
    this.live = { ended };
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
        this.lastRegisterError = err;
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
      this.live = null;
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
      // Otro cliente pide que la sesión pase al daemon (`sessions.detach`). Lo
      // hace este proceso, que es quien sabe si puede soltarla.
      'host.detach': async (params) => {
        this.own(params.sessionId);
        const outcome = await this.detach();
        if (outcome.status === 'detached') return { status: 'detached' };
        if (outcome.status === 'unknown') {
          throw new ProtocolError('UNAVAILABLE', outcome.message, { reason: 'host-unavailable' });
        }
        throw new ProtocolError(
          outcome.code,
          outcome.message,
          outcome.reason ? { reason: outcome.reason } : undefined,
        );
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
  // Traspaso al daemon (M10)
  // ---------------------------------------------------------------------------

  /**
   * Traspasa la sesión a `stratumd`. Nunca lanza: el desenlace dice si la
   * sesión es ya del daemon (`detached`), si sigue siendo de este proceso
   * (`kept`, con el motivo) o si no se pudo saber (`unknown`).
   */
  async detach(): Promise<DetachOutcome> {
    if (this.handedOffFlag) return { status: 'detached' };
    if (this.handoff) {
      return kept('BUSY', 'The session is already being handed off.', 'handoff-in-progress');
    }
    const client = this.client;
    if (!client || this.closed) {
      return kept('UNAVAILABLE', 'This session is not published in stratumd.');
    }
    const prepare = this.opts.control.prepareHandoff;
    if (!prepare) {
      return kept(
        'NOT_TRANSFERABLE',
        'This kind of session cannot be handed off to the daemon.',
        'unsupported-host',
      );
    }
    const prep = prepare();
    if (!prep.ok) return kept(prep.code, prep.message, prep.reason);

    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    this.handoff = { done, finish };
    try {
      const outcome = await this.handOver(client, prep);
      if (outcome.status === 'detached') prep.settle('committed');
      else if (outcome.status === 'kept') {
        this.holding = false;
        prep.settle('kept');
        this.pump();
      }
      // `unknown`: la sesión no vuelve a trabajar aquí ni se publica.
      log.info('handoff finished', {
        sessionId: this.sessionId,
        status: outcome.status,
        ...(outcome.status === 'kept' ? { code: outcome.code, reason: outcome.reason } : {}),
      });
      return outcome;
    } finally {
      this.handoff = null;
      finish();
    }
  }

  private async handOver(
    client: StratumClient,
    prep: Extract<HandoffPreparation, { ok: true }>,
  ): Promise<DetachOutcome> {
    const json = JSON.stringify(prep.context);
    if (json.length > HANDOFF_LIMITS.maxChars) {
      return kept('NOT_TRANSFERABLE', 'The session context is too large to hand off.', 'context');
    }
    const chunks = splitHandoff(json);
    if (chunks.length > HANDOFF_LIMITS.maxChunks) {
      return kept('NOT_TRANSFERABLE', 'The session context is too large to hand off.', 'context');
    }
    // Qué daemon recibe la sesión: si el desenlace no llega, se le pregunta a él.
    const located = await (this.opts.discovery ?? fileDiscovery()).locate();
    // Sin saber qué daemon la recibe no se podría resolver un desenlace desconocido.
    if (located.status !== 'found') {
      return kept('UNAVAILABLE', 'Cannot identify the stratumd that would take the session.');
    }
    const target = located.endpoint;

    // 1. Que el daemon tenga todo lo publicado hasta ahora, y retener lo siguiente.
    if (!(await this.settlePublished(client))) {
      return kept('UNAVAILABLE', 'Could not publish the session state before the handoff.');
    }
    await prep.flush?.().catch((err: unknown) => log.warn('flush before handoff failed', { err }));
    const seq = this.publisher.seq;

    let handoffId: string | null = null;
    let committing = false;
    try {
      ({ handoffId } = await client.request('host.handoffBegin', {
        sessionId: this.sessionId,
        epoch: this.epoch,
        seq,
        format: HANDOFF_FORMAT,
        chunks: chunks.length,
        chars: json.length,
      }));
      for (const [index, data] of chunks.entries()) {
        await client.request('host.handoffChunk', {
          sessionId: this.sessionId,
          handoffId,
          index,
          data,
        });
      }
      // Lo que cambiase entretanto (un `/model`, por ejemplo) no está en el contexto enviado.
      if (this.publisher.seq !== seq || this.queue.length > 0) {
        void client
          .request('host.handoffAbort', { sessionId: this.sessionId, handoffId })
          .catch(() => undefined);
        return kept('STALE_STATE', 'The session changed during the handoff.', 'changed');
      }
      committing = true;
      await client.request(
        'host.handoffCommit',
        { sessionId: this.sessionId, handoffId },
        { timeoutMs: this.opts.commitTimeoutMs ?? 120_000 },
      );
      this.becomeHandedOff();
      return { status: 'detached' };
    } catch (err) {
      if (isSuperseded(err)) {
        this.becomeHandedOff();
        return { status: 'detached' };
      }
      if (err instanceof ProtocolError) {
        // Lo empezado y sin confirmar se suelta en el daemon (si no lo hizo él).
        if (handoffId && !committing && client.status === 'ready') {
          void client
            .request('host.handoffAbort', { sessionId: this.sessionId, handoffId })
            .catch(() => undefined);
        }
        // Un no del daemon es definitivo: lo que no se confirmó no se montó.
        const reason = typeof err.data?.reason === 'string' ? err.data.reason : undefined;
        return kept(err.code, err.message, reason);
      }
      if (!committing) {
        // Sin commit enviado el daemon no puede montarla: lo empezado se descarta.
        if (handoffId && client.status === 'ready') {
          void client
            .request('host.handoffAbort', { sessionId: this.sessionId, handoffId })
            .catch(() => undefined);
        }
        return kept('UNAVAILABLE', 'The daemon did not answer during the handoff.');
      }
      // El commit salió y no se sabe cómo acabó: no se reintenta, se pregunta.
      log.warn('handoff commit outcome unknown, asking the daemon', { sessionId: this.sessionId });
      return this.resolveUnknown(target);
    }
  }

  /**
   * Publica lo que haya en cola y espera a que el daemon lo tenga; después
   * retiene lo nuevo (`holding`). `false` si la conexión se pierde o no da tiempo.
   */
  private async settlePublished(client: StratumClient, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.holding = false;
      this.publisher.flush();
      this.pump();
      while (
        this.client === client &&
        (this.sendTask || this.queue.length > 0 || this.needSnapshot)
      ) {
        if (Date.now() > deadline) return false;
        if (this.sendTask) await this.sendTask;
        else this.pump();
        if (!this.sendTask && (this.queue.length > 0 || this.needSnapshot)) {
          await pause(5, this.lifetime.signal);
        }
      }
      if (this.client !== client) return false;
      this.holding = true;
      // Lo que se numeró mientras se enviaba lo anterior: otra vuelta.
      this.publisher.flush();
      if (this.queue.length === 0 && !this.needSnapshot) return true;
      if (Date.now() > deadline) return false;
    }
  }

  /**
   * El commit salió y su respuesta no llegó. **No se reintenta**: se pregunta al
   * daemon quién es el anfitrión, volviendo a registrar la sesión con su
   * `claim`. Vallada → es del daemon. Registrada → sigue siendo de aquí (el
   * daemon no la montó). Si el daemon que la recibió ya no existe (no hay
   * endpoint, u otro proceso lo ocupa), nadie puede alojarla —el daemon no
   * persiste sesiones— y sigue siendo de aquí.
   */
  private async resolveUnknown(target: { pid: number; startedAt: string }): Promise<DetachOutcome> {
    const current = this.client;
    if (current) this.drop(current);
    const deadline = Date.now() + (this.opts.resolveTimeoutMs ?? 120_000);
    const signal = this.lifetime.signal;
    while (Date.now() < deadline && !signal.aborted) {
      const located = await (this.opts.discovery ?? fileDiscovery()).locate();
      const same =
        located.status === 'found' &&
        located.endpoint.pid === target.pid &&
        located.endpoint.startedAt === target.startedAt;
      if (!same && located.status !== 'invalid') {
        log.info('the daemon that received the handoff is gone; the session stays here', {
          sessionId: this.sessionId,
        });
        return kept('UNAVAILABLE', 'The daemon went away before confirming the handoff.');
      }
      if (same) {
        const link = await this.attach();
        if (link) return kept('UNAVAILABLE', 'The daemon did not take the session.');
        if (this.supersededSeen || isSuperseded(this.lastRegisterError)) {
          this.becomeHandedOff();
          return { status: 'detached' };
        }
      }
      if (!(await pause(500, signal))) break;
    }
    return {
      status: 'unknown',
      message:
        'Could not confirm whether stratumd took the session. It is no longer used here; ' +
        'check it with `stratum ps`.',
    };
  }

  /** Otro proceso es ya el anfitrión: el daemon lo dijo al publicar o registrar. */
  private superseded(): void {
    if (this.handedOffFlag) return;
    // Un traspaso propio en curso lo resuelve él mismo.
    if (this.handoff) {
      this.supersededSeen = true;
      return;
    }
    log.warn('the daemon says this process no longer hosts the session', {
      sessionId: this.sessionId,
    });
    this.becomeHandedOff();
  }

  /**
   * La sesión es del daemon: este proceso deja de publicarla **sin cerrarla**
   * (sin `session.closed` ni `host.unregister`: sigue viva allí) y se lo dice
   * a quien la aloja. La conexión se suelta un instante después, para que salga
   * la respuesta de un `host.detach` que esté en curso.
   */
  private becomeHandedOff(): void {
    const first = !this.handedOffFlag;
    this.handedOffFlag = true;
    this.holding = true;
    this.queue = [];
    this.publisher.release();
    this.lifetime.abort();
    const client = this.client;
    this.client = null;
    this.live = null;
    this.attached = false;
    if (client) {
      const timer = setTimeout(() => client.close(), 250);
      timer.unref();
    }
    this.wakeDetached?.();
    if (first) {
      try {
        this.opts.onHandedOff?.();
      } catch (err) {
        log.warn('onHandedOff failed', { err });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Salida: lo que publica la sesión
  // ---------------------------------------------------------------------------

  onEvents(events: ProtocolEvent[]): void {
    // Sin daemon no se guarda nada: al conectar viaja una foto.
    if (!this.attached || this.handedOffFlag) return;
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
    if (this.sendTask || !this.client || this.holding) return;
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
    while (this.client === client && !this.holding) {
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
          epoch: this.epoch,
          ...(snapshot ? { snapshot } : {}),
          events,
        });
      } catch (err) {
        if (isSuperseded(err)) {
          this.superseded();
          return;
        }
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
   * pendiente. **No** desmonta la sesión: eso es de quien la aloja. Con la
   * sesión ya traspasada al daemon no publica nada: allí sigue viva.
   */
  async close(
    reason: StateEventData['session.closed']['reason'] = 'closed',
    waitMs = 2_000,
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.handedOffFlag) {
      this.lifetime.abort();
      return;
    }
    const deadline = new AbortController();
    try {
      this.publisher.close(reason);
      this.holding = false;
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
      this.live = null;
      this.attached = false;
      this.queue = [];
      client?.close();
      this.wakeDetached?.();
    }
  }
}

function kept(code: ProtocolErrorCode, message: string, reason?: string): DetachOutcome {
  return { status: 'kept', code, message, ...(reason ? { reason } : {}) };
}
