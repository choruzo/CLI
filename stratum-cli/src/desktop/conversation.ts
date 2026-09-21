import type { StratumConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import { StratumAgent } from '../agent/core.js';
import type {
  ConfirmRequest,
  DestructiveDecision,
  Message,
  QuestionAnswer,
  QuestionItem,
} from '../agent/types.js';
import { getLogger } from '../logging/index.js';
import { buildAssistantRegistry } from './assistant-runtime.js';
import type { DesktopSessionStore } from './session-store.js';
import type { ConversationOutboundFrame, TurnEndedFrame } from './protocol.js';

const log = getLogger('desktop.conversation');

/** Sin respuesta a una confirmación en este plazo → `deny` (15.4). */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
/** Sin respuesta a una tanda de preguntas → `null`: el agente sigue con supuestos. */
export const QUESTIONS_TIMEOUT_MS = 10 * 60_000;
/** Lo que `close` espera a que un turno abortado termine antes de guardar igualmente. */
export const CLOSE_GRACE_MS = 5_000;

type StopReason = TurnEndedFrame['stopReason'];

export interface ConversationSessionOptions {
  conversationId: string;
  config: StratumConfig;
  router: ProviderRouter;
  store: DesktopSessionStore;
  /** Salida hacia el cliente activo. Si no hay cliente, la trama se pierde. */
  send: (frame: ConversationOutboundFrame) => void;
  /** Historial de una sesión guardada (rehidratación tras reinicio, 15.5). */
  initialMessages?: Message[];
  createdAt?: string;
  confirmTimeoutMs?: number;
  questionsTimeoutMs?: number;
  closeGraceMs?: number;
}

interface Pending<T> {
  resolve: (value: T) => void;
}

interface Turn {
  turnId: string;
  abort: AbortController;
  task: Promise<void>;
}

/**
 * Una conversación del modo Chat: su agente (preset `assistant`), su registry,
 * su router y el turno en curso. Invariantes:
 * - como mucho un turno a la vez; un `chat` durante un turno se rechaza;
 * - el turno es una única tarea que **siempre** termina en `turn_ended`, libera
 *   el estado y guarda la sesión, también si el agente lanza;
 * - ninguna espera (confirmación, preguntas) sobrevive al turno: abort,
 *   timeout, cierre o desconexión la resuelven con `deny` / `null`;
 * - un solo escritor: la sesión se guarda de forma síncrona desde este objeto.
 */
export class ConversationSession {
  readonly conversationId: string;
  private readonly agent: StratumAgent;
  private readonly store: DesktopSessionStore;
  private readonly sink: (frame: ConversationOutboundFrame) => void;
  private readonly createdAt: string;
  private readonly confirmTimeoutMs: number;
  private readonly questionsTimeoutMs: number;
  private readonly closeGraceMs: number;
  private turn: Turn | null = null;
  private readonly confirms = new Map<string, Pending<DestructiveDecision>>();
  private readonly questions = new Map<string, Pending<QuestionAnswer[] | null>>();
  private questionSeq = 0;
  /** `allow-all` vale para el resto de esta conversación, no solo para el turno (15.4). */
  private allowAll = false;
  private closed = false;
  /**
   * Cerrada sin que su turno terminase a tiempo. Una sesión retirada ya no
   * guarda ni emite: si el turno viejo acaba más tarde, su `finally` no puede
   * pisar en disco la conversación que se reabrió entretanto, ni mandar tramas
   * a un cliente que ya habla con la sesión nueva.
   */
  private retired = false;

  constructor(opts: ConversationSessionOptions) {
    this.conversationId = opts.conversationId;
    this.store = opts.store;
    this.sink = opts.send;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    this.questionsTimeoutMs = opts.questionsTimeoutMs ?? QUESTIONS_TIMEOUT_MS;
    this.closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    this.agent = new StratumAgent(opts.config, opts.router, buildAssistantRegistry(), {
      promptPreset: 'assistant',
      initialMessages: opts.initialMessages,
    });
  }

  private send(frame: ConversationOutboundFrame): void {
    if (!this.retired) this.sink(frame);
  }

  /** Mensajes del historial sin el system prompt. */
  get messageCount(): number {
    return this.agent.getMessages().filter((m) => m.role !== 'system').length;
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  chat(turnId: string, text: string): void {
    if (this.closed) {
      this.send({
        type: 'chat_rejected',
        conversationId: this.conversationId,
        turnId,
        reason: 'unknown_conversation',
        message: 'La conversación está cerrada.',
      });
      return;
    }
    if (this.turn) {
      this.send({
        type: 'chat_rejected',
        conversationId: this.conversationId,
        turnId,
        reason: 'busy',
        message: 'El asistente todavía está respondiendo al mensaje anterior.',
      });
      return;
    }
    const abort = new AbortController();
    const turn: Turn = { turnId, abort, task: Promise.resolve() };
    this.turn = turn;
    turn.task = this.runTurn(turn, text);
  }

  private async runTurn(turn: Turn, text: string): Promise<void> {
    const { turnId, abort } = turn;
    let stopReason: StopReason = 'error';
    try {
      const events = this.agent.run(text, {
        signal: abort.signal,
        sessionId: this.conversationId,
        destructivePolicy: 'ask',
        onConfirmDestructive: (req) => this.confirm(req, abort.signal),
        onAskQuestions: (items) => this.ask(items, abort.signal),
      });
      for await (const event of events) {
        if (event.type === 'done') stopReason = event.stopReason;
        this.send({ type: 'agent_event', conversationId: this.conversationId, turnId, event });
      }
    } catch (err) {
      log.error('turn failed', { conversationId: this.conversationId, err });
      stopReason = abort.signal.aborted ? 'cancelled' : 'error';
      this.send({
        type: 'agent_event',
        conversationId: this.conversationId,
        turnId,
        event: {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
        },
      });
    } finally {
      this.settlePending();
      if (this.turn === turn) this.turn = null;
      this.save();
      this.send({ type: 'turn_ended', conversationId: this.conversationId, turnId, stopReason });
    }
  }

  /** Aborta el turno en curso. Con `turnId`, solo si es ese turno. */
  cancel(turnId?: string): void {
    const turn = this.turn;
    if (!turn || (turnId !== undefined && turnId !== turn.turnId)) return;
    turn.abort.abort();
    this.settlePending();
  }

  answerConfirm(callId: string, decision: DestructiveDecision): void {
    const pending = this.confirms.get(callId);
    if (!pending) return;
    this.confirms.delete(callId);
    // Acuse: la UI retira el prompt cuando sabe que la respuesta llegó.
    this.send({
      type: 'prompt_resolved',
      conversationId: this.conversationId,
      kind: 'confirm',
      id: callId,
    });
    if (decision === 'allow-all') this.allowAll = true;
    pending.resolve(decision === 'allow-all' ? 'approve' : decision);
  }

  answerQuestions(requestId: string, answers: QuestionAnswer[] | null): void {
    const pending = this.questions.get(requestId);
    if (!pending) return;
    this.questions.delete(requestId);
    this.send({
      type: 'prompt_resolved',
      conversationId: this.conversationId,
      kind: 'questions',
      id: requestId,
    });
    pending.resolve(answers);
  }

  /**
   * Cierre (conversación cerrada, cliente desconectado o apagado del sidecar):
   * aborta el turno, espera un plazo acotado a que termine —su `finally` ya
   * guarda— y, si no hay turno o no terminó a tiempo, guarda aquí.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settlePending();
    const turn = this.turn;
    if (!turn) {
      this.save();
      return;
    }
    this.cancel();
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      turn.task.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.closeGraceMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      log.warn('turn did not stop in time; saving and retiring the session', {
        conversationId: this.conversationId,
      });
      this.save();
      this.retired = true;
    }
  }

  private confirm(req: ConfirmRequest, signal: AbortSignal): Promise<DestructiveDecision> {
    if (this.allowAll) return Promise.resolve('approve');
    if (signal.aborted || this.closed) return Promise.resolve('deny');
    return this.wait(this.confirms, req.callId, 'deny', this.confirmTimeoutMs, 'confirm', () =>
      this.send({
        type: 'confirm_request',
        conversationId: this.conversationId,
        callId: req.callId,
        tool: req.toolName,
        // `describeCall` ya redactada por el dispatcher: nunca parámetros crudos.
        description: req.description,
      }),
    );
  }

  private ask(questions: QuestionItem[], signal: AbortSignal): Promise<QuestionAnswer[] | null> {
    if (signal.aborted || this.closed) return Promise.resolve(null);
    const requestId = `q${++this.questionSeq}`;
    return this.wait(this.questions, requestId, null, this.questionsTimeoutMs, 'questions', () =>
      this.send({
        type: 'questions_request',
        conversationId: this.conversationId,
        requestId,
        questions,
      }),
    );
  }

  /** Espera acotada: se resuelve con la respuesta, o con `fallback` al vencer el plazo. */
  private wait<T>(
    map: Map<string, Pending<T>>,
    id: string,
    fallback: T,
    timeoutMs: number,
    kind: 'confirm' | 'questions',
    announce: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        if (!map.has(id)) return;
        map.delete(id);
        this.send({ type: 'prompt_resolved', conversationId: this.conversationId, kind, id });
        resolve(fallback);
      }, timeoutMs);
      timer.unref();
      map.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      announce();
    });
  }

  /** Resuelve toda espera pendiente: `deny` para confirmaciones, `null` para preguntas. */
  private settlePending(): void {
    for (const [id, p] of this.confirms) {
      this.confirms.delete(id);
      this.send({
        type: 'prompt_resolved',
        conversationId: this.conversationId,
        kind: 'confirm',
        id,
      });
      p.resolve('deny');
    }
    for (const [id, p] of this.questions) {
      this.questions.delete(id);
      this.send({
        type: 'prompt_resolved',
        conversationId: this.conversationId,
        kind: 'questions',
        id,
      });
      p.resolve(null);
    }
  }

  /**
   * Guarda el historial. Síncrono y best-effort: un fallo de disco se registra
   * pero no puede tumbar la conversación. Un turno cancelado se guarda tal cual
   * (como en la CLI); uno a medias cuando muere el sidecar no llega a guardarse.
   */
  private save(): void {
    // Una conversación sin mensajes no tiene nada que recuperar: no se crea
    // un fichero por cada conversación abierta y nunca usada.
    if (this.retired || this.messageCount === 0) return;
    try {
      this.store.save({
        conversationId: this.conversationId,
        provider: this.agent.providerName,
        model: this.agent.model,
        messages: this.agent.getMessages(),
        toolCallCount: this.agent.toolCallCount,
        createdAt: this.createdAt,
      });
    } catch (err) {
      log.error('session save failed', { conversationId: this.conversationId, err });
    }
  }
}
