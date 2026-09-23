import { dirname, join } from 'path';
import type { StratumConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import { getLogger } from '../logging/index.js';
import { normalizeTitle } from './codec.js';
import { ConversationSession } from './conversation.js';
import { DesktopConversationStore, type ConversationRecord } from './conversation-store.js';
import { MemoryPanel } from './memory-panel.js';
import type { DesktopSettings } from './settings.js';
import type { DesktopSessionStore } from './session-store.js';
import { DEFAULT_MAX_CONCURRENT_TURNS, TurnScheduler } from './turn-scheduler.js';
import type { ConversationWorkspace, WorkspaceManager } from './workspace.js';
import type {
  ConversationFrame,
  ConversationOutboundFrame,
  ConversationSummary,
  SidecarErrorFrame,
} from './protocol.js';

const log = getLogger('desktop.host');

export interface ConversationHostOptions {
  config: StratumConfig;
  store: DesktopSessionStore;
  /** Título y transcript visible (D4). Por defecto, `<datos>/conversations/`. */
  records?: DesktopConversationStore;
  /**
   * Un router por conversación: un fallback o un `/model` no puede afectar a
   * las demás. Recibe la config vigente (cambia con Ajustes, D5).
   */
  makeRouter: (config: StratumConfig) => ProviderRouter;
  /** Panel de Ajustes (D5). Sin él, las tramas `config_*` se contestan con error. */
  settings?: DesktopSettings;
  /** Error fatal de arranque (config incompatible): no se puede chatear. */
  startupError?: SidecarErrorFrame | null;
  confirmTimeoutMs?: number;
  questionsTimeoutMs?: number;
  checkpointMs?: number;
  /** Workspaces por conversación (D2). Sin él, conversaciones sin ficheros, como en D1. */
  workspaces?: WorkspaceManager;
  /** Generaciones simultáneas entre todas las conversaciones (D4, 15.15). */
  maxConcurrentTurns?: number;
  /** Memoria global del sidebar (D4). Por defecto, la de `config`. */
  memory?: MemoryPanel;
}

type Send = (frame: ConversationOutboundFrame) => void;

/**
 * Conversaciones vivas del sidecar, multiplexadas por `conversationId` (15.5).
 *
 * Cliente activo con *lease*: el relay de Rust es el único cliente, pero al
 * reiniciarse puede haber un instante con dos conexiones. `attach` cambia el
 * lease **antes** de que el servidor destruya la conexión anterior, y `detach`
 * solo actúa si quien se va sigue siendo el activo: el cierre tardío de la
 * conexión vieja no puede cancelar los turnos de la nueva.
 *
 * D4: varias conversaciones abiertas a la vez, cada una con su agente; las
 * generaciones comparten un `TurnScheduler` (15.15). Además atiende lo que no
 * es de una conversación abierta: el listado del sidebar, renombrar, eliminar
 * y la memoria global.
 */
export class ConversationHost {
  private readonly sessions = new Map<string, ConversationSession>();
  private active: { connectionId: number; send: Send } | null = null;
  /**
   * Cierres (y eliminaciones) en curso por conversación. Reabrir una
   * conversación espera a que su cierre anterior haya guardado: si no, cargaría
   * un historial viejo y el guardado tardío del cierre pisaría luego el nuevo.
   */
  private readonly closing = new Map<string, Promise<void>>();
  /** Las tramas se procesan en orden: un `chat` justo tras `new_conversation` espera a la apertura. */
  private queue: Promise<void> = Promise.resolve();
  private readonly records: DesktopConversationStore;
  private readonly scheduler: TurnScheduler;
  private readonly memory: MemoryPanel;
  /** Config vigente: la de arranque hasta que Ajustes o la CLI la cambian (D5). */
  private config: StratumConfig;
  private error: SidecarErrorFrame | null;

  constructor(private readonly opts: ConversationHostOptions) {
    this.config = opts.config;
    this.error = opts.startupError ?? null;
    this.records =
      opts.records ??
      new DesktopConversationStore(join(dirname(opts.store.dir), 'conversations'), opts.store);
    this.scheduler = new TurnScheduler(opts.maxConcurrentTurns ?? DEFAULT_MAX_CONCURRENT_TURNS);
    this.memory = opts.memory ?? new MemoryPanel(opts.config);
    opts.settings?.attach(this.emit);
  }

  /**
   * Error de config vigente. Deja de haberlo en cuanto se aplica una config que
   * carga (D5): se arregla desde Ajustes sin reiniciar la app.
   */
  get startupError(): SidecarErrorFrame | null {
    return this.error;
  }

  /**
   * Config efectiva nueva (D5). Cada conversación la toma antes de su siguiente
   * turno; la cola, en el acto (subir el límite arranca a los que esperaban).
   */
  applyConfig(config: StratumConfig, opts: { maxConcurrentTurns?: number } = {}): void {
    this.config = config;
    this.error = null;
    this.memory.setConfig(config);
    if (opts.maxConcurrentTurns !== undefined) this.scheduler.setLimit(opts.maxConcurrentTurns);
    for (const session of this.sessions.values()) {
      session.applyConfig(config, () => this.opts.makeRouter(config));
    }
  }

  /** Salida hacia el cliente activo en el momento de emitir (no en el de crear la sesión). */
  private readonly emit: Send = (frame) => {
    this.active?.send(frame);
  };

  attach(connectionId: number, send: Send): void {
    this.active = { connectionId, send };
  }

  /**
   * El cliente activo se fue: nadie leerá los eventos, así que se cierran todas
   * las conversaciones (cancelan su turno y guardan). El siguiente cliente las
   * reabre con `new_conversation {resume: true}` desde la sesión en disco.
   */
  async detach(connectionId: number): Promise<void> {
    if (this.active?.connectionId !== connectionId) return;
    this.active = null;
    await this.closeAll();
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.startClose(id)));
  }

  /** Saca la sesión del mapa y registra su cierre. Idempotente. */
  private startClose(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return this.closing.get(conversationId) ?? Promise.resolve();
    this.sessions.delete(conversationId);
    const manager = this.opts.workspaces;
    // Un borrador (se abrió y se dejó sin mensajes ni ficheros) no deja carpeta:
    // con `Ctrl+N` se abren muchas. Se borra dentro del cierre, así una
    // reapertura espera a que termine.
    const draft =
      manager !== undefined &&
      session.hasWorkspace &&
      !session.busy &&
      session.transcript.length === 0 &&
      (session.workspaceStatus()?.sizeBytes ?? 0) === 0 &&
      !this.opts.store.exists(conversationId) &&
      !this.records.exists(conversationId);
    const done = session
      .close()
      .then(async () => {
        if (!draft) return;
        manager.release(conversationId);
        await manager
          .remove(conversationId)
          .catch((err) => log.warn('draft workspace cleanup failed', { conversationId, err }));
      })
      .finally(() => {
        if (this.closing.get(conversationId) === done) this.closing.delete(conversationId);
      });
    // La retención puede volver a tocar el workspace cuando ya no queda turno:
    // también el de una sesión retirada, que puede seguir escribiendo un rato.
    if (session.hasWorkspace && !draft) {
      void done
        .then(() => session.whenIdle())
        .finally(() => this.opts.workspaces?.release(conversationId));
    }
    this.closing.set(conversationId, done);
    return done;
  }

  /** Espera a que se hayan procesado todas las tramas recibidas hasta ahora (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Encola una trama del cliente `connectionId`. Se descarta al ejecutarse si
   * ese cliente ya no tiene el lease: una apertura o un `chat` que quedaron en
   * cola detrás de un cierre no pueden ejecutarse después de su desconexión.
   */
  handle(frame: ConversationFrame, connectionId: number): void {
    this.queue = this.queue
      .then(() => {
        if (this.active?.connectionId !== connectionId) {
          log.debug('dropping frame from stale client', { type: frame.type, connectionId });
          return;
        }
        return this.dispatch(frame);
      })
      .catch((err) => log.error('frame handling failed', { type: frame.type, err }));
  }

  private async dispatch(frame: ConversationFrame): Promise<void> {
    switch (frame.type) {
      case 'new_conversation':
        await this.closing.get(frame.conversationId);
        await this.open(frame.conversationId, frame.resume === true);
        return;
      case 'close_conversation':
        // No se espera dentro de la cola: un cierre lento no retrasa las
        // tramas de otras conversaciones.
        void this.startClose(frame.conversationId).then(() =>
          this.emit({ type: 'conversation_closed', conversationId: frame.conversationId }),
        );
        return;
      case 'chat': {
        const session = this.sessions.get(frame.conversationId);
        if (this.error?.fatal || !session) {
          this.emit({
            type: 'chat_rejected',
            conversationId: frame.conversationId,
            turnId: frame.turnId,
            reason: this.error?.fatal ? 'sidecar_unavailable' : 'unknown_conversation',
            message: this.error?.fatal
              ? this.error.message
              : 'La conversación no está abierta en el agente.',
          });
          return;
        }
        session.chat(frame.turnId, frame.text, frame.attachments);
        // El título y el orden del listado cambian con el mensaje (si se aceptó).
        if (session.busy) this.emit({ type: 'conversation_updated', summary: session.summary() });
        return;
      }
      case 'cancel':
        this.sessions.get(frame.conversationId)?.cancel(frame.turnId);
        return;
      case 'workspace_touch':
        this.sessions.get(frame.conversationId)?.touchWorkspace();
        return;
      case 'workspace_pin': {
        const session = this.sessions.get(frame.conversationId);
        if (session) session.pinWorkspace(frame.pinned);
        else void this.pinClosed(frame.conversationId, frame.pinned);
        return;
      }
      case 'confirm_response':
        this.sessions.get(frame.conversationId)?.answerConfirm(frame.callId, frame.decision);
        return;
      case 'answer_questions':
        this.sessions.get(frame.conversationId)?.answerQuestions(frame.requestId, frame.answers);
        return;
      case 'list_conversations':
        this.emit({ type: 'conversations', items: this.list() });
        return;
      case 'rename_conversation':
        this.rename(frame.conversationId, normalizeTitle(frame.title));
        return;
      case 'delete_conversation':
        this.startDelete(frame.conversationId);
        return;
      case 'clear_conversation':
        this.withSession(frame.conversationId, (s) => s.clear());
        return;
      case 'compact_conversation':
        // Fuera de la cola: una compresión es una llamada al LLM.
        this.withSession(frame.conversationId, (s) => void s.compact());
        return;
      case 'list_models':
        this.withSession(frame.conversationId, (s) => void s.listModels());
        return;
      case 'set_model':
        this.withSession(frame.conversationId, (s) => s.setModel(frame.model));
        return;
      case 'memory_get':
        this.emitMemory();
        return;
      case 'memory_save':
        this.saveMemory(frame.content, frame.baseMtimeMs);
        return;
      case 'memory_forget':
        await this.forgetDecision(frame.id);
        return;
      case 'config_get':
      case 'config_validate':
      case 'config_save':
      case 'workspaces_usage_get':
        await this.withSettings((s) => s.handle(frame));
        return;
      case 'provider_probe':
        // Fuera de la cola: es una petición HTTP con timeout propio.
        void this.withSettings((s) => s.handle(frame));
        return;
      case 'retention_run':
        // Fuera de la cola (comprime y borra); al terminar, el listado cambia.
        void this.withSettings(async (s) => {
          await s.handle(frame);
          this.emit({ type: 'conversations', items: this.list() });
        });
        return;
    }
  }

  private async withSettings(fn: (s: DesktopSettings) => Promise<void>): Promise<void> {
    const settings = this.opts.settings;
    if (!settings) {
      this.emit({ type: 'config_error', message: 'Este agente no admite ajustes.' });
      return;
    }
    try {
      await fn(settings);
    } catch (err) {
      log.error('settings frame failed', { err });
      this.emit({
        type: 'config_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private withSession(conversationId: string, fn: (s: ConversationSession) => void): void {
    const session = this.sessions.get(conversationId);
    if (session) {
      fn(session);
      return;
    }
    this.emit({
      type: 'conversation_error',
      conversationId,
      message: 'La conversación no está abierta en el agente.',
    });
  }

  // -------------------------------------------------------------------------
  // Listado, renombrar y eliminar (D4)
  // -------------------------------------------------------------------------

  /** Conversaciones guardadas más las abiertas, de la más reciente a la más antigua. */
  list(): ConversationSummary[] {
    const items = new Map<string, ConversationSummary>();
    const saved = new Set(this.records.ids());
    for (const id of saved) {
      if (this.sessions.has(id)) continue;
      const summary = this.records.summary(id);
      if (!summary) continue;
      let workspace = null;
      try {
        workspace = this.opts.workspaces?.statusOf(id) ?? null;
      } catch (err) {
        log.warn('workspace status unreadable', { conversationId: id, err });
      }
      items.set(id, { ...summary, workspace });
    }
    for (const [id, session] of this.sessions) {
      // Una conversación abierta y nunca usada todavía no es parte del listado.
      if (session.transcript.length === 0 && !saved.has(id)) continue;
      items.set(id, session.summary());
    }
    return [...items.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private rename(conversationId: string, title: string): void {
    if (!title) return;
    const session = this.sessions.get(conversationId);
    if (session) {
      session.rename(title);
      return;
    }
    let record: ConversationRecord | null;
    try {
      record = this.records.load(conversationId);
    } catch (err) {
      this.emit({
        type: 'conversation_error',
        conversationId,
        message: `No se pudo renombrar: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (!record) return;
    const next = { ...record, title, titleEdited: true };
    try {
      this.records.save(next);
    } catch (err) {
      log.error('rename failed', { conversationId, err });
      return;
    }
    const summary = this.records.summary(conversationId);
    if (summary) {
      this.emit({
        type: 'conversation_updated',
        summary: { ...summary, workspace: this.opts.workspaces?.statusOf(conversationId) ?? null },
      });
    }
  }

  /** Fijar desde el sidebar una conversación que no está abierta (D4). */
  private async pinClosed(conversationId: string, pinned: boolean): Promise<void> {
    const manager = this.opts.workspaces;
    if (!manager) return;
    try {
      const workspace = await manager.setPinned(conversationId, pinned);
      const summary = this.records.summary(conversationId);
      if (summary) this.emit({ type: 'conversation_updated', summary: { ...summary, workspace } });
    } catch (err) {
      log.error('pin failed', { conversationId, err });
      this.emit({
        type: 'conversation_error',
        conversationId,
        message: `No se pudo fijar la conversación: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * Elimina historial, transcript y workspace (carpeta o archivo). Fuera de la
   * cola: cerrar un turno en marcha puede tardar el plazo de gracia. Se
   * registra como cierre en curso, así una reapertura espera a que acabe.
   */
  private startDelete(conversationId: string): void {
    const previous = this.closing.get(conversationId) ?? Promise.resolve();
    const session = this.sessions.get(conversationId);
    // El cierre se arranca aquí, antes de registrar la eliminación en `closing`:
    // dentro de la tarea, `startClose` devolvería la propia eliminación.
    const closed = session ? this.startClose(conversationId) : Promise.resolve();
    const task = (async () => {
      await previous;
      await closed;
      // El turno retirado de una sesión que no paró a tiempo sigue escribiendo:
      // se espera a que acabe antes de borrar su carpeta.
      if (session) await session.whenIdle();
      this.records.remove(conversationId);
      await this.opts.workspaces?.remove(conversationId);
    })();
    const done = task
      .then(() => this.emit({ type: 'conversation_deleted', conversationId }))
      .catch((err) => {
        log.error('delete failed', { conversationId, err });
        this.emit({
          type: 'conversation_error',
          conversationId,
          message: `No se pudo eliminar la conversación: ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => {
        if (this.closing.get(conversationId) === done) this.closing.delete(conversationId);
      });
    this.closing.set(conversationId, done);
  }

  // -------------------------------------------------------------------------
  // Memoria global (D4, §7.3)
  // -------------------------------------------------------------------------

  private emitMemory(): void {
    try {
      this.emit(this.memory.state());
    } catch (err) {
      this.emit({
        type: 'memory_error',
        message: `No se pudo leer la memoria: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private saveMemory(content: string, baseMtimeMs: number | null): void {
    try {
      const result = this.memory.save(content, baseMtimeMs);
      if (!result.ok) {
        this.emit({ type: 'memory_conflict', content: result.content, mtimeMs: result.mtimeMs });
        return;
      }
      this.emit({ type: 'memory_saved', mtimeMs: result.mtimeMs });
      // El `STRATUM.md` global va en el system prompt: cada conversación
      // abierta lo recompone (o lo hará antes de su siguiente turno).
      for (const session of this.sessions.values()) session.reloadMemory();
    } catch (err) {
      this.emit({
        type: 'memory_error',
        message: `No se pudo guardar la memoria: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async forgetDecision(id: string): Promise<void> {
    try {
      await this.memory.forget(id);
    } catch (err) {
      this.emit({
        type: 'memory_error',
        message: `No se pudo borrar la decisión: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    this.emitMemory();
  }

  // -------------------------------------------------------------------------
  // Apertura
  // -------------------------------------------------------------------------

  private opened(session: ConversationSession, resumed: boolean): ConversationOutboundFrame {
    const workspace = session.workspaceStatus();
    return {
      type: 'conversation_opened',
      conversationId: session.conversationId,
      resumed,
      messageCount: session.messageCount,
      ...(workspace ? { workspace } : {}),
      title: session.title,
      transcript: session.transcript,
      activeTurnId: session.activeTurnId,
      todos: session.todos,
      stats: session.stats(),
    };
  }

  private async open(conversationId: string, resume: boolean): Promise<void> {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      this.emit(this.opened(existing, false));
      return;
    }
    if (this.error?.fatal) {
      this.emit({
        type: 'conversation_error',
        conversationId,
        message: this.error.message,
      });
      return;
    }

    let saved = null;
    let record: ConversationRecord | null = null;
    if (resume) {
      try {
        saved = this.opts.store.load(conversationId);
        record = this.records.load(conversationId);
      } catch (err) {
        // Una sesión ilegible no impide seguir: se abre vacía y se avisa.
        log.error('session load failed', { conversationId, err });
        this.emit({
          type: 'conversation_error',
          conversationId,
          message: `No se pudo recuperar el historial: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // El workspace, antes que la sesión: espera a una compresión en marcha y
    // restaura un archivado (D3). Desde aquí la retención ya no lo toca.
    let workspace: ConversationWorkspace | undefined;
    const manager = this.opts.workspaces;
    if (manager) {
      try {
        ({ workspace } = await manager.acquire(conversationId, {
          onRestoring: () => {
            const status = manager.statusOf(conversationId);
            if (status) {
              this.emit({
                type: 'workspace_status',
                conversationId,
                status: { ...status, state: 'restoring' },
              });
            }
          },
        }));
      } catch (err) {
        // Sin workspace la conversación sigue, sin ficheros: mejor que no poder
        // hablar con el asistente por un problema de disco.
        log.error('workspace open failed', { conversationId, err });
        this.emit({
          type: 'conversation_error',
          conversationId,
          message: `No se pudo preparar la carpeta de ficheros de la conversación: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    let session: ConversationSession;
    try {
      session = new ConversationSession({
        workspace,
        workspaceSettings: manager?.settings,
        conversationId,
        config: this.config,
        router: this.opts.makeRouter(this.config),
        store: this.opts.store,
        records: this.records,
        record,
        scheduler: this.scheduler,
        send: this.emit,
        onChanged: (summary) => this.emit({ type: 'conversation_updated', summary }),
        initialMessages: saved?.messages,
        createdAt: saved?.createdAt,
        savedProvider: saved?.provider,
        savedModel: saved?.model,
        confirmTimeoutMs: this.opts.confirmTimeoutMs,
        questionsTimeoutMs: this.opts.questionsTimeoutMs,
        checkpointMs: this.opts.checkpointMs,
      });
    } catch (err) {
      log.error('conversation open failed', { conversationId, err });
      this.emit({
        type: 'conversation_error',
        conversationId,
        message: `No se pudo iniciar el agente: ${err instanceof Error ? err.message : String(err)}`,
      });
      if (workspace) manager?.release(conversationId);
      return;
    }
    this.sessions.set(conversationId, session);
    log.info('conversation opened', {
      conversationId,
      resumed: saved !== null,
      messages: session.messageCount,
    });
    this.emit(this.opened(session, saved !== null || record !== null));
  }
}
