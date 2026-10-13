import { randomBytes } from 'crypto';
import type { AgentEvent } from '../agent/types.js';
import type { AgentObservation, AgentTurnKind, StratumAgent } from '../agent/core.js';
import type { StratumConfig } from '../config/schema.js';
import type { BackgroundJob } from '../jobs/types.js';
import { getDecisionMemory } from '../memory/decision-memory.js';
import {
  LIMITS,
  EMPTY_TRANSCRIPT,
  SNAPSHOT_LIMITS,
  applyTranscriptEvent,
  clipText,
  snapshotSubagent,
  snapshotToolCall,
  type ProtocolApproval,
  type ProtocolEvent,
  type ProtocolJob,
  type ProtocolPlan,
  type ProtocolPlanRequest,
  type ProtocolQuestionRequest,
  type ProtocolRun,
  type ProtocolSession,
  type ProtocolSessionHostInfo,
  type ProtocolSessionSnapshot,
  type ProtocolStateEvent,
  type ProtocolSubagent,
  type ProtocolTodo,
  type ProtocolToolCall,
  type ProtocolTranscript,
  type ProtocolVolatileEvent,
  type StateEventData,
  type StateEventType,
  type VolatileEventType,
} from '../protocol/index.js';
import { redactText } from '../security/redact-output.js';
import { targetOfCall } from '../tools/environments.js';
import { describeCall } from '../tools/registry.js';
import { getLogger } from '../logging/index.js';
import type { InteractionChange, PendingInteractions } from './interactions.js';

const log = getLogger('host').child('publisher');

/**
 * Quien recibe lo que publica una sesión: el bus de eventos de un daemon, o el
 * transporte de un anfitrión par. Se le llama **fuera** del turno del agente.
 */
export interface PublisherSink {
  /** Lote de eventos en orden. Los de estado, con `seq` consecutivo. */
  onEvents(events: ProtocolEvent[]): void;
  /**
   * La cola local se llenó y se descartaron eventos de estado: lo que llegue a
   * continuación tiene un hueco de `seq`. Quien recibe esto resincroniza con
   * `snapshot()`; no hay nada que reenviar.
   */
  onOverflow(): void;
}

/**
 * Lo que el publicador necesita de la sesión que publica. Un `SessionHost` lo
 * cumple tal cual; quien aún monta su sesión a mano (`chat`) lo da por piezas.
 */
export interface PublishedSession {
  readonly sessionId: string;
  readonly agent: StratumAgent;
  readonly config: StratumConfig;
  readonly env: { readonly cwd: string };
  /**
   * Las decisiones humanas pendientes de la sesión. Con ellas, el publicador
   * cuenta cada solicitud y su resolución como eventos de la sesión (con su
   * `seq`) y las lleva en la foto. No decide nada: solo las publica.
   */
  readonly interactions?: PendingInteractions;
}

export interface SessionPublisherOptions {
  host: PublishedSession;
  /** Dónde corre la sesión, tal como lo verán los clientes. */
  hostInfo: ProtocolSessionHostInfo;
  sink: PublisherSink;
  /** Eventos que esperan en la cola local antes de descartar. */
  maxQueue?: number;
  now?: () => number;
}

const DEFAULT_MAX_QUEUE = 4096;
/** Topes de lo que viaja en un DTO: el detalle completo está en la traza. */
const TITLE_CHARS = 80;
const INPUT_CHARS = 2_000;
const OUTPUT_CHARS = 8_000;
const TASK_CHARS = 1_000;
/** Texto de un fragmento volátil agrupado: muy por debajo del tope de una trama. */
const DELTA_CHARS = 32_000;
/** Lo que el snapshot conserva del bloque abierto. */
const PARTIAL_CHARS = SNAPSHOT_LIMITS.partialChars;
/** Tool calls y subagentes del run que se recuerdan. */
const RUN_ITEMS = 500;
// Un snapshot es **un** mensaje y tiene que caber de sobra en una trama: lleva
// las últimas llamadas y subagentes del run, con sus textos recortados
// (`SNAPSHOT_LIMITS`, en el protocolo: quien reduce eventos usa los mismos). El
// detalle completo viajó en los eventos y está en la traza.

const clip = clipText;

/**
 * Una foto es un solo mensaje del protocolo. Los límites por elemento la dejan
 * muy por debajo del tope con texto corriente, pero se cuentan en caracteres:
 * con un run enorme y texto de varios bytes por carácter podría pasarse, y una
 * foto que no cabe no llega nunca. Aquí se mide **en bytes** y, si hace falta,
 * se le quita lo menos valioso primero. Solo ocurre en el caso extremo; la
 * foto sigue siendo coherente con su `seq`, con menos detalle.
 */
export const SNAPSHOT_BYTE_BUDGET = 768 * 1024;

function bytesOf(snapshot: ProtocolSessionSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

export function fitSnapshot(
  snapshot: ProtocolSessionSnapshot,
  budget = SNAPSHOT_BYTE_BUDGET,
): ProtocolSessionSnapshot {
  // Atajo: ni en el peor escapado (6 bytes por carácter) se llega.
  let fit = snapshot;
  if (bytesOf(fit) <= budget) return fit;
  const steps: Array<(s: ProtocolSessionSnapshot) => ProtocolSessionSnapshot> = [
    (s) => ({ ...s, partial: { ...s.partial, reasoning: '' } }),
    (s) => ({
      ...s,
      toolCalls: s.toolCalls.map((c) => ({
        ...c,
        description: clipText(c.description, 200),
        ...(c.output !== undefined ? { output: clipText(c.output, 200) } : {}),
        ...(c.error !== undefined ? { error: clipText(c.error, 200) } : {}),
      })),
      subagents: s.subagents.map((a) => {
        const { filesChanged: _files, ...rest } = a;
        void _files;
        return {
          ...rest,
          ...(a.summary !== undefined ? { summary: clipText(a.summary, 200) } : {}),
        };
      }),
    }),
    (s) => ({ ...s, partial: { ...s.partial, text: clipText(s.partial.text, 20_000) } }),
  ];
  for (const step of steps) {
    fit = step(fit);
    if (bytesOf(fit) <= budget) return fit;
  }
  // Lo último: la conversación más antigua, y se dice.
  while (fit.messages.length > 1 && bytesOf(fit) > budget) {
    fit = {
      ...fit,
      messages: fit.messages.slice(Math.ceil(fit.messages.length / 2)),
      messagesTruncated: true,
    };
  }
  log.warn('snapshot over budget, detail dropped', { sessionId: fit.session.id });
  return fit;
}

function count(n: number | undefined): number {
  return Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;
}

function newRunId(): string {
  return `run_${randomBytes(8).toString('hex')}`;
}

interface TextScope {
  text: string;
  reasoning: string;
}

/**
 * Publica lo que ocurre en **una** sesión como eventos del Stratum Protocol, y
 * guarda el estado vivo del que sale un snapshot. Es la pieza que hay entre el
 * runtime y cualquier transporte, igual para una sesión alojada en el daemon
 * que para una de la CLI:
 *
 *   StratumAgent.observe()  →  [traducción + estado, síncrono]
 *                           →  cola local acotada
 *                           →  sink (asíncrono)
 *
 * Tres reglas:
 *
 *  1. **El `seq` es de aquí.** Lo asigna el anfitrión de la sesión, monótono y
 *     sin huecos desde 1, y nadie más lo cambia.
 *  2. **Observar no espera a nadie.** El observador traduce, actualiza el estado
 *     y encola; el sink se llama después, en otra vuelta del bucle de eventos.
 *     Si la cola se llena, lo volátil se descarta primero y, si aun así no
 *     cabe, se descarta todo y se avisa al sink de que resincronice. La memoria
 *     que ocupa está acotada pase lo que pase.
 *  3. **El snapshot es coherente con el `seq`.** `snapshot()` es el estado tras
 *     aplicar todos los eventos de estado hasta su `seq`, ni uno más ni uno
 *     menos: el estado se actualiza en el mismo paso síncrono que numera el
 *     evento.
 *
 * El runtime sigue siendo la autoridad: de aquí no sale ninguna decisión.
 */
export class SessionPublisher {
  private readonly host: PublishedSession;
  private readonly hostInfo: ProtocolSessionHostInfo;
  private readonly sink: PublisherSink;
  private readonly maxQueue: number;
  private readonly now: () => number;

  private seqValue = 0;
  private queue: ProtocolEvent[] = [];
  private overflowed = false;
  private flushScheduled = false;
  private started = false;
  private closed = false;
  private readonly detach: Array<() => void> = [];

  private readonly createdAt: number;
  private updatedAt: number;
  private title = '';
  private run: ProtocolRun | null = null;
  private runActive = false;
  private nextMode: ProtocolRun['mode'] = 'normal';
  private nextInput: string | null = null;
  private lastFatal: string | null = null;
  private readonly main: TextScope = { text: '', reasoning: '' };
  private readonly subText = new Map<string, TextScope>();
  private toolCalls = new Map<string, ProtocolToolCall>();
  private subagents = new Map<string, ProtocolSubagent>();
  private todos: ProtocolTodo[] = [];
  private approvals = new Map<string, ProtocolApproval>();
  private questions = new Map<string, ProtocolQuestionRequest>();
  private plans = new Map<string, ProtocolPlanRequest>();
  /** La conversación de la sesión: la misma función de los eventos que usa quien los reduce. */
  private transcript: ProtocolTranscript = EMPTY_TRANSCRIPT;

  constructor(opts: SessionPublisherOptions) {
    this.host = opts.host;
    this.hostInfo = opts.hostInfo;
    this.sink = opts.sink;
    this.maxQueue = Math.max(8, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
    this.now = opts.now ?? Date.now;
    this.createdAt = this.now();
    this.updatedAt = this.createdAt;
  }

  get sessionId(): string {
    return this.host.sessionId;
  }

  /** `seq` del último evento de estado emitido; `0` antes de `start()`. */
  get seq(): number {
    return this.seqValue;
  }

  /** El run en curso, o `null` entre turnos. */
  get activeRun(): ProtocolRun | null {
    return this.runActive && this.run ? { ...this.run, counters: { ...this.run.counters } } : null;
  }

  /** Eventos que esperan en la cola local (diagnóstico y tests). */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Empieza a publicar: emite `session.opened` (siempre `seq` 1) y se engancha
   * al agente, a sus jobs, a su inbox y a la memoria de decisiones.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    const agent = this.host.agent;
    this.state('session.opened', () => ({ session: this.session() }));

    this.detach.push(agent.observe((o) => this.guarded(() => this.onObservation(o))));
    if (agent.jobs) {
      this.detach.push(
        agent.jobs.subscribe((ev) =>
          this.guarded(() => {
            if (ev.type === 'created') return;
            if (ev.type === 'started' && this.run && this.runActive) this.run.counters.jobs++;
            this.state(ev.type === 'started' ? 'job.started' : 'job.ended', () => ({
              job: this.job(ev.job),
            }));
          }),
        ),
      );
    }
    this.detach.push(
      agent.inbox.subscribe((change) =>
        this.guarded(() => {
          if (change.type !== 'enqueued' || change.event.type !== 'user-message') return;
          const { id, text } = change.event;
          // Sin el texto: lo tiene quien lo envió.
          this.state('steering.queued', () => ({ id, chars: text.length }));
        }),
      ),
    );
    // La pausa es del runtime: aquí solo se cuenta. `paused` se publica cuando
    // el run ya no avanza (no cuando se pide), y deja de estarlo al reanudar.
    // El final del turno (`idle`) no se traduce: lo cierra `turn_ended`.
    this.detach.push(
      agent.pause.subscribe((state) =>
        this.guarded(() => {
          if (state !== 'idle') this.syncWaiting();
        }),
      ),
    );
    if (this.host.interactions) {
      this.detach.push(
        this.host.interactions.subscribe((change) =>
          this.guarded(() => this.onInteraction(change)),
        ),
      );
    }
    try {
      this.detach.push(
        getDecisionMemory(this.host.config).subscribe((ev) =>
          this.guarded(() => {
            // La memoria es compartida: solo cuentan los intentos de **esta**
            // sesión. `record` puede ser de otra (dedup); `attempt` no.
            if (ev.type !== 'saved' || ev.attempt?.sessionId !== this.sessionId) return;
            if (this.run && this.runActive) this.run.counters.memoryWrites++;
            const at = this.now();
            const { source } = ev.attempt;
            const decisions = [{ id: ev.record.id, title: ev.record.title }];
            this.state('memory.write', () => ({
              memory: {
                kind: 'write' as const,
                source,
                decisions,
                at,
                ...(this.runActive && this.run ? { runId: this.run.id } : {}),
              },
            }));
          }),
        ),
      );
    } catch (err) {
      log.warn('memory not observable', { sessionId: this.sessionId, err });
    }
  }

  /**
   * Lo que `observe()` no trae del próximo run y sabe quien lo lanza: su modo, y
   * la entrada tal como la escribió el usuario (en modo plan, lo que llega al
   * agente es la plantilla del plan con la tarea dentro).
   */
  expectRun(next: { mode?: ProtocolRun['mode']; input?: string }): void {
    this.nextMode = next.mode ?? 'normal';
    this.nextInput = next.input ?? null;
  }

  /** Algo del resumen cambió fuera de un turno (modelo, perfil, read-only). */
  sessionChanged(): void {
    if (!this.started || this.closed) return;
    this.state('session.updated', () => ({ session: this.session() }));
  }

  /**
   * Último evento de la sesión. Se entrega al sink en el acto —no queda nada en
   * la cola— y se sueltan todos los enganches. Idempotente.
   */
  close(reason: StateEventData['session.closed']['reason']): void {
    if (!this.started || this.closed) return;
    if (this.runActive) this.endRun(this.run?.kind ?? 'run', 'cancelled');
    this.state('session.closed', () => ({ reason }));
    this.closed = true;
    for (const off of this.detach.splice(0)) {
      try {
        off();
      } catch {
        /* soltar un enganche no puede impedir el cierre */
      }
    }
    this.flush();
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  session(): ProtocolSession {
    const agent = this.host.agent;
    let context = { used: 0, max: 0, pct: 0, estimated: true };
    try {
      const usage = agent.getContextUsage();
      context = {
        used: count(usage.used),
        max: count(usage.max),
        pct: Number.isFinite(usage.pct) && usage.pct > 0 ? usage.pct : 0,
        estimated: usage.estimated,
      };
    } catch {
      /* sin medida: se queda en cero y estimado */
    }
    const tokens = agent.getTokenUsage();
    const active = agent.getActiveContext();
    return {
      id: this.sessionId,
      title: this.title,
      cwd: this.host.env.cwd,
      host: this.hostInfo,
      state: this.closed
        ? 'closed'
        : !this.runActive
          ? 'idle'
          : this.paused()
            ? 'paused'
            : this.pendingCount() > 0
              ? 'waiting'
              : 'running',
      agent: agent.getActiveProfile()?.name ?? 'general',
      provider: agent.providerName,
      model: agent.model,
      sessionProfile: agent.getSessionProfile()?.name ?? agent.getSessionProfileRequest(),
      readOnly: agent.isReadOnly(),
      activeTarget: active.target,
      ...(active.environment
        ? { environment: { name: active.environment.name, tier: active.environment.tier } }
        : {}),
      context,
      tokens: {
        total: tokens.status === 'reported' ? count(tokens.tokens) : null,
        status: tokens.status,
      },
      currentRunId: this.runActive && this.run ? this.run.id : null,
      seq: this.seqValue,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Foto de la sesión: el estado **después** de aplicar todos los eventos de
   * estado hasta `seq`, incluido ese. Quien la recibe sustituye lo que tuviera
   * y sigue desde `seq + 1`.
   */
  snapshot(): ProtocolSessionSnapshot {
    const jobs = this.host.agent.jobs?.list().map((j) => this.job(j)) ?? [];
    return fitSnapshot({
      session: this.session(),
      seq: this.seqValue,
      run: this.run ? { ...this.run, counters: { ...this.run.counters } } : null,
      partial: { text: this.main.text, reasoning: this.main.reasoning },
      toolCalls: [...this.toolCalls.values()]
        .slice(-SNAPSHOT_LIMITS.toolCalls)
        .map(snapshotToolCall),
      subagents: [...this.subagents.values()]
        .slice(-SNAPSHOT_LIMITS.subagents)
        .map(snapshotSubagent),
      todos: this.todos.map((t) => ({ ...t })),
      jobs,
      approvals: [...this.approvals.values()].map((a) => ({ ...a })),
      questions: [...this.questions.values()].map((q) => ({ ...q })),
      plans: [...this.plans.values()].map((p) => ({ ...p })),
      messages: this.transcript.messages.map((m) => ({ ...m })),
      messagesTruncated: this.transcript.messagesTruncated,
    });
  }

  // ---------------------------------------------------------------------------
  // Decisiones humanas pendientes
  // ---------------------------------------------------------------------------

  private pendingCount(): number {
    return this.approvals.size + this.questions.size + this.plans.size;
  }

  /**
   * Una solicitud se abrió o se resolvió. Aquí solo se **cuenta**: quién gana lo
   * decide `PendingInteractions`. Lo que viaja es lo que una persona necesita
   * para decidir, ya redactado: nunca los parámetros crudos de la tool.
   */
  private onInteraction(change: InteractionChange): void {
    const run = this.run;
    const { interaction } = change;
    if (change.type === 'requested') {
      if (!run || !this.runActive) {
        log.warn('interaction outside a run, not published', { kind: interaction.kind });
        return;
      }
      const base = {
        id: interaction.id,
        sessionId: this.sessionId,
        runId: run.id,
        requestedAt: interaction.requestedAt,
        expiresAt: interaction.expiresAt,
      };
      if (interaction.kind === 'approval') {
        const { request } = interaction;
        const approval: ProtocolApproval = {
          ...base,
          kind: 'tool',
          tool: request.toolName,
          description: clip(this.redact(request.description), INPUT_CHARS),
          ...(request.target ? { target: request.target } : {}),
          ...(request.environment
            ? { environment: { name: request.environment.name, tier: request.environment.tier } }
            : {}),
          forced: request.forced === true,
          ...(request.confirmPhrase !== undefined ? { confirmPhrase: request.confirmPhrase } : {}),
          resolvable: 'anywhere',
          status: 'pending',
        };
        this.approvals.set(approval.id, approval);
        this.state('approval.requested', () => ({ approval: { ...approval } }));
      } else if (interaction.kind === 'question') {
        const request: ProtocolQuestionRequest = {
          ...base,
          questions: interaction.questions.map((q) => ({
            question: clip(this.redact(q.question), LIMITS.answerChars),
            ...(q.options
              ? { options: q.options.map((o) => ({ id: o.id, label: this.redact(o.label) })) }
              : {}),
            ...(q.allowCustom ? { allowCustom: true } : {}),
          })),
        };
        this.questions.set(request.id, request);
        this.state('question.requested', () => ({ request: { ...request } }));
      } else {
        const request: ProtocolPlanRequest = { ...base, plan: this.plan(interaction.plan) };
        this.plans.set(request.id, request);
        this.state('plan.proposed', () => ({ request: { ...request } }));
      }
      this.syncWaiting();
      return;
    }

    const { outcome } = change;
    const resolvedBy = outcome.by ? { resolvedBy: outcome.by } : {};
    if (outcome.kind === 'approval') {
      if (!this.approvals.delete(interaction.id)) return;
      const status =
        outcome.status !== 'resolved'
          ? outcome.status
          : outcome.decision === 'deny'
            ? 'denied'
            : 'approved';
      this.state('approval.resolved', () => ({
        approvalId: interaction.id,
        status,
        decision: outcome.decision,
        ...resolvedBy,
      }));
    } else if (outcome.kind === 'question') {
      if (!this.questions.delete(interaction.id)) return;
      const answers =
        outcome.answers?.map((a) => ({
          question: clip(this.redact(a.question), LIMITS.answerChars),
          answer: clip(this.redact(a.answer), LIMITS.answerChars),
          ...(a.optionId ? { optionId: a.optionId } : {}),
        })) ?? null;
      this.state('question.resolved', () => ({
        requestId: interaction.id,
        answers,
        status: outcome.status,
        ...resolvedBy,
      }));
    } else {
      if (!this.plans.delete(interaction.id)) return;
      const { decision } = outcome;
      this.state('plan.resolved', () => ({
        requestId: interaction.id,
        decision: decision.decision,
        ...(decision.decision === 'approve' ? { plan: this.plan(decision.plan) } : {}),
        status: outcome.status,
        ...resolvedBy,
      }));
    }
    this.syncWaiting();
  }

  private plan(plan: { summary: string; steps: ProtocolPlan['steps'] }): ProtocolPlan {
    return {
      summary: clip(this.redact(plan.summary), LIMITS.planStepChars),
      steps: plan.steps.slice(0, LIMITS.planSteps).map((s) => ({
        id: s.id,
        title: clip(this.redact(s.title), LIMITS.planStepChars),
        ...(s.detail !== undefined
          ? { detail: clip(this.redact(s.detail), LIMITS.planStepChars) }
          : {}),
        status: s.status,
      })),
    };
  }

  /** ¿Está el run en pausa de verdad? Lo dice el runtime, no quien la pidió. */
  private paused(): boolean {
    return this.host.agent.pause.state === 'paused';
  }

  /**
   * El run espera a una persona, está en pausa, o deja de estarlo: `run.updated`
   * y el resumen. En pausa no hay nada del agente avanzando, así que gana a
   * cualquier otra espera.
   */
  private syncWaiting(): void {
    const run = this.run;
    if (!run || !this.runActive) return;
    const status: ProtocolRun['status'] = this.paused()
      ? 'paused'
      : this.approvals.size + this.plans.size > 0
        ? 'waiting_approval'
        : this.questions.size > 0
          ? 'waiting_input'
          : 'running';
    if (run.status === status) return;
    run.status = status;
    this.state('run.updated', () => ({ run: this.runCopy() }));
    this.state('session.updated', () => ({ session: this.session() }));
  }

  private job(job: BackgroundJob): ProtocolJob {
    return {
      id: job.id,
      sessionId: this.sessionId,
      command: job.command,
      cwd: job.cwd,
      status: job.status,
      ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
      startedAt: job.startedAt,
      ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      scope: job.owner.scope,
    };
  }

  private redact(text: string): string {
    return redactText(text, this.host.config);
  }

  // ---------------------------------------------------------------------------
  // Del runtime al protocolo
  // ---------------------------------------------------------------------------

  /** Un fallo al traducir se registra y se descarta: publicar no puede romper el turno. */
  private guarded(fn: () => void): void {
    if (this.closed) return;
    try {
      fn();
    } catch (err) {
      log.error('publish failed', { sessionId: this.sessionId, err });
    }
  }

  private onObservation(o: AgentObservation): void {
    if (o.type === 'turn_started') return this.startRun(o.kind, o.input);
    if (o.type === 'turn_ended') return this.endRun(o.kind, o.stopReason);
    this.onEvent(o.event, undefined);
  }

  private startRun(kind: AgentTurnKind, input: string): void {
    const text = this.redact(this.nextInput ?? input);
    this.nextInput = null;
    if (!this.title) this.title = clip(text.replace(/\s+/g, ' ').trim(), TITLE_CHARS);
    this.toolCalls = new Map();
    this.subagents = new Map();
    this.subText.clear();
    this.main.text = '';
    this.main.reasoning = '';
    this.lastFatal = null;
    this.run = {
      id: newRunId(),
      sessionId: this.sessionId,
      kind,
      input: clip(text, INPUT_CHARS),
      ...(text.length > INPUT_CHARS ? { inputTruncated: true } : {}),
      mode: this.nextMode,
      status: 'running',
      startedAt: this.now(),
      counters: {
        llmCalls: 0,
        toolCalls: 0,
        toolErrors: 0,
        blocked: 0,
        memoryReads: 0,
        memoryWrites: 0,
        subagents: 0,
        jobs: 0,
      },
    };
    this.nextMode = 'normal';
    this.runActive = true;
    this.state('run.started', () => ({ run: this.runCopy() }));
    this.state('session.updated', () => ({ session: this.session() }));
  }

  private endRun(_kind: AgentTurnKind, stopReason: string | null): void {
    if (!this.run || !this.runActive) return;
    for (const id of [...this.subText.keys()]) this.closeText(id);
    this.closeText(undefined);
    const run = this.run;
    run.endedAt = this.now();
    // Sin `done` el turno se abandonó o lanzó: no terminó, falló.
    const reason = (stopReason ?? 'error') as NonNullable<ProtocolRun['stopReason']>;
    run.stopReason = reason;
    const type: StateEventType =
      reason === 'cancelled'
        ? 'run.cancelled'
        : reason === 'error'
          ? 'run.failed'
          : 'run.completed';
    run.status = reason === 'cancelled' ? 'cancelled' : reason === 'error' ? 'failed' : 'completed';
    if (run.status === 'failed') {
      run.error = clip(this.lastFatal ?? 'The turn ended without a result.', INPUT_CHARS);
    }
    // El evento de cierre va **dentro** del run; la sesión pasa a `idle` después.
    this.state(type as 'run.completed', () => ({ run: this.runCopy() }));
    this.runActive = false;
    this.state('session.updated', () => ({ session: this.session() }));
  }

  private runCopy(): ProtocolRun {
    const run = this.run!;
    return { ...run, counters: { ...run.counters } };
  }

  private textScope(subagentId: string | undefined): TextScope {
    if (!subagentId) return this.main;
    let scope = this.subText.get(subagentId);
    if (!scope) this.subText.set(subagentId, (scope = { text: '', reasoning: '' }));
    return scope;
  }

  /** Cierra el bloque de texto abierto con un `message.completed` que lo trae entero. */
  private closeText(subagentId: string | undefined): void {
    const scope = this.textScope(subagentId);
    const text = scope.text;
    scope.text = '';
    scope.reasoning = '';
    if (subagentId) this.subText.delete(subagentId);
    if (text) this.state('message.completed', () => ({ text }), subagentId);
  }

  private onEvent(event: AgentEvent, subagentId: string | undefined): void {
    const run = this.run;
    if (!run || !this.runActive) return;
    switch (event.type) {
      case 'text_delta': {
        const scope = this.textScope(subagentId);
        if (scope.text.length < PARTIAL_CHARS) scope.text += event.delta;
        this.volatile('message.delta', event.delta, subagentId);
        return;
      }
      case 'thinking': {
        const scope = this.textScope(subagentId);
        if (scope.reasoning.length < PARTIAL_CHARS) scope.reasoning += event.text;
        this.volatile('reasoning.delta', event.text, subagentId);
        return;
      }
      case 'tool_call_start':
        // Empieza una tool: el bloque de texto anterior está cerrado. La llamada
        // se anuncia cuando se conocen sus argumentos (`tool_call_ready`).
        this.closeText(subagentId);
        return;
      case 'tool_call_ready': {
        this.closeText(subagentId);
        const call = this.toolCall(event.id, event.name, subagentId);
        call.state = 'running';
        call.description = clip(
          this.redact(describeCall({ id: event.id, name: event.name, input: event.input })),
          INPUT_CHARS,
        );
        const target = safeTarget(event.name, event.input);
        if (target) call.target = target;
        run.counters.toolCalls++;
        this.state('tool.started', () => ({ call: { ...call } }), subagentId);
        return;
      }
      case 'tool_result': {
        const call = this.toolCall(event.id, event.name, subagentId);
        call.state = 'completed';
        call.output = clip(this.redact(event.result), OUTPUT_CHARS);
        call.durationMs = count(event.durationMs);
        this.state('tool.completed', () => ({ call: { ...call } }), subagentId);
        return;
      }
      case 'tool_error': {
        const call = this.toolCall(event.id, event.name, subagentId);
        call.state = 'error';
        call.error = clip(this.redact(event.error), OUTPUT_CHARS);
        run.counters.toolErrors++;
        this.state(
          'tool.failed',
          () => ({ call: { ...call }, recoverable: event.recoverable }),
          subagentId,
        );
        return;
      }
      case 'memory_retrieved': {
        run.counters.memoryReads++;
        const at = this.now();
        const decisions = event.decisions.map((d) => ({ id: d.id, title: d.title }));
        this.state(
          'memory.read',
          () => ({
            memory: {
              kind: 'read' as const,
              source: 'tool' as const,
              decisions,
              runId: run.id,
              at,
            },
          }),
          subagentId,
        );
        return;
      }
      case 'context_compressed':
        this.state(
          'context.compressed',
          () => ({
            tokensBefore: count(event.tokensBefore),
            tokensAfter: count(event.tokensAfter),
            roundsCompressed: count(event.roundsCompressed),
          }),
          subagentId,
        );
        return;
      case 'todo_updated':
        this.todos = event.items.map((t) => ({ id: t.id, title: t.title, status: t.status }));
        this.state('todo.updated', () => ({
          items: this.todos.map((t) => ({ ...t })),
          stale: count(event.stale),
        }));
        return;
      case 'plan_step_update':
        this.state('plan.step_updated', () => ({ stepId: event.stepId, status: event.status }));
        return;
      case 'subagent_started': {
        run.counters.subagents++;
        const subagent: ProtocolSubagent = {
          id: event.subagentId,
          runId: run.id,
          profile: event.profile,
          task: clip(this.redact(event.task), TASK_CHARS),
          status: 'running',
        };
        this.remember(this.subagents, subagent.id, subagent);
        this.state('subagent.started', () => ({ subagent: { ...subagent } }));
        return;
      }
      case 'subagent_completed': {
        this.closeText(event.subagentId);
        const known = this.subagents.get(event.subagentId);
        const { result } = event;
        const subagent: ProtocolSubagent = {
          id: event.subagentId,
          runId: run.id,
          profile: known?.profile ?? '',
          task: known?.task ?? '',
          status: result.status,
          summary: clip(this.redact(result.summary), OUTPUT_CHARS),
          filesChanged: result.filesChanged.map((f) => ({ path: f.path, action: f.action })),
          iterations: count(result.usage.iterations),
          durationMs: count(result.usage.durationMs),
          ...(result.error ? { error: clip(this.redact(result.error), INPUT_CHARS) } : {}),
        };
        this.remember(this.subagents, subagent.id, subagent);
        this.state('subagent.completed', () => ({ subagent: { ...subagent } }));
        return;
      }
      case 'subagent_event':
        // Profundidad 1: el evento de un hijo nunca es a su vez de un nieto.
        if (event.event.type !== 'subagent_event') this.onEvent(event.event, event.subagentId);
        return;
      case 'runtime_updates':
        // Lo entregado abre otra petición al modelo: lo que llevaba escrito es
        // un bloque terminado, no el principio del siguiente.
        this.closeText(subagentId);
        this.state('steering.delivered', () => ({
          ids: event.userMessages.map((m) => m.id),
          jobs: count(event.jobs),
        }));
        return;
      case 'warning':
        this.state('warning', () => ({ message: clip(this.redact(event.message), INPUT_CHARS) }));
        return;
      case 'error': {
        const message = clip(this.redact(event.message), INPUT_CHARS);
        if (event.fatal && !subagentId) this.lastFatal = message;
        this.state('error', () => ({ message, fatal: event.fatal }), subagentId);
        return;
      }
      // El final del turno llega por `turn_ended`, que también cubre el turno
      // abandonado. Planes y preguntas son solicitudes pendientes de una
      // decisión: se publican cuando se abren y se resuelven (`onInteraction`).
      case 'done':
      case 'plan_proposed':
      case 'questions_asked':
      case 'questions_answered':
      case 'subagent_progress':
      case 'job_notice':
        return;
    }
  }

  private toolCall(id: string, name: string, subagentId: string | undefined): ProtocolToolCall {
    const key = `${subagentId ?? ''}:${id}`;
    let call = this.toolCalls.get(key);
    // Un id ya cerrado que vuelve a aparecer es otra llamada (los ids del modelo se repiten).
    if (!call || call.state === 'completed' || call.state === 'error') {
      call = {
        id,
        runId: this.run!.id,
        ...(subagentId ? { subagentId } : {}),
        name,
        state: 'pending',
        description: name,
        startedAt: this.now(),
      };
      this.remember(this.toolCalls, key, call);
    }
    return call;
  }

  /** Guarda en un mapa acotado: al pasarse, se olvida lo más antiguo. */
  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > RUN_ITEMS) map.delete(map.keys().next().value as string);
  }

  // ---------------------------------------------------------------------------
  // Numeración y cola local
  // ---------------------------------------------------------------------------

  /**
   * Emite un evento de estado. Numera **antes** de construir los datos, para
   * que un `session` dentro del evento lleve el mismo `seq` que el evento.
   */
  private state<T extends StateEventType>(
    type: T,
    data: () => StateEventData[T],
    subagentId?: string,
  ): void {
    this.seqValue++;
    this.updatedAt = this.now();
    const event = {
      type,
      sessionId: this.sessionId,
      at: this.updatedAt,
      seq: this.seqValue,
      ...(this.runActive && this.run ? { runId: this.run.id } : {}),
      ...(subagentId ? { subagentId } : {}),
      data: data(),
    } as ProtocolStateEvent;
    this.transcript = applyTranscriptEvent(this.transcript, event);
    this.enqueue(event);
  }

  private volatile(type: VolatileEventType, text: string, subagentId?: string): void {
    if (!text) return;
    const runId = this.runActive && this.run ? this.run.id : undefined;
    // Agrupación: dos fragmentos seguidos del mismo bloque son uno más largo.
    const last = this.queue[this.queue.length - 1] as ProtocolVolatileEvent | undefined;
    if (
      last &&
      last.type === type &&
      last.after === this.seqValue &&
      last.subagentId === subagentId &&
      last.data.text.length + text.length <= DELTA_CHARS
    ) {
      last.data = { text: last.data.text + text };
      return;
    }
    this.enqueue({
      type,
      sessionId: this.sessionId,
      at: this.now(),
      after: this.seqValue,
      ...(runId ? { runId } : {}),
      ...(subagentId ? { subagentId } : {}),
      data: { text },
    } as ProtocolVolatileEvent);
  }

  private enqueue(event: ProtocolEvent): void {
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) {
      // Primero lo que se puede perder sin consecuencias.
      const before = this.queue.length;
      this.queue = this.queue.filter((e) => 'seq' in e);
      const dropped = before - this.queue.length;
      if (dropped > 0) {
        log.debug('volatile events dropped', { sessionId: this.sessionId, dropped });
      }
      if (this.queue.length > this.maxQueue) {
        // Ni así cabe: se pierde el tramo entero y el sink resincroniza.
        log.warn('local queue overflow, resync required', {
          sessionId: this.sessionId,
          dropped: this.queue.length,
        });
        this.queue = [];
        this.overflowed = true;
      }
    }
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  /** Entrega al sink lo que haya en la cola. Nunca lanza. */
  flush(): void {
    this.flushScheduled = false;
    const overflowed = this.overflowed;
    const events = this.queue;
    this.overflowed = false;
    this.queue = [];
    try {
      if (overflowed) this.sink.onOverflow();
      if (events.length > 0) this.sink.onEvents(events);
    } catch (err) {
      log.error('sink failed', { sessionId: this.sessionId, err });
    }
  }
}

function safeTarget(name: string, input: Record<string, unknown>): string | null {
  try {
    return targetOfCall(name, JSON.stringify(input));
  } catch {
    return null;
  }
}
