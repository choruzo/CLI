import type { StratumConfig } from '../config/schema.js';
import type { ProviderRouter } from '../providers/router.js';
import { getLogger } from '../logging/index.js';
import { ConversationSession } from './conversation.js';
import type { DesktopSessionStore } from './session-store.js';
import type { ConversationWorkspace, WorkspaceManager } from './workspace.js';
import type {
  ConversationFrame,
  ConversationOutboundFrame,
  SidecarErrorFrame,
} from './protocol.js';

const log = getLogger('desktop.host');

export interface ConversationHostOptions {
  config: StratumConfig;
  store: DesktopSessionStore;
  /** Un router por conversación: un fallback o un `/model` no puede afectar a las demás. */
  makeRouter: () => ProviderRouter;
  /** Error fatal de arranque (config incompatible): no se puede chatear. */
  startupError?: SidecarErrorFrame | null;
  confirmTimeoutMs?: number;
  questionsTimeoutMs?: number;
  /** Workspaces por conversación (D2). Sin él, conversaciones sin ficheros, como en D1. */
  workspaces?: WorkspaceManager;
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
 */
export class ConversationHost {
  private readonly sessions = new Map<string, ConversationSession>();
  private active: { connectionId: number; send: Send } | null = null;
  /**
   * Cierres en curso por conversación. Reabrir una conversación espera a que su
   * cierre anterior haya guardado: si no, cargaría un historial viejo y el
   * guardado tardío del cierre pisaría luego el nuevo.
   */
  private readonly closing = new Map<string, Promise<void>>();
  /** Las tramas se procesan en orden: un `chat` justo tras `new_conversation` espera a la apertura. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ConversationHostOptions) {}

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
    const done = session.close().finally(() => {
      if (this.closing.get(conversationId) === done) this.closing.delete(conversationId);
    });
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
        this.open(frame.conversationId, frame.resume === true);
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
        if (this.opts.startupError?.fatal || !session) {
          this.emit({
            type: 'chat_rejected',
            conversationId: frame.conversationId,
            turnId: frame.turnId,
            reason: this.opts.startupError?.fatal ? 'sidecar_unavailable' : 'unknown_conversation',
            message: this.opts.startupError?.fatal
              ? this.opts.startupError.message
              : 'La conversación no está abierta en el agente.',
          });
          return;
        }
        session.chat(frame.turnId, frame.text, frame.attachments);
        return;
      }
      case 'cancel':
        this.sessions.get(frame.conversationId)?.cancel(frame.turnId);
        return;
      case 'workspace_touch':
        this.sessions.get(frame.conversationId)?.touchWorkspace();
        return;
      case 'confirm_response':
        this.sessions.get(frame.conversationId)?.answerConfirm(frame.callId, frame.decision);
        return;
      case 'answer_questions':
        this.sessions.get(frame.conversationId)?.answerQuestions(frame.requestId, frame.answers);
        return;
    }
  }

  private open(conversationId: string, resume: boolean): void {
    const existing = this.sessions.get(conversationId);
    if (existing) {
      this.emit({
        type: 'conversation_opened',
        conversationId,
        resumed: false,
        messageCount: existing.messageCount,
      });
      return;
    }
    if (this.opts.startupError?.fatal) {
      this.emit({
        type: 'conversation_error',
        conversationId,
        message: this.opts.startupError.message,
      });
      return;
    }

    let saved = null;
    if (resume) {
      try {
        saved = this.opts.store.load(conversationId);
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

    let session: ConversationSession;
    try {
      let workspace: ConversationWorkspace | undefined;
      try {
        workspace = this.opts.workspaces?.open(conversationId);
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
      session = new ConversationSession({
        workspace,
        conversationId,
        config: this.opts.config,
        router: this.opts.makeRouter(),
        store: this.opts.store,
        send: this.emit,
        initialMessages: saved?.messages,
        createdAt: saved?.createdAt,
        confirmTimeoutMs: this.opts.confirmTimeoutMs,
        questionsTimeoutMs: this.opts.questionsTimeoutMs,
      });
    } catch (err) {
      log.error('conversation open failed', { conversationId, err });
      this.emit({
        type: 'conversation_error',
        conversationId,
        message: `No se pudo iniciar el agente: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    this.sessions.set(conversationId, session);
    log.info('conversation opened', {
      conversationId,
      resumed: saved !== null,
      messages: session.messageCount,
    });
    this.emit({
      type: 'conversation_opened',
      conversationId,
      resumed: saved !== null,
      messageCount: session.messageCount,
    });
  }
}
