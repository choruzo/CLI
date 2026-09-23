import { basename, dirname, join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import { fetchModels } from '../providers/utils.js';
import { StratumAgent } from '../agent/core.js';
import type {
  AgentEvent,
  ConfirmRequest,
  DestructiveDecision,
  Message,
  QuestionAnswer,
  QuestionItem,
} from '../agent/types.js';
import { getLogger } from '../logging/index.js';
import { buildAssistantRegistry } from './assistant-runtime.js';
import type { DesktopSessionStore } from './session-store.js';
import {
  CONVERSATION_RECORD_VERSION,
  DesktopConversationStore,
  summarize,
  type ConversationRecord,
} from './conversation-store.js';
import {
  addTranscriptFiles,
  applyTranscriptEvent,
  deriveTitle,
  newTurn,
  settleTranscriptTurn,
  statusForStop,
} from './transcript.js';
import { TurnCancelledInQueue, TurnScheduler, type TurnTicket } from './turn-scheduler.js';
import type {
  ConversationOutboundFrame,
  ConversationStats,
  ConversationSummary,
  TranscriptAttachment,
  TranscriptTurn,
  TurnEndedFrame,
} from './protocol.js';
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
/** Checkpoint periódico mientras un turno está en marcha (15.12). */
export const CHECKPOINT_INTERVAL_MS = 60_000;

type StopReason = TurnEndedFrame['stopReason'];

export interface ConversationSessionOptions {
  conversationId: string;
  config: StratumConfig;
  router: ProviderRouter;
  store: DesktopSessionStore;
  /**
   * Título y transcript visible (D4). Por defecto, junto al directorio de
   * sesiones (`<datos>/conversations/`).
   */
  records?: DesktopConversationStore;
  /** Registro ya cargado por el host (reapertura); sin él, conversación nueva. */
  record?: ConversationRecord | null;
  /** Salida hacia el cliente activo. Si no hay cliente, la trama se pierde. */
  send: (frame: ConversationOutboundFrame) => void;
  /** Cambió algo del listado del sidebar (turno, título, modelo) (D4). */
  onChanged?: (summary: ConversationSummary) => void;
  /** Límite de generaciones simultáneas compartido entre conversaciones (15.15). */
  scheduler?: TurnScheduler;
  /** Historial de una sesión guardada (rehidratación tras reinicio, 15.5). */
  initialMessages?: Message[];
  createdAt?: string;
  /** Modelo con el que se guardó la sesión: se reaplica si el provider coincide (`/model`). */
  savedProvider?: string;
  savedModel?: string;
  confirmTimeoutMs?: number;
  questionsTimeoutMs?: number;
  closeGraceMs?: number;
  checkpointMs?: number;
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

/**
 * Historial apto para un checkpoint a mitad de turno (15.12). Si el sidecar
 * muere justo después, lo guardado tiene que poder reanudarse: se quitan un
 * `assistant` con `tool_calls` sin todas sus respuestas (el provider rechazaría
 * el historial) y un mensaje de usuario final sin respuesta (el turno aparece
 * como interrumpido en el transcript y la UI ofrece reintentarlo).
 */
export function checkpointMessages(messages: Message[]): Message[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role === 'tool') continue;
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const answered = new Set(
        out
          .slice(i + 1)
          .flatMap((x) => (x.role === 'tool' && x.tool_call_id ? [x.tool_call_id] : [])),
      );
      if (m.tool_calls.some((tc) => !answered.has(tc.id))) out.splice(i);
    }
    break;
  }
  if (out.at(-1)?.role === 'user') out.pop();
  return out;
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
 * su router, su transcript visible y el turno en curso. Invariantes:
 * - como mucho un turno a la vez (en cola o en marcha); un `chat` durante un
 *   turno se rechaza;
 * - el turno es una única tarea que **siempre** termina en `turn_ended`, libera
 *   el hueco de generación y guarda, también si el agente lanza o se cancela en cola;
 * - ninguna espera (confirmación, preguntas) sobrevive al turno: abort,
 *   timeout, cierre o desconexión la resuelven con `deny` / `null`;
 * - un solo escritor: la sesión y el registro se guardan de forma síncrona
 *   desde este objeto (al acabar cada turno y en los checkpoints de 15.12).
 */
export class ConversationSession {
  readonly conversationId: string;
  private readonly agent: StratumAgent;
  private readonly store: DesktopSessionStore;
  private readonly records: DesktopConversationStore;
  private readonly sink: (frame: ConversationOutboundFrame) => void;
  private readonly onChanged: (summary: ConversationSummary) => void;
  private readonly scheduler: TurnScheduler;
  private readonly createdAt: string;
  private readonly confirmTimeoutMs: number;
  private readonly questionsTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly checkpointMs: number;
  private readonly workspace: ConversationWorkspace | undefined;
  private readonly workspaceSettings: WorkspaceSettings | undefined;
  private record: ConversationRecord;
  private turn: Turn | null = null;
  private readonly confirms = new Map<string, Pending<DestructiveDecision>>();
  private readonly questions = new Map<string, Pending<QuestionAnswer[] | null>>();
  private questionSeq = 0;
  /** `allow-all` vale para el resto de esta conversación, no solo para el turno (15.4). */
  private allowAll = false;
  private closed = false;
  /** El `STRATUM.md` global cambió durante un turno: se recarga antes del siguiente. */
  private memoryStale = false;
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
    this.records =
      opts.records ??
      new DesktopConversationStore(join(dirname(opts.store.dir), 'conversations'), opts.store);
    this.sink = opts.send;
    this.onChanged = opts.onChanged ?? (() => undefined);
    this.scheduler = opts.scheduler ?? new TurnScheduler(1);
    this.createdAt = opts.record?.createdAt ?? opts.createdAt ?? new Date().toISOString();
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
    this.questionsTimeoutMs = opts.questionsTimeoutMs ?? QUESTIONS_TIMEOUT_MS;
    this.closeGraceMs = opts.closeGraceMs ?? CLOSE_GRACE_MS;
    this.checkpointMs = opts.checkpointMs ?? CHECKPOINT_INTERVAL_MS;
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
    // `/model` es por conversación y se guarda con la sesión: al reabrir se
    // reaplica si sigue siendo el mismo provider.
    const savedModel = opts.savedModel ?? opts.record?.model;
    const savedProvider = opts.savedProvider ?? opts.record?.provider;
    if (
      savedModel &&
      savedProvider === this.agent.providerName &&
      savedModel !== this.agent.model
    ) {
      this.agent.switchModel(savedModel);
    }
    const base = opts.record;
    this.record = {
      version: CONVERSATION_RECORD_VERSION,
      conversationId: this.conversationId,
      title: base?.title ?? 'Nueva conversación',
      titleEdited: base?.titleEdited ?? false,
      createdAt: this.createdAt,
      updatedAt: base?.updatedAt ?? this.createdAt,
      provider: this.agent.providerName,
      model: this.agent.model,
      // Un turno que estaba en marcha cuando murió el sidecar no va a terminar.
      transcript: (base?.transcript ?? []).map((t) =>
        t.status === 'streaming' || t.status === 'queued'
          ? settleTranscriptTurn(t, 'interrupted')
          : t,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Estado para la UI
  // -------------------------------------------------------------------------

  get title(): string {
    return this.record.title;
  }

  get transcript(): TranscriptTurn[] {
    return this.record.transcript;
  }

  get activeTurnId(): string | null {
    return this.turn?.turnId ?? null;
  }

  get todos() {
    return this.agent.getTodos();
  }

  stats(): ConversationStats {
    return {
      provider: this.agent.providerName,
      model: this.agent.model,
      context: this.agent.getContextUsage(),
    };
  }

  summary(): ConversationSummary {
    return summarize(this.record, this.workspaceStatus() ?? null);
  }

  /** Rust copió una subida (`workspace_touch`): marca uso y recalcula el tamaño. */
  touchWorkspace(): void {
    if (this.closed || !this.workspace) return;
    this.workspace.touch();
    this.announceStatus();
    this.onChanged(this.summary());
  }

  /** Fija o desfija la conversación (16.7). No cuenta como uso. */
  pinWorkspace(pinned: boolean): void {
    if (this.closed || !this.workspace) return;
    this.workspace.setPinned(pinned);
    this.announceStatus();
    this.onChanged(this.summary());
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

  private announceStats(): void {
    this.send({
      type: 'conversation_stats',
      conversationId: this.conversationId,
      stats: this.stats(),
    });
  }

  private notice(tone: 'info' | 'warning', message: string): void {
    this.send({ type: 'conversation_notice', conversationId: this.conversationId, tone, message });
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

  // -------------------------------------------------------------------------
  // Turnos
  // -------------------------------------------------------------------------

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
    const shown: TranscriptAttachment[] = checked.files.map((f) => ({
      path: f.path,
      name: basename(f.path),
      size: f.size,
    }));
    const ticket = this.scheduler.acquire(abort.signal, (position) =>
      this.send({ type: 'turn_queued', conversationId: this.conversationId, turnId, position }),
    );
    this.startTranscriptTurn(
      newTurn(turnId, text, shown, ticket.position > 0 ? 'queued' : 'streaming'),
    );
    // El mensaje queda en disco ya (15.12): si la app muere antes del primer
    // checkpoint, la conversación sigue en el listado con el turno interrumpido
    // y la UI ofrece reintentarlo.
    this.saveRecord();
    if (ticket.position > 0) {
      this.send({
        type: 'turn_queued',
        conversationId: this.conversationId,
        turnId,
        position: ticket.position,
      });
    }
    const turn: Turn = { turnId, abort, task: Promise.resolve() };
    this.turn = turn;
    turn.task = this.runTurn(turn, ticket, composeUserMessage(text, checked.files));
  }

  private startTranscriptTurn(turn: TranscriptTurn): void {
    const first = this.record.transcript.length === 0;
    this.record = {
      ...this.record,
      transcript: [...this.record.transcript, turn],
      ...(first && !this.record.titleEdited
        ? { title: deriveTitle(turn.user.text, turn.user.attachments) }
        : {}),
    };
  }

  private updateTranscriptTurn(turnId: string, fn: (t: TranscriptTurn) => TranscriptTurn): void {
    const i = this.record.transcript.findIndex((t) => t.turnId === turnId);
    if (i === -1) return;
    const transcript = this.record.transcript.slice();
    transcript[i] = fn(transcript[i]);
    this.record = { ...this.record, transcript };
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

  private async runTurn(turn: Turn, ticket: TurnTicket, text: string): Promise<void> {
    const { turnId, abort } = turn;
    let stopReason: StopReason = 'error';
    let outputsBefore: OutputsSnapshot | null = null;
    let started = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await ticket.ready;
      started = true;
      this.send({ type: 'turn_started', conversationId: this.conversationId, turnId });
      this.updateTranscriptTurn(turnId, (t) => ({ ...t, status: 'streaming' }));
      if (this.memoryStale) {
        this.memoryStale = false;
        this.agent.reloadMemory();
      }
      this.workspace?.touch();
      outputsBefore = this.workspace?.snapshotOutputs() ?? null;
      timer = setInterval(() => this.checkpoint(), this.checkpointMs);
      timer.unref();
      const events = this.agent.run(text, {
        signal: abort.signal,
        sessionId: this.conversationId,
        destructivePolicy: 'ask',
        onConfirmDestructive: (req) => this.confirm(req, abort.signal),
        onAskQuestions: (items) => this.ask(items, abort.signal),
      });
      for await (const event of events) {
        if (event.type === 'done') stopReason = event.stopReason;
        this.onEvent(turnId, event);
      }
    } catch (err) {
      if (err instanceof TurnCancelledInQueue) {
        stopReason = 'cancelled';
      } else {
        log.error('turn failed', { conversationId: this.conversationId, err });
        stopReason = abort.signal.aborted ? 'cancelled' : 'error';
        this.onEvent(turnId, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          fatal: false,
        });
      }
    } finally {
      clearInterval(timer);
      ticket.release();
      this.settlePending();
      if (this.turn === turn) this.turn = null;
      this.updateTranscriptTurn(turnId, (t) => settleTranscriptTurn(t, statusForStop(stopReason)));
      if (started) this.announceOutputs(turnId, outputsBefore);
      this.record = { ...this.record, updatedAt: new Date().toISOString() };
      this.save();
      this.send({ type: 'turn_ended', conversationId: this.conversationId, turnId, stopReason });
      if (!this.retired) {
        this.announceStats();
        this.onChanged(this.summary());
      }
    }
  }

  private onEvent(turnId: string, event: AgentEvent): void {
    this.updateTranscriptTurn(turnId, (t) => applyTranscriptEvent(t, event));
    this.send({ type: 'agent_event', conversationId: this.conversationId, turnId, event });
    // Checkpoint tras cada tool terminada: es cuando más trabajo se perdería.
    // Diferido: el loop emite el evento antes de añadir el mensaje `tool` al
    // historial, y lo añade en cuanto se le pide el siguiente evento.
    if (event.type === 'tool_result' || event.type === 'tool_error') {
      setImmediate(() => this.checkpoint());
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
        this.updateTranscriptTurn(turnId, (t) => addTranscriptFiles(t, files));
        this.send({ type: 'workspace_files', conversationId: this.conversationId, turnId, files });
      }
      this.announceStatus();
    } catch (err) {
      log.error('outputs scan failed', { conversationId: this.conversationId, err });
    }
  }

  /** Aborta el turno en curso (o lo saca de la cola). Con `turnId`, solo si es ese turno. */
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

  // -------------------------------------------------------------------------
  // Comandos de la conversación (D4)
  // -------------------------------------------------------------------------

  /** Los comandos que tocan el historial no pueden cruzarse con un turno. */
  private rejectIfBusy(what: string): boolean {
    if (this.closed) return true;
    if (!this.turn) return false;
    this.notice('warning', `No se puede ${what} mientras el asistente responde.`);
    return true;
  }

  rename(title: string): void {
    if (this.closed) return;
    this.record = { ...this.record, title, titleEdited: true };
    this.saveRecord();
    this.onChanged(this.summary());
  }

  /** `/clear`: historial del agente y transcript vacíos. El workspace se queda. */
  clear(): void {
    if (this.rejectIfBusy('vaciar la conversación')) return;
    this.agent.clearHistory();
    this.record = {
      ...this.record,
      transcript: [],
      updatedAt: new Date().toISOString(),
      ...(this.record.titleEdited ? {} : { title: 'Nueva conversación' }),
    };
    this.save();
    this.send({ type: 'conversation_cleared', conversationId: this.conversationId });
    this.announceStats();
    this.onChanged(this.summary());
  }

  /** `/compact`: comprime el contexto ya. El transcript visible no cambia. */
  async compact(): Promise<void> {
    if (this.rejectIfBusy('comprimir el contexto')) return;
    try {
      const result = await this.agent.compactNow();
      const text =
        result.kind === 'compressed'
          ? `Contexto comprimido: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.roundsCompressed} rondas resumidas).`
          : result.kind === 'truncated'
            ? `Contexto truncado: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.roundsRemoved} rondas eliminadas).`
            : result.kind === 'pressure'
              ? 'No hay nada que comprimir: toda la conversación está en la zona protegida.'
              : 'No había nada que comprimir.';
      this.save();
      this.notice('info', text);
    } catch (err) {
      this.notice(
        'warning',
        `No se pudo comprimir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.announceStats();
  }

  /** `/model <nombre>`: solo esta conversación; se guarda con la sesión. */
  setModel(model: string): void {
    if (this.rejectIfBusy('cambiar de modelo')) return;
    this.agent.switchModel(model);
    this.record = { ...this.record, model: this.agent.model, provider: this.agent.providerName };
    this.save();
    this.notice('info', `Modelo de esta conversación: ${this.agent.model}`);
    this.announceStats();
    this.onChanged(this.summary());
  }

  /** `/model`: modelos del provider activo (`GET /models`). */
  async listModels(): Promise<void> {
    const cfg = this.agent.getActiveProviderConfig();
    try {
      const models = await fetchModels(cfg.baseUrl, cfg.apiKey);
      this.send({
        type: 'models',
        conversationId: this.conversationId,
        current: this.agent.model,
        models,
      });
    } catch (err) {
      this.send({
        type: 'models',
        conversationId: this.conversationId,
        current: this.agent.model,
        models: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** El `STRATUM.md` global cambió: se recompone el prompt (o antes del siguiente turno). */
  reloadMemory(): void {
    if (this.closed) return;
    if (this.turn) {
      this.memoryStale = true;
      return;
    }
    this.agent.reloadMemory();
    this.announceStats();
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

  // -------------------------------------------------------------------------
  // Persistencia
  // -------------------------------------------------------------------------

  /** Checkpoint a mitad de turno (15.12): historial reanudable + transcript. */
  private checkpoint(): void {
    if (this.retired || !this.turn) return;
    this.saveSession(checkpointMessages(this.agent.getMessages()));
    this.saveRecord();
  }

  /**
   * Guarda el historial y el transcript. Síncrono y best-effort: un fallo de
   * disco se registra pero no puede tumbar la conversación. Un turno cancelado
   * se guarda tal cual (como en la CLI).
   */
  private save(): void {
    if (this.retired) return;
    this.saveSession(this.agent.getMessages());
    this.saveRecord();
  }

  private saveSession(messages: Message[]): void {
    // Una conversación sin mensajes ni fichero previo no tiene nada que
    // recuperar: no se crea un fichero por cada conversación abierta y nunca
    // usada. Con fichero previo (un `/clear`) sí hay que vaciarlo.
    const count = messages.filter((m) => m.role !== 'system').length;
    try {
      if (count === 0 && !this.store.exists(this.conversationId)) return;
      this.store.save({
        conversationId: this.conversationId,
        provider: this.agent.providerName,
        model: this.agent.model,
        messages,
        toolCallCount: this.agent.toolCallCount,
        createdAt: this.createdAt,
      });
    } catch (err) {
      log.error('session save failed', { conversationId: this.conversationId, err });
    }
  }

  private saveRecord(): void {
    if (this.retired) return;
    try {
      if (this.record.transcript.length === 0 && !this.hasSavedRecord()) return;
      this.records.save({
        ...this.record,
        provider: this.agent.providerName,
        model: this.agent.model,
      });
    } catch (err) {
      log.error('conversation record save failed', { conversationId: this.conversationId, err });
    }
  }

  private hasSavedRecord(): boolean {
    return this.store.exists(this.conversationId) || this.record.titleEdited;
  }
}
