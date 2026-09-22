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
import {
  formatBytes,
  type ConversationWorkspace,
  type OutputsSnapshot,
  type WorkspaceSettings,
} from './workspace.js';

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
  /**
   * Workspace de la conversación (D2). Con él, el agente recibe las tools de
   * fichero confinadas y el `chat` admite adjuntos; sin él, el asistente de D1.
   */
  workspace?: ConversationWorkspace;
  /** Plazos de retención, para anunciar `workspace_status` tras cada uso (D3). */
  workspaceSettings?: WorkspaceSettings;
}

/** Un adjunto ya comprobado contra el workspace. */
export interface CheckedAttachment {
  path: string;
  size: number;
  mime: string;
}

/**
 * Mensaje de usuario con adjuntos: el agente ve rutas del workspace, nunca la
 * ruta original del disco del usuario (que ni siquiera llega al sidecar).
 */
export function composeUserMessage(text: string, attachments: CheckedAttachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((a) => `- ${a.path} (${a.mime}, ${formatBytes(a.size)})`);
  const block = [
    '<attachments>',
    'The user attached these files to this message. They are in the conversation workspace:',
    ...lines,
    '</attachments>',
  ].join('\n');
  return text.trim() === '' ? block : `${block}\n\n${text}`;
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
  private readonly workspace: ConversationWorkspace | undefined;
  private readonly workspaceSettings: WorkspaceSettings | undefined;
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
    this.workspace = opts.workspace;
    this.workspaceSettings = opts.workspaceSettings;
    this.agent = new StratumAgent(
      opts.config,
      opts.router,
      buildAssistantRegistry({ files: this.workspace !== undefined }),
      {
        promptPreset: 'assistant',
        initialMessages: opts.initialMessages,
        workspace: this.workspace?.confinement,
        workspaceFilesExpiredAt: this.workspace?.getMeta().filesExpiredAt,
      },
    );
  }

  /** Rust copió una subida (`workspace_touch`): marca uso y recalcula el tamaño. */
  touchWorkspace(): void {
    if (this.closed || !this.workspace) return;
    this.workspace.touch();
    this.announceStatus();
  }

  /** Fija o desfija la conversación (16.7). No cuenta como uso. */
  pinWorkspace(pinned: boolean): void {
    if (this.closed || !this.workspace) return;
    this.workspace.setPinned(pinned);
    this.announceStatus();
  }

  /** Estado de retención del workspace, o `undefined` si la conversación no tiene. */
  workspaceStatus() {
    return this.workspace && this.workspaceSettings
      ? this.workspace.status(this.workspaceSettings)
      : undefined;
  }

  private announceStatus(): void {
    const status = this.workspaceStatus();
    if (status)
      this.send({ type: 'workspace_status', conversationId: this.conversationId, status });
  }

  /** Se resuelve cuando no queda turno en curso (también uno que `close` dejó retirado). */
  whenIdle(): Promise<void> {
    return this.turn?.task ?? Promise.resolve();
  }

  private send(frame: ConversationOutboundFrame): void {
    if (!this.retired) this.sink(frame);
  }

  /** Mensajes del historial sin el system prompt. */
  get messageCount(): number {
    return this.agent.getMessages().filter((m) => m.role !== 'system').length;
  }

  get hasWorkspace(): boolean {
    return this.workspace !== undefined;
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  chat(turnId: string, text: string, attachments: string[] = []): void {
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
    const checked = this.checkAttachments(attachments);
    if (!checked.ok) {
      this.send({
        type: 'chat_rejected',
        conversationId: this.conversationId,
        turnId,
        reason: 'bad_attachment',
        message: checked.message,
      });
      return;
    }
    const abort = new AbortController();
    const turn: Turn = { turnId, abort, task: Promise.resolve() };
    this.turn = turn;
    turn.task = this.runTurn(turn, composeUserMessage(text, checked.files));
  }

  /** Cada adjunto tiene que ser un fichero de `inputs/` de este workspace. */
  private checkAttachments(
    paths: string[],
  ): { ok: true; files: CheckedAttachment[] } | { ok: false; message: string } {
    if (paths.length === 0) return { ok: true, files: [] };
    if (!this.workspace) {
      return { ok: false, message: 'Esta conversación no admite ficheros adjuntos.' };
    }
    const files: CheckedAttachment[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const r = this.workspace.checkAttachment(path);
      if (!r.ok) {
        return { ok: false, message: `El adjunto «${path}» no es válido: ${r.reason}.` };
      }
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      files.push({ path: r.path, size: r.size, mime: r.mime });
    }
    return { ok: true, files };
  }

  private async runTurn(turn: Turn, text: string): Promise<void> {
    const { turnId, abort } = turn;
    let stopReason: StopReason = 'error';
    let outputsBefore: OutputsSnapshot | null = null;
    try {
      this.workspace?.touch();
      outputsBefore = this.workspace?.snapshotOutputs() ?? null;
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
      this.announceOutputs(turnId, outputsBefore);
      this.send({ type: 'turn_ended', conversationId: this.conversationId, turnId, stopReason });
    }
  }

  /**
   * Anuncia lo que el turno dejó en `outputs/` (también si se canceló: lo
   * escrito, escrito está) y marca uso. Best-effort: nunca impide el `turn_ended`.
   */
  private announceOutputs(turnId: string, before: OutputsSnapshot | null): void {
    if (!this.workspace || !before) return;
    try {
      const files = this.workspace.changedOutputs(before);
      this.workspace.touch();
      if (files.length > 0) {
        this.send({ type: 'workspace_files', conversationId: this.conversationId, turnId, files });
      }
      this.announceStatus();
    } catch (err) {
      log.error('outputs scan failed', { conversationId: this.conversationId, err });
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
