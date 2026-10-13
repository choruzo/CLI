/**
 * Sesiones **pares**: las que aloja otro proceso (la CLI) y publica aquí con
 * `host.register` / `host.publish`. El daemon no tiene de ellas más que una
 * **proyección**: quién la aloja, si sigue conectado, y la última foto, puesta
 * al día con los eventos que el anfitrión va publicando.
 *
 *   anfitrión par ── host.publish ──▶ proyección ──▶ RunRegistry + EventHub
 *                 ◀── host.cancel / host.steer / host.pause / host.resume ──
 *
 * Lo que **no** hay aquí: ni `SessionHost`, ni agente, ni jobs, ni MCP, ni SSH,
 * ni memoria, ni traza, ni directorio de trabajo. Nada de esto ejecuta ni
 * decide: una orden de control se reenvía a su anfitrión y la respuesta es la
 * suya.
 *
 * Reglas:
 *
 *  - **El `seq` es del anfitrión.** Se comprueba que es consecutivo y se
 *    conserva tal cual. Lo que el daemon sabe por sí mismo —que el anfitrión se
 *    ha ido, que la proyección se descarta— no es un evento: llega a los
 *    clientes como una **foto**, que sustituye lo que tuvieran.
 *  - **Un hueco no se arregla**: el lote se rechaza (`STALE_STATE`) y el
 *    anfitrión contesta con una foto, que manda.
 *  - **Una sesión es de la conexión que la registró.** Otra conexión no puede
 *    publicar en ella, darla de baja ni reclamarla, aunque conozca su id.
 *  - **Que el anfitrión se desconecte no cierra la sesión**: queda `detached`,
 *    con lo último que contó (su run sigue como estaba), hasta que vuelve y la
 *    reclama, su proceso muere o pasa el plazo.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { ProtocolError } from '../ipc/codec.js';
import type { RequestOptions } from '../ipc/peer.js';
import { getLogger } from '../logging/index.js';
import {
  applySessionEvent,
  isStateEvent,
  type CancelStatus,
  type ClientKind,
  type HostPublishParams,
  type HostRegisterParams,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type PauseStatus,
  type ProtocolApprovalDecision,
  type ProtocolEvent,
  type ProtocolPlan,
  type ProtocolQuestionAnswer,
  type ProtocolResolver,
  type ProtocolSessionSnapshot,
  type ResumeStatus,
  type SteerStatus,
} from '../protocol/index.js';
import type { EventHub } from './event-hub.js';
import type { RunRegistry } from './run-registry.js';

const log = getLogger('daemon').child('peers');

/** La conexión de un anfitrión, vista desde aquí. */
export interface PeerHostLink {
  readonly id: number;
  readonly client: { kind: ClientKind } | null;
  /** Petición del servidor al anfitrión. */
  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: RequestOptions,
  ): Promise<MethodResult<M>>;
}

export interface PeerSessionsOptions {
  hub: EventHub;
  registry: RunRegistry;
  /** ¿Ese id ya es de una sesión alojada en el daemon? */
  isLocalSession: (sessionId: string) => boolean;
  /** Sesiones pares a la vez. */
  maxSessions?: number;
  /** Tiempo que se conserva una sesión sin anfitrión. `0` = sin plazo. */
  detachedTtlMs?: number;
  /** Plazo de la respuesta de un anfitrión a una orden de control. */
  controlTimeoutMs?: number;
  /** Cada cuánto se mira si el proceso de un anfitrión desconectado sigue vivo. */
  watchIntervalMs?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** Algo cambió (para la cuenta de actividad del daemon). */
  onActivity?: () => void;
  /**
   * Lo pendiente de decisión que cuentan los anfitriones (aprobaciones,
   * preguntas, planes): cada evento aplicado, cada foto que sustituye y cada
   * sesión que deja de existir.
   */
  pending?: {
    apply(event: ProtocolEvent): void;
    sync(snapshot: ProtocolSessionSnapshot): void;
    forget(sessionId: string): void;
  };
}

interface PeerSession {
  sessionId: string;
  /** La conexión que la aloja, o `null` si se desconectó. */
  owner: PeerHostLink | null;
  kind: ClientKind;
  /** Secreto con el que el anfitrión la reclama al reconectar. */
  claim: string;
  pid: number | null;
  /** Última foto del anfitrión, al día con los eventos recibidos después. */
  snapshot: ProtocolSessionSnapshot;
  detachedAt: number | null;
  watch: NodeJS.Timeout | null;
}

type ForwardedMethod =
  | 'host.cancel'
  | 'host.steer'
  | 'host.pause'
  | 'host.resume'
  | 'host.resolveApproval'
  | 'host.answerQuestions'
  | 'host.decidePlan';

/** Órdenes sobre el run. Las demás reenviadas son decisiones sobre una solicitud. */
const RUN_CONTROL: ReadonlySet<ForwardedMethod> = new Set([
  'host.cancel',
  'host.steer',
  'host.pause',
  'host.resume',
]);

function invalid(path: string, message: string): ProtocolError {
  return new ProtocolError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function hostUnavailable(): ProtocolError {
  return new ProtocolError('UNAVAILABLE', 'The host of that session is not connected.', {
    reason: 'host-unavailable',
  });
}

/** Eso solo puede hacerlo el proceso que aloja la sesión. */
export function peerHostedOnly(what: string): ProtocolError {
  return new ProtocolError('UNAVAILABLE', `${what} is up to the process that hosts the session.`, {
    reason: 'peer-hosted',
  });
}

export class PeerSessions {
  private readonly sessions = new Map<string, PeerSession>();
  private readonly maxSessions: number;
  private readonly detachedTtlMs: number;
  private readonly controlTimeoutMs: number;
  private readonly watchIntervalMs: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(private readonly opts: PeerSessionsOptions) {
    this.maxSessions = opts.maxSessions ?? 128;
    this.detachedTtlMs = opts.detachedTtlMs ?? 10 * 60_000;
    this.controlTimeoutMs = opts.controlTimeoutMs ?? 5_000;
    this.watchIntervalMs = opts.watchIntervalMs ?? 1_000;
    this.isAlive =
      opts.isAlive ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      });
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Sesiones que aloja una conexión. */
  hostedBy(link: PeerHostLink): string[] {
    return [...this.sessions.values()].filter((p) => p.owner === link).map((p) => p.sessionId);
  }

  /**
   * La foto que se sirve. Con el anfitrión conectado, la suya. Sin él, la
   * última conocida con dos cambios que son del daemon: `host.connected` es
   * `false` y la sesión está `detached`. **El run no se toca**: puede seguir en
   * marcha, y lo que falta es visibilidad, no un resultado.
   */
  snapshotOf(sessionId: string): ProtocolSessionSnapshot | null {
    const p = this.sessions.get(sessionId);
    return p ? this.view(p) : null;
  }

  private view(p: PeerSession): ProtocolSessionSnapshot {
    const { snapshot } = p;
    const connected = p.owner !== null;
    return {
      ...snapshot,
      session: {
        ...snapshot.session,
        host: { kind: 'peer', client: p.kind, connected },
        ...(connected || snapshot.session.state === 'closed' ? {} : { state: 'detached' as const }),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Validación de lo que publica un anfitrión
  // ---------------------------------------------------------------------------

  private checkSnapshot(snapshot: ProtocolSessionSnapshot): void {
    const id = snapshot.session.id;
    if (snapshot.session.host.kind !== 'peer') {
      throw invalid('snapshot.session.host.kind', 'a published session is peer-hosted');
    }
    if (snapshot.session.seq !== snapshot.seq) {
      throw invalid('snapshot.seq', 'the session and its snapshot disagree on seq');
    }
    if (snapshot.run) this.checkRun(id, snapshot.run, 'snapshot.run');
    if (snapshot.jobs.some((j) => j.sessionId !== id)) {
      throw invalid('snapshot.jobs', 'a job of another session');
    }
    const pending = [...snapshot.approvals, ...snapshot.questions, ...snapshot.plans];
    if (pending.some((r) => r.sessionId !== id)) {
      throw invalid('snapshot', 'a pending request of another session');
    }
  }

  /** Un run se identifica por su id en todo el daemon: no se puede pisar el de otra sesión. */
  private checkRun(sessionId: string, run: { id: string; sessionId: string }, path: string): void {
    if (run.sessionId !== sessionId) throw invalid(path, 'a run of another session');
    const known = this.opts.registry.run(run.id);
    if (known && known.sessionId !== sessionId) throw invalid(path, 'a run of another session');
  }

  private checkEvents(sessionId: string, events: readonly ProtocolEvent[]): void {
    events.forEach((event, i) => {
      const path = `events.${i}`;
      if (event.sessionId !== sessionId) throw invalid(path, 'an event of another session');
      switch (event.type) {
        case 'session.opened':
        case 'session.updated':
          if (event.data.session.id !== sessionId || event.data.session.host.kind !== 'peer') {
            throw invalid(path, 'the session of the event is not the published one');
          }
          return;
        case 'run.started':
        case 'run.updated':
        case 'run.completed':
        case 'run.failed':
        case 'run.cancelled':
          return this.checkRun(sessionId, event.data.run, path);
        case 'job.started':
        case 'job.ended':
          if (event.data.job.sessionId !== sessionId)
            throw invalid(path, 'a job of another session');
          return;
        case 'approval.requested':
          if (event.data.approval.sessionId !== sessionId) {
            throw invalid(path, 'a pending request of another session');
          }
          return;
        case 'question.requested':
        case 'plan.proposed':
          if (event.data.request.sessionId !== sessionId) {
            throw invalid(path, 'a pending request of another session');
          }
          return;
        // Lo que el daemon cuenta por su cuenta con una foto no lo publica un anfitrión.
        case 'session.detached':
          throw invalid(path, 'not an event a host publishes');
        default:
          return;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // host.register / host.publish / host.unregister
  // ---------------------------------------------------------------------------

  /**
   * Registra una sesión, o la **reclama** si el daemon ya la conocía y estaba
   * sin anfitrión. En los dos casos la foto que llega es la autoridad.
   */
  register(link: PeerHostLink, params: HostRegisterParams): { claim: string } {
    const { snapshot } = params;
    const sessionId = snapshot.session.id;
    this.checkSnapshot(snapshot);
    if (this.opts.isLocalSession(sessionId)) {
      throw new ProtocolError('FORBIDDEN', 'That session belongs to another host.');
    }
    if (snapshot.session.state === 'closed') throw invalid('snapshot', 'the session is closed');

    const known = this.sessions.get(sessionId);
    if (known) {
      if (known.owner && known.owner !== link) {
        throw new ProtocolError('FORBIDDEN', 'That session belongs to another host.');
      }
      if (!known.owner) {
        // Volver no basta con saber el id: hay que traer lo que se le dio al registrarla.
        if (!params.claim || !sameSecret(params.claim, known.claim)) {
          throw new ProtocolError('FORBIDDEN', 'That session belongs to another host.');
        }
        // El `seq` de un anfitrión no retrocede: una foto anterior no es de esta sesión.
        if (snapshot.seq < known.snapshot.seq) {
          throw new ProtocolError('STALE_STATE', 'The snapshot is older than the known state.');
        }
        log.info('peer session reclaimed', {
          sessionId,
          connectionId: link.id,
          seq: snapshot.seq,
          missed: snapshot.seq - known.snapshot.seq,
        });
      }
      this.unwatch(known);
      known.owner = link;
      known.kind = link.client?.kind ?? known.kind;
      known.detachedAt = null;
      if (params.pid !== undefined) known.pid = params.pid;
      this.replace(known, snapshot);
      return { claim: known.claim };
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new ProtocolError('UNAVAILABLE', 'Too many published sessions.');
    }
    const session: PeerSession = {
      sessionId,
      owner: link,
      kind: link.client?.kind ?? 'other',
      claim: randomBytes(24).toString('hex'),
      pid: params.pid ?? null,
      snapshot,
      detachedAt: null,
      watch: null,
    };
    this.sessions.set(sessionId, session);
    this.opts.hub.openSession(sessionId, snapshot.seq);
    this.replace(session, snapshot);
    log.info('peer session registered', { sessionId, connectionId: link.id, seq: snapshot.seq });
    return { claim: session.claim };
  }

  /** La sesión, si es de esa conexión. */
  private owned(link: PeerHostLink, sessionId: string): PeerSession {
    const p = this.sessions.get(sessionId);
    if (!p) throw new ProtocolError('NOT_FOUND', 'Session not registered.');
    if (p.owner !== link) {
      throw new ProtocolError('FORBIDDEN', 'That session belongs to another host.');
    }
    return p;
  }

  publish(link: PeerHostLink, params: HostPublishParams): void {
    const p = this.owned(link, params.sessionId);
    const { sessionId } = p;
    if (params.snapshot) {
      if (params.snapshot.session.id !== sessionId) {
        throw invalid('snapshot', 'the snapshot of another session');
      }
      this.checkSnapshot(params.snapshot);
    }
    this.checkEvents(sessionId, params.events);

    // Continuidad, antes de aplicar nada: o entra el lote entero, o no entra.
    let last = params.snapshot ? params.snapshot.seq : p.snapshot.seq;
    for (const event of params.events) {
      if (!isStateEvent(event)) continue;
      if (event.seq <= last) continue; // repetido
      if (event.seq !== last + 1) {
        log.warn('gap in published events, snapshot required', {
          sessionId,
          expected: last + 1,
          received: event.seq,
        });
        throw new ProtocolError('STALE_STATE', 'Events are missing: publish a snapshot.', {
          reason: 'seq-gap',
        });
      }
      last = event.seq;
    }

    if (params.snapshot) this.replace(p, params.snapshot);
    let closed = false;
    const fresh: ProtocolEvent[] = [];
    for (const event of params.events) {
      if (isStateEvent(event) ? event.seq <= p.snapshot.seq : event.after < p.snapshot.seq) {
        continue;
      }
      p.snapshot = applySessionEvent(p.snapshot, event);
      this.opts.registry.apply(event);
      this.opts.pending?.apply(event);
      fresh.push(event);
      if (event.type === 'session.closed') {
        closed = true;
        break;
      }
    }
    this.opts.hub.ingest(sessionId, fresh);
    if (closed) {
      // El anfitrión la cerró y lo contó con su último evento: no hay más que decir.
      this.forget(p);
      log.info('peer session closed by its host', { sessionId });
    }
    this.opts.onActivity?.();
  }

  /** Baja sin `session.closed` (o repetida tras él, que no es un error). */
  unregister(link: PeerHostLink, sessionId: string): void {
    const p = this.sessions.get(sessionId);
    if (!p) return;
    if (p.owner !== link) {
      throw new ProtocolError('FORBIDDEN', 'That session belongs to another host.');
    }
    this.discard(p, 'unregistered');
  }

  /** Una foto del anfitrión sustituye lo que hubiera: la proyección y lo que ven los clientes. */
  private replace(p: PeerSession, snapshot: ProtocolSessionSnapshot): void {
    p.snapshot = snapshot;
    this.opts.pending?.sync(snapshot);
    this.announce(p);
  }

  /** El estado de la sesión cambió sin un evento del anfitrión: todos reciben la foto. */
  private announce(p: PeerSession): void {
    this.opts.registry.replace(this.view(p));
    this.opts.hub.resync(p.sessionId, p.snapshot.seq);
    this.opts.onActivity?.();
  }

  // ---------------------------------------------------------------------------
  // Desconexión del anfitrión
  // ---------------------------------------------------------------------------

  /** La conexión de un anfitrión terminó: sus sesiones quedan sin él, no cerradas. */
  disconnected(link: PeerHostLink): void {
    for (const p of this.sessions.values()) {
      if (p.owner !== link) continue;
      p.owner = null;
      p.detachedAt = this.now();
      log.info('peer session detached', {
        sessionId: p.sessionId,
        connectionId: link.id,
        seq: p.snapshot.seq,
      });
      this.announce(p);
      this.watch(p);
    }
  }

  /**
   * Una sesión sin anfitrión no se queda para siempre: se descarta en cuanto se
   * confirma que su proceso murió, o al pasar el plazo si no se puede saber.
   */
  private watch(p: PeerSession): void {
    this.unwatch(p);
    const check = (): void => {
      if (p.owner || this.sessions.get(p.sessionId) !== p) return this.unwatch(p);
      if (p.pid !== null && !this.isAlive(p.pid)) return this.discard(p, 'host-exit');
      const waited = this.now() - (p.detachedAt ?? this.now());
      if (this.detachedTtlMs > 0 && waited >= this.detachedTtlMs) this.discard(p, 'expired');
    };
    p.watch = setInterval(check, this.watchIntervalMs);
    p.watch.unref();
    // Un proceso que acaba de morir tarda un instante en dejar de existir.
    const soon = setTimeout(check, Math.min(250, this.watchIntervalMs));
    soon.unref();
  }

  private unwatch(p: PeerSession): void {
    if (p.watch) clearInterval(p.watch);
    p.watch = null;
  }

  /**
   * Descarta una sesión que no cerró su anfitrión. Los clientes reciben una
   * última foto con la sesión `closed`; su run, si lo había, queda `interrupted`.
   */
  private discard(p: PeerSession, reason: 'host-exit' | 'expired' | 'unregistered'): void {
    if (this.sessions.get(p.sessionId) !== p) return;
    const view = this.view(p);
    const final: ProtocolSessionSnapshot = {
      ...view,
      session: { ...view.session, state: 'closed', currentRunId: null },
    };
    this.opts.hub.endSession(p.sessionId, final);
    this.forget(p);
    this.opts.registry.remove(p.sessionId);
    this.opts.onActivity?.();
    log.info('peer session discarded', { sessionId: p.sessionId, reason });
  }

  private forget(p: PeerSession): void {
    this.unwatch(p);
    this.sessions.delete(p.sessionId);
    p.owner = null;
    // Lo que esa sesión tuviera pendiente de decisión deja de existir con ella.
    this.opts.pending?.forget(p.sessionId);
    this.opts.hub.closeSession(p.sessionId);
  }

  /** El daemon se apaga: se sueltan los temporizadores. Las sesiones siguen en sus procesos. */
  shutdown(): void {
    for (const p of this.sessions.values()) {
      this.unwatch(p);
      this.opts.pending?.forget(p.sessionId);
    }
    this.sessions.clear();
  }

  /** ¿Aloja esa conexión la sesión? */
  isHost(link: { id: number }, sessionId: string): boolean {
    return this.sessions.get(sessionId)?.owner?.id === link.id;
  }

  /** ¿Tiene la sesión a su anfitrión conectado? */
  connected(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.owner != null;
  }

  // ---------------------------------------------------------------------------
  // Control: se reenvía al anfitrión, que es quien decide
  // ---------------------------------------------------------------------------

  private async forward<M extends ForwardedMethod>(
    method: M,
    sessionId: string,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    const p = this.sessions.get(sessionId);
    if (!p) throw new ProtocolError('NOT_FOUND', 'Session not found.');
    const owner = p.owner;
    if (!owner) throw hostUnavailable();
    try {
      return await owner.request(method, params, { timeoutMs: this.controlTimeoutMs });
    } catch (err) {
      // Lo que contesta el anfitrión pasa con su código; su texto, no.
      if (err instanceof ProtocolError) {
        if (err.code === 'STALE_STATE') {
          throw new ProtocolError('STALE_STATE', 'That run is no longer the current one.');
        }
        // Una decisión: el anfitrión dice si llegó otro antes o si no vale.
        if (err.code === 'ALREADY_RESOLVED') {
          const how = err.data?.resolution;
          throw new ProtocolError('ALREADY_RESOLVED', 'That request was already resolved.', {
            resolution: typeof how === 'string' ? how.slice(0, 32) : 'resolved',
          });
        }
        if (err.code === 'NOT_FOUND' && !RUN_CONTROL.has(method)) {
          throw new ProtocolError('NOT_FOUND', 'No such pending request.');
        }
        if (err.code === 'INVALID_PARAMS' && !RUN_CONTROL.has(method)) {
          throw new ProtocolError('INVALID_PARAMS', 'The host did not accept that answer.');
        }
        log.warn('host rejected a control request', { sessionId, method, code: err.code });
        throw new ProtocolError('UNAVAILABLE', 'The host of that session cannot do that.', {
          reason: 'host-unavailable',
        });
      }
      // Sin respuesta: no se sabe si llegó. No se simula un resultado.
      log.warn('host did not answer a control request', { sessionId, method });
      throw hostUnavailable();
    }
  }

  async cancel(sessionId: string, runId?: string): Promise<CancelStatus> {
    const result = await this.forward('host.cancel', sessionId, {
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
    });
    return result.status;
  }

  /**
   * Pausa y reanudación: las decide el runtime del anfitrión. Aquí no se toca
   * la proyección — pasará a `paused` cuando el anfitrión lo publique.
   */
  async pause(sessionId: string, runId?: string): Promise<PauseStatus> {
    const result = await this.forward('host.pause', sessionId, {
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
    });
    return result.status;
  }

  async resume(sessionId: string, runId?: string): Promise<ResumeStatus> {
    const result = await this.forward('host.resume', sessionId, {
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
    });
    return result.status;
  }

  async steer(sessionId: string, text: string): Promise<SteerStatus> {
    return (await this.forward('host.steer', sessionId, { sessionId, text })).status;
  }

  /**
   * Entrega una decisión al anfitrión de la sesión, que es quien tiene la
   * promesa que espera el runtime. Solo se da por resuelta si el anfitrión lo
   * confirma: sin él, o sin respuesta, `UNAVAILABLE` y nada cambia.
   */
  route(sessionId: string): {
    resolveApproval(
      id: string,
      decision: ProtocolApprovalDecision,
      phrase: string | undefined,
      by: ProtocolResolver,
    ): Promise<void>;
    answerQuestions(
      id: string,
      answers: ProtocolQuestionAnswer[] | null,
      by: ProtocolResolver,
    ): Promise<void>;
    decidePlan(
      id: string,
      decision: 'approve' | 'reject',
      plan: ProtocolPlan | undefined,
      by: ProtocolResolver,
    ): Promise<void>;
  } {
    return {
      resolveApproval: async (approvalId, decision, phrase, by) => {
        await this.forward('host.resolveApproval', sessionId, {
          sessionId,
          approvalId,
          decision,
          ...(phrase !== undefined ? { phrase } : {}),
          by,
        });
      },
      answerQuestions: async (requestId, answers, by) => {
        await this.forward('host.answerQuestions', sessionId, {
          sessionId,
          requestId,
          answers,
          by,
        });
      },
      decidePlan: async (requestId, decision, plan, by) => {
        await this.forward('host.decidePlan', sessionId, {
          sessionId,
          requestId,
          decision,
          ...(plan ? { plan } : {}),
          by,
        });
      },
    };
  }
}
