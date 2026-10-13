/**
 * Centro de aprobaciones: el único sitio del daemon por el que un cliente
 * resuelve una aprobación, una pregunta o un plan, de cualquier sesión.
 *
 *   anfitrión de la sesión ── eventos ──▶ [pendientes]  ◀── approvals.list
 *                                              │
 *   cliente `approve` ── approvals.resolve ──▶ arbitraje ──▶ ruta de la sesión
 *                                                              ├─ alojada aquí: su `PendingInteractions`
 *                                                              └─ par: `host.resolveApproval` → su proceso
 *
 * Qué hace y qué no:
 *
 *  - **Arbitra, no ejecuta.** Entrega una decisión a quien espera; no conoce
 *    tools ni el dispatcher. Quien ejecuta, o no, es el runtime de la sesión.
 *  - **Gana la primera respuesta válida.** Los intentos sobre una misma
 *    solicitud van de uno en uno: mientras uno está en curso los demás esperan,
 *    y en cuanto uno se confirma el resto recibe `ALREADY_RESOLVED`.
 *  - **La promesa vive en el anfitrión**, y con ella la última palabra: su
 *    prompt local compite con lo que llegue de aquí y él dice quién llegó
 *    antes. Una solicitud solo deja de estar pendiente cuando el anfitrión lo
 *    confirma (la respuesta a la entrega, o su evento `*.resolved`). Si no
 *    contesta, no se inventa un resultado: `UNAVAILABLE`, y sigue pendiente.
 *  - **No numera.** Lo pendiente es una proyección de lo que publican los
 *    anfitriones; el evento de la resolución lo emite el anfitrión, con su `seq`.
 *  - **Ser anfitrión no da autoridad para aprobar.** Además de la capacidad
 *    `approve` (que comprueba `authorize.ts`), la conexión que aloja una sesión
 *    no puede resolver lo de esa sesión por esta vía: su vía es su prompt local.
 */
import { ProtocolError } from '../ipc/codec.js';
import { getLogger } from '../logging/index.js';
import {
  checkApprovalResolution,
  checkQuestionAnswers,
  type Capability,
  type ClientKind,
  type ProtocolApproval,
  type ProtocolApprovalDecision,
  type ProtocolEvent,
  type ProtocolPlan,
  type ProtocolPlanRequest,
  type ProtocolQuestionAnswer,
  type ProtocolQuestionRequest,
  type ProtocolResolver,
  type ProtocolSessionSnapshot,
} from '../protocol/index.js';

const log = getLogger('daemon').child('approvals');

/** Cómo llega una decisión a la sesión que la espera. La confirma su anfitrión. */
export interface InteractionRoute {
  resolveApproval(
    id: string,
    decision: ProtocolApprovalDecision,
    phrase: string | undefined,
    by: ProtocolResolver,
  ): void | Promise<void>;
  answerQuestions(
    id: string,
    answers: ProtocolQuestionAnswer[] | null,
    by: ProtocolResolver,
  ): void | Promise<void>;
  decidePlan(
    id: string,
    decision: 'approve' | 'reject',
    plan: ProtocolPlan | undefined,
    by: ProtocolResolver,
  ): void | Promise<void>;
}

/** Lo que el centro necesita saber de quien contesta. */
export interface ApproverLink {
  readonly id: number;
  readonly client: { kind: ClientKind; name: string } | null;
  readonly capabilities: readonly Capability[];
}

export type Resolution =
  | { kind: 'approval'; id: string; decision: ProtocolApprovalDecision; phrase?: string }
  | { kind: 'question'; id: string; answers: ProtocolQuestionAnswer[] | null }
  | { kind: 'plan'; id: string; decision: 'approve' | 'reject'; plan?: ProtocolPlan };

export interface ApprovalCenterOptions {
  /** La ruta hacia la sesión, o `null` si ahora no se le puede entregar nada. */
  routeOf: (sessionId: string) => InteractionRoute | null;
  /** ¿Es esa conexión la que aloja la sesión? */
  hostsSession: (link: ApproverLink, sessionId: string) => boolean;
  /** ¿Puede recibir algo la sesión ahora (su anfitrión está conectado)? */
  reachable: (sessionId: string) => boolean;
  now?: () => number;
}

type Entry =
  | { kind: 'approval'; sessionId: string; dto: ProtocolApproval; chain: Promise<void> }
  | { kind: 'question'; sessionId: string; dto: ProtocolQuestionRequest; chain: Promise<void> }
  | { kind: 'plan'; sessionId: string; dto: ProtocolPlanRequest; chain: Promise<void> };

const RECENT = 1_024;

function invalid(path: string, message: string): ProtocolError {
  return new ProtocolError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function alreadyResolved(resolution: string): ProtocolError {
  return new ProtocolError('ALREADY_RESOLVED', 'That request was already resolved.', {
    resolution,
  });
}

function hostUnavailable(): ProtocolError {
  return new ProtocolError(
    'UNAVAILABLE',
    'The host of that session is not connected: it can only be resolved there.',
    { reason: 'host-unavailable' },
  );
}

export class ApprovalCenter {
  private readonly pending = new Map<string, Entry>();
  /** Lo ya resuelto: para contestar `ALREADY_RESOLVED` y no volver a darlo por pendiente. */
  private readonly recent = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly opts: ApprovalCenterOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Solicitudes pendientes, de los tres tipos. */
  get count(): number {
    return this.pending.size;
  }

  // ---------------------------------------------------------------------------
  // Proyección: lo que cuentan los anfitriones
  // ---------------------------------------------------------------------------

  /**
   * Una solicitud es de la sesión que la abrió. Otra sesión no puede pisarla
   * publicando el mismo id, ni cerrarla: lo que no es suyo se ignora.
   */
  private add(entry: Entry): void {
    const { id } = entry.dto;
    if (this.recent.has(id)) return;
    const known = this.pending.get(id);
    if (known && known.sessionId !== entry.sessionId) {
      log.warn('pending request id already used by another session, ignored', {
        id,
        sessionId: entry.sessionId,
      });
      return;
    }
    if (entry.dto.sessionId !== entry.sessionId) return;
    this.pending.set(id, entry);
  }

  /** Cierra una solicitud **de esa sesión**. */
  private close(sessionId: string, id: string, resolution: string): void {
    const known = this.pending.get(id);
    // Solo se cierra lo que estaba pendiente y era de esa sesión. Un id ajeno,
    // ya resuelto o que nunca existió no cambia nada: ni lo pendiente ni el
    // recuerdo de cómo acabó cada solicitud.
    if (!known || known.sessionId !== sessionId) return;
    this.done(id, resolution);
  }

  private done(id: string, resolution: string): void {
    this.pending.delete(id);
    this.recent.delete(id);
    this.recent.set(id, resolution);
    if (this.recent.size > RECENT) this.recent.delete(this.recent.keys().next().value as string);
  }

  /** Un evento publicado por el anfitrión de una sesión. */
  apply(event: ProtocolEvent): void {
    const { sessionId } = event;
    const chain = Promise.resolve();
    switch (event.type) {
      case 'approval.requested':
        return this.add({ kind: 'approval', sessionId, dto: event.data.approval, chain });
      case 'question.requested':
        return this.add({ kind: 'question', sessionId, dto: event.data.request, chain });
      case 'plan.proposed':
        return this.add({ kind: 'plan', sessionId, dto: event.data.request, chain });
      case 'approval.resolved':
        return this.close(sessionId, event.data.approvalId, event.data.status);
      case 'question.resolved':
      case 'plan.resolved':
        return this.close(sessionId, event.data.requestId, event.data.status ?? 'resolved');
      default:
        return;
    }
  }

  /** Una foto del anfitrión: lo pendiente de esa sesión es lo que diga ella. */
  sync(snapshot: ProtocolSessionSnapshot): void {
    const sessionId = snapshot.session.id;
    const listed = new Set<string>();
    const chain = Promise.resolve();
    const keep = (entry: Entry): void => {
      const known = this.pending.get(entry.dto.id);
      // Un id que ya es de otra sesión no cuenta como de esta.
      if (known && known.sessionId !== sessionId) return;
      listed.add(entry.dto.id);
      if (!known) this.add(entry);
    };
    for (const dto of snapshot.approvals) keep({ kind: 'approval', sessionId, dto, chain });
    for (const dto of snapshot.questions) keep({ kind: 'question', sessionId, dto, chain });
    for (const dto of snapshot.plans) keep({ kind: 'plan', sessionId, dto, chain });
    // Lo que el anfitrión ya no cuenta dejó de estar pendiente sin que viésemos cómo.
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId === sessionId && !listed.has(entry.dto.id)) {
        this.done(entry.dto.id, 'resolved');
      }
    }
  }

  /** La sesión dejó de existir: nada suyo queda pendiente. */
  forget(sessionId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId === sessionId) this.done(entry.dto.id, 'cancelled');
    }
  }

  /**
   * Lo pendiente, tal como lo publicó cada anfitrión. Una aprobación de una
   * sesión cuyo anfitrión no está conectado sigue pendiente —no se resolvió—,
   * pero marcada `resolvable: 'origin'`: ahora solo se puede contestar allí.
   */
  list(sessionId?: string): {
    approvals: ProtocolApproval[];
    questions: ProtocolQuestionRequest[];
    plans: ProtocolPlanRequest[];
  } {
    const approvals: ProtocolApproval[] = [];
    const questions: ProtocolQuestionRequest[] = [];
    const plans: ProtocolPlanRequest[] = [];
    for (const entry of this.pending.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (entry.kind === 'approval') {
        approvals.push(
          this.opts.reachable(entry.sessionId) ? entry.dto : { ...entry.dto, resolvable: 'origin' },
        );
      } else if (entry.kind === 'question') questions.push(entry.dto);
      else plans.push(entry.dto);
    }
    return { approvals, questions, plans };
  }

  // ---------------------------------------------------------------------------
  // Arbitraje
  // ---------------------------------------------------------------------------

  private find(resolution: Resolution): Entry {
    const entry = this.pending.get(resolution.id);
    if (entry && entry.kind === resolution.kind) return entry;
    const how = this.recent.get(resolution.id);
    if (how !== undefined) throw alreadyResolved(how);
    throw new ProtocolError('NOT_FOUND', 'No such pending request.');
  }

  /**
   * Segunda barrera, detrás de la capacidad: quién **no** puede resolver esta
   * solicitud aunque tenga `approve`.
   */
  private authorize(link: ApproverLink, entry: Entry): void {
    // Lo comprueba ya `authorize.ts`; aquí por si alguien llega por otro camino.
    if (!link.capabilities.includes('approve')) {
      throw new ProtocolError('FORBIDDEN', 'Missing capability: approve.', {
        capability: 'approve',
      });
    }
    // Alojar una sesión no es autoridad sobre lo que esa sesión pide.
    if (link.capabilities.includes('host') || this.opts.hostsSession(link, entry.sessionId)) {
      log.warn('a host tried to resolve a pending request', {
        connectionId: link.id,
        sessionId: entry.sessionId,
        kind: entry.kind,
      });
      throw new ProtocolError('FORBIDDEN', 'A session host cannot resolve its own requests.', {
        capability: 'approve',
      });
    }
  }

  /** Lo que no puede valer no se entrega: la solicitud sigue pendiente. */
  private check(entry: Entry, resolution: Resolution): void {
    if (entry.kind === 'approval' && resolution.kind === 'approval') {
      const issue = checkApprovalResolution(entry.dto, resolution.decision, resolution.phrase);
      if (issue) throw invalid(issue.path, issue.message);
    } else if (entry.kind === 'question' && resolution.kind === 'question') {
      const checked = checkQuestionAnswers(entry.dto.questions, resolution.answers);
      if (!checked.ok) throw invalid(checked.issue.path, checked.issue.message);
    }
  }

  /**
   * Un cliente contesta una solicitud pendiente.
   *
   * @throws ProtocolError `NOT_FOUND`; `ALREADY_RESOLVED` si otro llegó antes;
   *   `FORBIDDEN`; `INVALID_PARAMS` si la respuesta no vale; `UNAVAILABLE` si
   *   el anfitrión de la sesión no está o no contesta (sigue pendiente).
   */
  resolve(link: ApproverLink, resolution: Resolution): Promise<void> {
    const entry = this.find(resolution);
    this.authorize(link, entry);
    this.check(entry, resolution);
    // De uno en uno por solicitud: el segundo espera a saber cómo acabó el primero.
    const attempt = entry.chain.then(() => this.deliver(link, entry, resolution));
    entry.chain = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  private async deliver(link: ApproverLink, entry: Entry, resolution: Resolution): Promise<void> {
    const { id } = entry.dto;
    if (this.pending.get(id) !== entry) throw alreadyResolved(this.recent.get(id) ?? 'resolved');
    const route = this.opts.routeOf(entry.sessionId);
    if (!route) throw hostUnavailable();

    const by: ProtocolResolver = {
      kind: 'remote',
      ...(link.client ? { client: link.client.kind } : {}),
      connectionId: link.id,
      at: this.now(),
    };
    let outcome: string;
    try {
      if (resolution.kind === 'approval') {
        await route.resolveApproval(id, resolution.decision, resolution.phrase, by);
        outcome = resolution.decision === 'deny' ? 'denied' : 'approved';
      } else if (resolution.kind === 'question') {
        await route.answerQuestions(id, resolution.answers, by);
        outcome = 'resolved';
      } else {
        await route.decidePlan(id, resolution.decision, resolution.plan, by);
        outcome = 'resolved';
      }
    } catch (err) {
      if (err instanceof ProtocolError && err.code === 'ALREADY_RESOLVED') {
        // El anfitrión dice que llegó otro antes (su prompt local): es la verdad.
        const how = typeof err.data?.resolution === 'string' ? err.data.resolution : 'resolved';
        this.done(id, how);
        throw alreadyResolved(how);
      }
      throw err;
    }
    this.done(id, outcome);
    // Rastro de quién resolvió qué. Sin la descripción, las respuestas ni la frase.
    log.info('pending request resolved', {
      id,
      kind: entry.kind,
      sessionId: entry.sessionId,
      outcome,
      ...(resolution.kind !== 'question' ? { decision: resolution.decision } : {}),
      connectionId: link.id,
      client: link.client?.kind,
      clientName: link.client?.name,
    });
  }
}
