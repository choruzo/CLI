/**
 * Decisiones humanas pendientes de **una** sesión: aprobaciones, preguntas y
 * planes, con un único ciclo de vida y una única carrera.
 *
 *   runtime ── puerta ──▶ [pendiente] ◀── prompt local (terminal del anfitrión)
 *                              ▲      ◀── respuesta remota (vía el servidor)
 *                              │      ◀── plazo
 *                              └────── ◀── cancelación del turno / cierre
 *
 * El runtime solo espera la promesa de su puerta: no sabe quién contesta. Aquí
 * vive esa promesa, y por eso aquí se decide quién llegó primero:
 *
 *  - **Una solicitud se resuelve una vez.** `settle` comprueba y cambia el
 *    estado en el mismo paso síncrono; todo lo que llegue después —la otra
 *    superficie, un plazo, una segunda respuesta remota— no cambia nada, y a un
 *    cliente remoto se le contesta `ALREADY_RESOLVED`.
 *  - **Al resolverse se retiran las demás superficies**: la señal de la
 *    solicitud se aborta (el prompt local se cierra) y se avisa a quien escucha
 *    (el publicador, que lo cuenta a los clientes).
 *  - **No ejecuta nada.** Resuelve una promesa; quien ejecuta, o no, es el
 *    runtime que la esperaba.
 *
 * Es la misma pieza para una sesión alojada en el daemon (sin prompt local, con
 * plazo) y para una de la CLI (con su terminal, sin plazo).
 */
import { randomBytes } from 'crypto';
import type {
  ConfirmRequest,
  DestructiveDecision,
  Plan,
  PlanDecision,
  QuestionAnswer,
  QuestionItem,
} from '../agent/types.js';
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import {
  checkApprovalResolution,
  checkQuestionAnswers,
  type ClientKind,
  type ProtocolApprovalDecision,
  type ProtocolInteractionStatus,
  type ProtocolPlan,
  type ProtocolQuestionAnswer,
  type ProtocolResolver,
} from '../protocol/index.js';

const log = getLogger('host').child('interactions');

export type InteractionKind = 'approval' | 'question' | 'plan';

/** Lo que recibe un prompt local además de la solicitud. */
export interface GateContext {
  /** Id de la solicitud pendiente. */
  id: string;
  /**
   * Se aborta cuando la solicitud deja de estar pendiente por otra vía (la
   * resolvió otro cliente, caducó, se canceló el turno): el prompt debe
   * retirarse. Lo que devuelva después se ignora.
   */
  signal: AbortSignal;
}

/**
 * Las decisiones humanas de una sesión, como interfaz: quien aloja la sesión
 * dice cómo se contestan **en su proceso** (readline, Ink). Sin una puerta
 * local y sin nadie que pueda contestar en remoto, el runtime hace lo que ya
 * hacía sin callback: denegar la confirmación, seguir con supuestos, rechazar
 * el plan.
 */
export interface HostGates {
  /** Confirmación de una operación destructiva o forzada por una política. */
  confirm?: (req: ConfirmRequest, ctx?: GateContext) => Promise<DestructiveDecision>;
  /** Tanda de preguntas de la tool `question`. `null` = nadie contesta. */
  askQuestions?: (questions: QuestionItem[], ctx?: GateContext) => Promise<QuestionAnswer[] | null>;
  /** Aprobación de un plan (`present_plan`, o un entorno con `requirePlan`). */
  approvePlan?: (plan: Plan, ctx?: GateContext) => Promise<PlanDecision>;
}

interface Pending {
  id: string;
  requestedAt: number;
  /** `null` = no caduca (hay una persona delante del anfitrión). */
  expiresAt: number | null;
}

/** Una solicitud pendiente, con lo que pidió el runtime tal cual. */
export type PendingInteraction =
  | (Pending & { kind: 'approval'; request: ConfirmRequest })
  | (Pending & { kind: 'question'; questions: QuestionItem[] })
  | (Pending & { kind: 'plan'; plan: Plan });

interface Outcome {
  status: ProtocolInteractionStatus;
  /** Ausente si se canceló: no la resolvió nadie. */
  by?: ProtocolResolver;
}

/** Cómo terminó. `expired` y `cancelled` llevan siempre la respuesta negativa. */
export type InteractionOutcome =
  | (Outcome & { kind: 'approval'; decision: DestructiveDecision })
  | (Outcome & { kind: 'question'; answers: QuestionAnswer[] | null })
  | (Outcome & { kind: 'plan'; decision: PlanDecision });

export type InteractionChange =
  | { type: 'requested'; interaction: PendingInteraction }
  | { type: 'resolved'; interaction: PendingInteraction; outcome: InteractionOutcome };

/** El cliente remoto que contesta, tal como lo conoce el servidor. */
export interface RemoteResolver {
  client?: ClientKind;
  connectionId?: number;
}

export interface PendingInteractionsOptions {
  /** Prompts del proceso que aloja la sesión. */
  local?: HostGates;
  /**
   * Plazo de una solicitud que **no** tiene prompt local. `null` o `0` = sin
   * plazo. Con prompt local nunca caduca: nadie corta una operación porque la
   * persona tarde en leerla.
   */
  timeoutMs?: number | null;
  /** ¿Puede contestar ahora un cliente remoto? Sin esto, nunca. */
  remote?: () => boolean;
  now?: () => number;
}

type MakeOutcome<T> = (
  value: T,
  status: ProtocolInteractionStatus,
  by?: ProtocolResolver,
) => InteractionOutcome;

interface Entry<T = unknown> {
  interaction: PendingInteraction;
  settled: boolean;
  /** Se aborta al resolverse: retira el prompt local. */
  abort: AbortController;
  timer: NodeJS.Timeout | null;
  /** Lo que se devuelve al runtime si nadie contesta que sí. */
  negative: T;
  outcome: MakeOutcome<T>;
  finish: (value: T) => void;
  release: () => void;
}

const RECENT = 256;

function newId(kind: InteractionKind): string {
  const prefix = kind === 'approval' ? 'apr' : kind === 'question' ? 'qst' : 'pln';
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function invalid(path: string, message: string): ProtocolError {
  return new ProtocolError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

export class PendingInteractions {
  private local: HostGates;
  private remote: () => boolean;
  private readonly timeoutMs: number | null;
  private readonly now: () => number;
  // `Entry<any>`: cada entrada lleva su propio tipo de respuesta.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly entries = new Map<string, Entry<any>>();
  /** Solicitudes ya resueltas, para contestar `ALREADY_RESOLVED` y no `NOT_FOUND`. */
  private readonly recent = new Map<string, string>();
  private readonly listeners = new Set<(change: InteractionChange) => void>();

  constructor(opts: PendingInteractionsOptions = {}) {
    this.local = opts.local ?? {};
    this.remote = opts.remote ?? (() => false);
    this.timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : null;
    this.now = opts.now ?? Date.now;
  }

  /** Sustituye los prompts locales. No afecta a lo que ya está pendiente. */
  setLocal(gates: HostGates): void {
    this.local = gates;
  }

  setRemote(remote: () => boolean): void {
    this.remote = remote;
  }

  get size(): number {
    return this.entries.size;
  }

  pending(): PendingInteraction[] {
    return [...this.entries.values()].map((e) => e.interaction);
  }

  subscribe(listener: (change: InteractionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: InteractionChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        log.error('interaction listener failed', { err });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lado del runtime
  // ---------------------------------------------------------------------------

  /**
   * Las puertas que se le pasan al runtime para un turno. Cada una existe solo
   * si **alguien** puede contestarla —un prompt local o un cliente remoto—: sin
   * nadie, el runtime no pregunta (bloquea, sigue con supuestos o rechaza), que
   * es lo que hacía sin callback.
   *
   * `signal`: la cancelación del turno. Al abortarse, lo que ese turno tuviera
   * pendiente se cancela.
   */
  gatesFor(turn: { signal?: AbortSignal } = {}): HostGates {
    const remote = this.canResolveRemotely();
    const { signal } = turn;
    const { confirm, askQuestions, approvePlan } = this.local;
    return {
      ...(confirm || remote
        ? {
            confirm: (request) =>
              this.open<DestructiveDecision>(
                (base) => ({ ...base, kind: 'approval', request }),
                'deny',
                confirm ? (ctx) => confirm(request, ctx) : null,
                (decision, status, by) => ({ kind: 'approval', status, decision, by }),
                signal,
              ),
          }
        : {}),
      ...(askQuestions || remote
        ? {
            askQuestions: (questions) =>
              this.open<QuestionAnswer[] | null>(
                (base) => ({ ...base, kind: 'question', questions }),
                null,
                askQuestions ? (ctx) => askQuestions(questions, ctx) : null,
                (answers, status, by) => ({ kind: 'question', status, answers, by }),
                signal,
              ),
          }
        : {}),
      ...(approvePlan || remote
        ? {
            approvePlan: (plan) =>
              this.open<PlanDecision>(
                (base) => ({ ...base, kind: 'plan', plan }),
                { decision: 'reject' },
                approvePlan ? (ctx) => approvePlan(plan, ctx) : null,
                (decision, status, by) => ({ kind: 'plan', status, decision, by }),
                signal,
              ),
          }
        : {}),
    };
  }

  /** ¿Hay ahora un cliente remoto que pueda contestar? Nunca lanza. */
  canResolveRemotely(): boolean {
    try {
      return this.remote();
    } catch {
      return false;
    }
  }

  private open<T>(
    build: (base: Pending) => PendingInteraction,
    negative: T,
    local: ((ctx: GateContext) => Promise<T>) | null,
    outcome: MakeOutcome<T>,
    turnSignal: AbortSignal | undefined,
  ): Promise<T> {
    const requestedAt = this.now();
    // Solo caduca lo que nadie tiene delante.
    const expiresAt =
      local === null && this.timeoutMs !== null ? requestedAt + this.timeoutMs : null;
    const interaction = build({ id: '', requestedAt, expiresAt });
    interaction.id = newId(interaction.kind);

    let finish!: (value: T) => void;
    const promise = new Promise<T>((resolve) => (finish = resolve));
    const entry: Entry<T> = {
      interaction,
      settled: false,
      abort: new AbortController(),
      timer: null,
      negative,
      outcome,
      finish,
      release: () => undefined,
    };
    this.entries.set(interaction.id, entry);
    this.notify({ type: 'requested', interaction });

    // Las puertas se dieron cuando alguien podía contestar; si ya no puede
    // nadie, se resuelve sin preguntar y queda dicho quién lo decidió.
    if (local === null && !this.canResolveRemotely()) {
      this.settle(entry, negative, 'resolved', { kind: 'policy', at: this.now() });
      return promise;
    }
    if (turnSignal?.aborted) {
      this.settle(entry, negative, 'cancelled');
      return promise;
    }
    if (turnSignal) {
      const onAbort = (): void => void this.settle(entry, negative, 'cancelled');
      turnSignal.addEventListener('abort', onAbort, { once: true });
      entry.release = () => turnSignal.removeEventListener('abort', onAbort);
    }
    if (expiresAt !== null) {
      entry.timer = setTimeout(
        () => void this.settle(entry, negative, 'expired', { kind: 'timeout', at: this.now() }),
        Math.max(0, expiresAt - requestedAt),
      );
      entry.timer.unref();
    }
    if (local) {
      const ctx: GateContext = { id: interaction.id, signal: entry.abort.signal };
      // Un prompt que lanza es un «no», como ya lo trataba el dispatcher.
      void Promise.resolve()
        .then(() => local(ctx))
        .then(
          (value) => this.settle(entry, value, 'resolved', { kind: 'local', at: this.now() }),
          (err: unknown) => {
            log.warn('local gate failed', { kind: interaction.kind, err });
            this.settle(entry, negative, 'resolved', { kind: 'local', at: this.now() });
          },
        );
    }
    return promise;
  }

  /**
   * El único sitio donde una solicitud deja de estar pendiente. Comprobar y
   * cambiar el estado es un solo paso síncrono: de dos respuestas, la segunda
   * recibe `false` y no cambia nada.
   */
  private settle<T>(
    entry: Entry<T>,
    value: T,
    status: ProtocolInteractionStatus,
    by?: ProtocolResolver,
  ): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    const { interaction } = entry;
    this.entries.delete(interaction.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.release();
    this.recent.set(interaction.id, status);
    if (this.recent.size > RECENT) this.recent.delete(this.recent.keys().next().value as string);

    log.info('interaction resolved', {
      id: interaction.id,
      kind: interaction.kind,
      status,
      by: by?.kind ?? 'none',
      ...(by?.connectionId !== undefined ? { connectionId: by.connectionId } : {}),
    });
    // Primero el runtime; después las superficies, que solo se enteran.
    entry.finish(value);
    entry.abort.abort();
    this.notify({ type: 'resolved', interaction, outcome: entry.outcome(value, status, by) });
    return true;
  }

  /**
   * Cancela todo lo pendiente (cierre de la sesión). Cada puerta devuelve su
   * respuesta negativa: ninguna promesa queda colgada.
   */
  cancelAll(): void {
    for (const entry of [...this.entries.values()]) this.settle(entry, entry.negative, 'cancelled');
  }

  // ---------------------------------------------------------------------------
  // Lado remoto: lo que llega de otro cliente a través del servidor
  // ---------------------------------------------------------------------------

  private take<K extends InteractionKind, T>(
    id: string,
    kind: K,
  ): Entry<T> & { interaction: Extract<PendingInteraction, { kind: K }> } {
    const entry = this.entries.get(id);
    if (entry && entry.interaction.kind === kind) {
      return entry as Entry<T> & { interaction: Extract<PendingInteraction, { kind: K }> };
    }
    const how = this.recent.get(id);
    if (how !== undefined) {
      throw new ProtocolError('ALREADY_RESOLVED', 'That request was already resolved.', {
        resolution: how,
      });
    }
    throw new ProtocolError('NOT_FOUND', 'No such pending request.');
  }

  private remoteBy(by: RemoteResolver): ProtocolResolver {
    return {
      kind: 'remote',
      ...(by.client ? { client: by.client } : {}),
      ...(by.connectionId !== undefined ? { connectionId: by.connectionId } : {}),
      at: this.now(),
    };
  }

  /**
   * @throws ProtocolError `ALREADY_RESOLVED` si otro llegó antes; `NOT_FOUND`;
   *   `INVALID_PARAMS` si la respuesta no vale (la solicitud sigue pendiente).
   */
  resolveApproval(
    id: string,
    decision: ProtocolApprovalDecision,
    phrase: string | undefined,
    by: RemoteResolver,
  ): void {
    const entry = this.take<'approval', DestructiveDecision>(id, 'approval');
    const issue = checkApprovalResolution(entry.interaction.request, decision, phrase);
    if (issue) throw invalid(issue.path, issue.message);
    this.settle(entry, decision, 'resolved', this.remoteBy(by));
  }

  /** `answers: null` = omitir la tanda. */
  answerQuestions(id: string, answers: ProtocolQuestionAnswer[] | null, by: RemoteResolver): void {
    const entry = this.take<'question', QuestionAnswer[] | null>(id, 'question');
    const checked = checkQuestionAnswers(entry.interaction.questions, answers);
    if (!checked.ok) throw invalid(checked.issue.path, checked.issue.message);
    this.settle(entry, checked.answers, 'resolved', this.remoteBy(by));
  }

  /** Aprobar sin `plan` aprueba el propuesto; con él, la versión editada. */
  decidePlan(
    id: string,
    decision: 'approve' | 'reject',
    plan: ProtocolPlan | undefined,
    by: RemoteResolver,
  ): void {
    const entry = this.take<'plan', PlanDecision>(id, 'plan');
    if (decision === 'approve' && plan && plan.steps.length === 0) {
      throw invalid('plan.steps', 'an approved plan needs at least one step');
    }
    const value: PlanDecision =
      decision === 'approve'
        ? { decision: 'approve', plan: plan ?? entry.interaction.plan }
        : { decision: 'reject' };
    this.settle(entry, value, 'resolved', this.remoteBy(by));
  }
}
