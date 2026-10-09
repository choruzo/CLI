import type { Message } from '../agent/types.js';
import type { IProvider } from '../providers/base.js';
import { getLogger } from '../logging/index.js';
import type { SaveSessionParams, SessionStore } from './store.js';
import type { SessionContext } from './types.js';
import type { TraceScope } from '../trace/recorder.js';

const log = getLogger('session');

/**
 * Historial apto para un checkpoint a mitad de turno (15.12). Si el proceso
 * muere justo después, lo guardado tiene que poder reanudarse: se quitan un
 * `assistant` con `tool_calls` sin todas sus respuestas (el provider rechazaría
 * el historial) y un mensaje de usuario final sin respuesta (el turno aparece
 * como interrumpido y se puede repetir).
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

/** Lo que el checkpointer no decide: todo `SaveSessionParams` salvo la identidad. */
export type CheckpointSnapshot = Omit<
  SaveSessionParams,
  'existingId' | 'expectedUpdatedAt' | 'forkedFrom' | 'llmProvider' | 'trace'
>;

export interface SessionCheckpointerOptions {
  /** Id con el que se guarda la sesión (el generado al arrancar o el reanudado). */
  id: string;
  /** `updatedAt` de la versión en disco de la que se parte (solo al reanudar). */
  expectedUpdatedAt?: string;
  /** Estado actual de la sesión; se llama en cada guardado. */
  snapshot: () => CheckpointSnapshot;
}

/**
 * Guardado incremental de la sesión del chat. Antes la CLI solo guardaba al
 * salir de forma limpia: un cierre de la ventana, un `kill` o un fallo a mitad
 * perdían la conversación entera (Desktop ya guardaba checkpoints, 15.12).
 *
 * Es el **único** escritor de la sesión durante el chat, incluido el guardado
 * final, porque lleva la concurrencia optimista: cada guardado parte del
 * `updatedAt` que escribió el anterior, y si otra terminal guardó entretanto,
 * `SessionStore.save` bifurca y los siguientes guardados siguen en el fork.
 * Los guardados se encadenan: nunca hay dos escrituras de la misma sesión a
 * la vez.
 */
export class SessionCheckpointer {
  private id: string;
  private expectedUpdatedAt: string | undefined;
  private forkedFromId: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** Huella del último historial guardado: un checkpoint sin cambios no escribe. */
  private lastSaved: { length: number; last: Message | undefined } | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly opts: SessionCheckpointerOptions,
  ) {
    this.id = opts.id;
    this.expectedUpdatedAt = opts.expectedUpdatedAt;
  }

  get sessionId(): string {
    return this.id;
  }

  /** Id de la sesión de la que esta se bifurcó, si algún guardado bifurcó. */
  get forkedFrom(): string | undefined {
    return this.forkedFromId;
  }

  /**
   * Guarda un checkpoint (sin resumen LLM) si hay algo nuevo que guardar.
   * Nunca lanza: un fallo se registra y el siguiente checkpoint lo reintenta.
   */
  checkpoint(): Promise<void> {
    return this.enqueue(async () => {
      const snap = this.opts.snapshot();
      const messages = checkpointMessages(snap.messages);
      if (!messages.some((m) => m.role === 'user')) return;
      const last = messages.at(-1);
      if (this.lastSaved?.length === messages.length && this.lastSaved.last === last) return;
      await this.write({ ...snap, messages });
      this.lastSaved = { length: messages.length, last };
    }).catch((err: unknown) => {
      log.warn('session checkpoint failed', { id: this.id, err });
    });
  }

  /**
   * Guardado final (con resumen si se pasa `llmProvider`). Lanza si falla. Con
   * `trace`, la llamada del resumen queda registrada como `session-summary`.
   */
  saveFinal(llmProvider?: IProvider, trace?: TraceScope): Promise<SessionContext> {
    return this.enqueue(() =>
      this.write({
        ...this.opts.snapshot(),
        ...(llmProvider ? { llmProvider } : {}),
        ...(trace ? { trace } : {}),
      }),
    );
  }

  private async write(params: Omit<SaveSessionParams, 'existingId'>): Promise<SessionContext> {
    const saved = await this.store.save({
      ...params,
      existingId: this.id,
      expectedUpdatedAt: this.expectedUpdatedAt,
      ...(this.forkedFromId ? { forkedFrom: this.forkedFromId } : {}),
    });
    if (saved.forkedFrom && saved.id !== this.id) {
      this.forkedFromId = saved.forkedFrom;
      this.id = saved.id;
    }
    this.expectedUpdatedAt = saved.updatedAt;
    return saved;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
