/**
 * Una sesión alojada en el daemon: su `SessionHost`, su publicador y el turno
 * que tenga en curso. El daemon la **conduce** (lanza turnos y los consume),
 * pero la sesión se monta por la única vía que hay: `SessionHost.create`.
 *
 * Una sesión del daemon no tiene terminal: lo que pida a una persona —una
 * aprobación, una tanda de preguntas, la decisión de un plan— solo lo puede
 * contestar un cliente con la capacidad `approve`, a través del centro de
 * aprobaciones, y **caduca** a la respuesta negativa si nadie contesta. Si el
 * daemon no acredita aprobadores, no hay a quién preguntar y se comporta como
 * `stratum run` sin terminal: lo destructivo se deniega, las preguntas se
 * contestan con supuestos y un plan no se aprueba.
 */
import type { StratumConfig } from '../config/schema.js';
import { PLAN_MODE_PROMPT } from '../agent/plan.js';
import { ProtocolError } from '../ipc/codec.js';
import type { ProviderRouter } from '../providers/router.js';
import type {
  CancelStatus,
  PauseStatus,
  ProtocolJob,
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionSnapshot,
  ResumeStatus,
  StateEventData,
  SteerStatus,
} from '../protocol/index.js';
import type { SessionEnv } from '../runtime/session-env.js';
import { SessionHost } from '../host/session-host.js';
import { SessionPublisher, type PublisherSink } from '../host/session-publisher.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('daemon').child('session');

export interface HostedSessionOptions {
  sessionId: string;
  env: SessionEnv;
  config: StratumConfig;
  router: ProviderRouter;
  /** Versión de Stratum, para la cabecera de la traza. */
  version: string;
  sink: PublisherSink;
  readOnly?: boolean;
  sessionProfile?: string;
  /** Perfil de agente principal con el que arranca. */
  agent?: string;
  /** ¿Hay quien pueda resolver en remoto lo que la sesión pida? */
  remoteApprovals: () => boolean;
  /** Plazo de una solicitud sin contestar. `0` = sin plazo. */
  approvalTimeoutMs: number;
}

/** Cuánto se espera a que un turno cancelado termine de cerrarse. */
const RUN_SETTLE_MS = 10_000;

export class HostedSession {
  private pump: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  private constructor(
    readonly host: SessionHost,
    readonly publisher: SessionPublisher,
  ) {}

  /**
   * Monta la sesión. Aún no publica nada: `publisher.start()` lo llama quien la
   * registra, cuando ya hay dónde recibir sus eventos.
   *
   * @throws ProtocolError `INVALID_PARAMS` si el perfil de agente no vale.
   */
  static async open(opts: HostedSessionOptions): Promise<HostedSession> {
    const host = await SessionHost.create({
      env: opts.env,
      config: opts.config,
      router: opts.router,
      sessionId: opts.sessionId,
      version: opts.version,
      mcp: 'eager',
      // Sin prompts locales: pregunta solo si un aprobador remoto puede contestar.
      // Sin aprobadores acreditados no hay a quién preguntar, y la política es
      // la de una sesión sin terminal: denegar (también en un entorno `allow`).
      destructivePolicy: opts.remoteApprovals() ? 'ask' : 'deny',
      remoteApprovals: opts.remoteApprovals,
      interactionTimeoutMs: opts.approvalTimeoutMs,
      agent: {
        readOnly: opts.readOnly === true,
        ...(opts.sessionProfile ? { sessionProfile: opts.sessionProfile } : {}),
      },
    });
    for (const warning of host.mcpWarnings) {
      log.warn('mcp warning', { sessionId: host.sessionId, message: warning.message });
    }
    if (opts.agent) {
      const applied = host.agent.setPrimaryProfile(opts.agent);
      if (!applied.ok) {
        await host.dispose({ cancelBackground: true });
        throw new ProtocolError('INVALID_PARAMS', applied.error, {
          issues: [{ path: 'agent', message: 'unknown or unusable agent profile' }],
        });
      }
    }
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'daemon', client: 'daemon', connected: true },
      sink: opts.sink,
    });
    return new HostedSession(host, publisher);
  }

  get sessionId(): string {
    return this.host.sessionId;
  }

  get running(): boolean {
    return this.pump !== null;
  }

  session(): ProtocolSession {
    return this.publisher.session();
  }

  snapshot(): ProtocolSessionSnapshot {
    return this.publisher.snapshot();
  }

  jobs(): ProtocolJob[] {
    return this.publisher.snapshot().jobs;
  }

  /**
   * Lanza un turno y devuelve su run en cuanto existe; el turno sigue por su
   * cuenta y se sigue por eventos.
   *
   * @throws ProtocolError `BUSY` si ya hay uno en curso.
   */
  startRun(input: string, mode: 'normal' | 'plan' = 'normal'): ProtocolRun {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.pump) throw new ProtocolError('BUSY', 'The session already has a run in progress.');

    this.publisher.expectRun({ mode, input });
    const turn = this.host.run(
      mode === 'plan' ? PLAN_MODE_PROMPT.replaceAll('$ARGUMENTS', input) : input,
      mode === 'plan' ? { mode: 'plan' } : {},
    );
    // El arranque del turno es síncrono hasta su primera espera: al volver de
    // `next()`, el publicador ya ha visto `turn_started` y el run existe.
    const first = turn.next();
    const pump = (async () => {
      try {
        let step = await first;
        while (!step.done) step = await turn.next();
      } catch (err) {
        log.error('run failed', { sessionId: this.sessionId, err });
      } finally {
        this.pump = null;
        // El cierre del run sale ya, no en la siguiente vuelta.
        this.publisher.flush();
      }
    })();
    this.pump = pump;

    const run = this.publisher.activeRun;
    if (!run) throw new Error('the turn did not start');
    this.publisher.flush();
    return run;
  }

  /**
   * Cancela el turno en curso. Con `runId`, solo si sigue siendo ese.
   *
   * @throws ProtocolError `STALE_STATE` si `runId` ya no es el run en curso.
   */
  cancel(runId?: string): CancelStatus {
    if (!this.current(runId)) return 'not-running';
    this.host.cancel();
    return 'cancelled';
  }

  /** El run en curso; con `runId`, tiene que seguir siendo ese. */
  private current(runId: string | undefined): ProtocolRun | null {
    const active = this.publisher.activeRun;
    if (runId !== undefined && active?.id !== runId) {
      throw new ProtocolError('STALE_STATE', 'That run is no longer the current one.');
    }
    return active;
  }

  /**
   * Pausa cooperativa del turno en curso. No espera a que se alcance: el run
   * pasa a `paused` —y la sesión lo publica— en su siguiente punto seguro.
   *
   * @throws ProtocolError `STALE_STATE` si `runId` ya no es el run en curso.
   */
  pause(runId?: string): PauseStatus {
    if (!this.current(runId)) return 'not-running';
    return this.host.pause();
  }

  /** Retira la pausa: el mismo run continúa. */
  resume(runId?: string): ResumeStatus {
    if (!this.current(runId)) return 'not-running';
    return this.host.resume();
  }

  steer(text: string): SteerStatus {
    return this.host.steer(text).status;
  }

  private assertIdle(): void {
    if (this.closing) throw new ProtocolError('UNAVAILABLE', 'Session is closing.');
    if (this.pump) throw new ProtocolError('BUSY', 'Not while a run is in progress.');
  }

  private changed(): ProtocolSession {
    this.publisher.sessionChanged();
    this.publisher.flush();
    return this.publisher.session();
  }

  setModel(model: string): ProtocolSession {
    this.assertIdle();
    this.host.agent.switchModel(model);
    return this.changed();
  }

  setAgent(agent: string | null): ProtocolSession {
    this.assertIdle();
    const applied = this.host.agent.setPrimaryProfile(agent);
    if (!applied.ok) {
      throw new ProtocolError('INVALID_PARAMS', applied.error, {
        issues: [{ path: 'agent', message: 'unknown or unusable agent profile' }],
      });
    }
    return this.changed();
  }

  setReadOnly(readOnly: boolean): ProtocolSession {
    this.assertIdle();
    this.host.agent.setReadOnly(readOnly);
    return this.changed();
  }

  async cancelJob(jobId: string): Promise<void> {
    const jobs = this.host.agent.jobs;
    if (!jobs?.get(jobId)) throw new ProtocolError('NOT_FOUND', 'Job not found.');
    await jobs.cancel(jobId);
  }

  /**
   * Cierra **esta** sesión: cancela su turno, desmonta su anfitrión
   * (`SessionHost.dispose()`: sus servers MCP, sus jobs, su SSH, su auditoría,
   * su traza) y publica `session.closed` como último evento. No toca nada de
   * otra sesión ni del proceso. Idempotente.
   */
  close(reason: StateEventData['session.closed']['reason']): Promise<void> {
    this.closing ??= (async () => {
      this.host.cancel();
      const pump = this.pump;
      if (pump) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          pump,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, RUN_SETTLE_MS);
            timer.unref();
          }),
        ]);
        clearTimeout(timer);
      }
      // Antes de despedirse: los jobs que se cancelan al desmontar aún se publican.
      await this.host.dispose({ cancelBackground: true });
      this.publisher.close(reason);
    })();
    return this.closing;
  }
}
