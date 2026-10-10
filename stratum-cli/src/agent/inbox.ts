/**
 * Runtime Inbox — cola de eventos de una sesión que llegan mientras el agente
 * trabaja: mensajes del usuario (*steering*) y finales de jobs en segundo
 * plano. El loop la drena en sus puntos seguros y lo cuenta en el contexto del
 * modelo como un bloque `<runtime_updates>`.
 *
 * Contrato:
 *  - FIFO por orden de llegada, y cada evento se entrega **una sola vez**;
 *  - por sesión (una por `StratumAgent`) y sin persistencia: no sobrevive al
 *    proceso;
 *  - con *scope*: los mensajes del usuario son siempre del agente principal
 *    (`MAIN_JOB_SCOPE`); el final de un job es del scope que lo lanzó. Un
 *    subagente drena con su scope y nunca ve el steering del usuario;
 *  - encolar nunca aborta nada ni lanza una llamada al modelo. Cancelar es otro
 *    camino (el `AbortSignal` del turno) y aquí no se infiere del texto.
 *
 * No hay hilos: «llegar mientras el loop trabaja» es un callback (teclado, fin
 * de un proceso) que corre entre dos `await` del loop. Lo que hace falta para
 * que no se pierda nada es que comprobar-y-cerrar sea **síncrono**: ver
 * `sealIfIdle`.
 *
 * Los jobs siguen siendo del `JobManager`: la inbox solo apunta *cuándo*
 * terminó cada uno (para ordenarlo con los mensajes) y, al drenar, le pregunta
 * al manager si su dueño aún no lo sabe (`claimNotification`). Un job que el
 * agente ya vio con una tool no se le cuenta otra vez.
 */
import type { JobManager } from '../jobs/manager.js';
import { MAIN_JOB_SCOPE, type JobNotification } from '../jobs/types.js';
import type { TraceScope } from '../trace/recorder.js';

export type RuntimeInboxEvent =
  | {
      id: string;
      type: 'user-message';
      scope: string;
      text: string;
      createdAt: number;
    }
  | {
      id: string;
      type: 'job-completed' | 'job-failed' | 'job-cancelled';
      scope: string;
      jobId: string;
      createdAt: number;
    };

export type UserMessageEvent = Extract<RuntimeInboxEvent, { type: 'user-message' }>;
export type JobInboxEvent = Exclude<RuntimeInboxEvent, { type: 'user-message' }>;

/** Un evento entregado: los de job llevan lo que el manager sabe de él. */
export type RuntimeUpdate =
  | { kind: 'user'; event: UserMessageEvent }
  | { kind: 'job'; event: JobInboxEvent; notification: JobNotification };

/** Lo drenado en un punto seguro, en orden de llegada. */
export interface RuntimeUpdateBatch {
  updates: RuntimeUpdate[];
  userMessages: UserMessageEvent[];
  jobs: JobNotification[];
}

export type InboxDropReason = 'history-cleared' | 'scope-closed' | 'already-known' | 'empty';

/** Cambios de la cola, para la UI (contador de pendientes, aviso de entrega). */
export type RuntimeInboxChange =
  | { type: 'enqueued'; event: RuntimeInboxEvent }
  | { type: 'consumed'; events: RuntimeInboxEvent[]; scope: string }
  | { type: 'dropped'; events: RuntimeInboxEvent[]; reason: InboxDropReason };

export type RuntimeInboxListener = (change: RuntimeInboxChange) => void;

/** Tope de un mensaje de steering: es una corrección, no un documento. */
export const MAX_STEERING_CHARS = 8000;

export class RuntimeInbox {
  private queue: RuntimeInboxEvent[] = [];
  private readonly listeners = new Set<RuntimeInboxListener>();
  private readonly closedScopes = new Set<string>();
  private seq = 0;
  /** Hay un turno del agente principal que todavía puede incorporar steering. */
  private accepting = false;
  private trace: TraceScope | undefined;
  private jobs: JobManager | undefined;
  private detachJobs: (() => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  // -------------------------------------------------------------------------
  // Ciclo de vida del turno
  // -------------------------------------------------------------------------

  /** Abre el turno del agente principal: desde aquí el steering se encola. */
  beginTurn(trace?: TraceScope): void {
    this.accepting = true;
    if (trace) this.trace = trace;
  }

  /**
   * Antes de dar el turno por terminado. Si hay steering del usuario pendiente
   * devuelve `false` y el loop **no** cierra: lo incorpora y sigue. Si no lo
   * hay, deja de aceptar steering **en la misma llamada síncrona**, así que
   * entre esta comprobación y el `done` no cabe un mensaje que se pierda: el
   * que llegue después se rechaza en `enqueueUserMessage` y quien lo envía
   * abre un turno nuevo con él.
   *
   * Solo el agente principal recibe steering; para cualquier otro scope no hay
   * nada que esperar ni que cerrar.
   */
  sealIfIdle(scope: string = MAIN_JOB_SCOPE): boolean {
    if (scope !== MAIN_JOB_SCOPE) return true;
    if (this.hasPendingUserMessages()) return false;
    this.accepting = false;
    return true;
  }

  /** El turno terminó (como sea). Lo que quedó sin entregar sigue en la cola. */
  endTurn(): void {
    this.accepting = false;
  }

  /** ¿Se encolaría ahora un mensaje del usuario como steering? */
  get acceptsSteering(): boolean {
    return this.accepting;
  }

  // -------------------------------------------------------------------------
  // Entrada
  // -------------------------------------------------------------------------

  /**
   * Encola un mensaje del usuario para el turno en curso. Devuelve `null` si
   * no hay turno que pueda incorporarlo (o el texto está vacío): entonces no
   * se ha guardado nada y el llamador sigue el camino normal de un turno nuevo.
   */
  enqueueUserMessage(text: string): UserMessageEvent | null {
    const clean = text.trim().slice(0, MAX_STEERING_CHARS);
    if (!this.accepting || !clean) return null;
    const event: UserMessageEvent = {
      id: this.nextId(),
      type: 'user-message',
      scope: MAIN_JOB_SCOPE,
      text: clean,
      createdAt: this.now(),
    };
    this.push(event);
    return event;
  }

  /**
   * Conecta los jobs de la sesión: cada job que termina deja un evento en la
   * cola, en el instante en que termina. `JobManager.subscribe` y el ownership
   * no cambian; esto es un suscriptor más.
   */
  attachJobs(manager: JobManager): void {
    this.detachJobs?.();
    this.jobs = manager;
    this.detachJobs = manager.subscribe((ev) => {
      if (ev.type !== 'ended' || ev.job.status === 'running') return;
      const event: JobInboxEvent = {
        id: this.nextId(),
        type: `job-${ev.job.status}`,
        scope: ev.job.owner.scope,
        jobId: ev.job.id,
        createdAt: this.now(),
      };
      if (this.closedScopes.has(event.scope)) {
        this.traceDrop([event], 'scope-closed');
        return;
      }
      this.push(event);
    });
  }

  // -------------------------------------------------------------------------
  // Consulta
  // -------------------------------------------------------------------------

  hasPendingUserMessages(): boolean {
    return this.queue.some((e) => e.type === 'user-message');
  }

  /** Mensajes del usuario encolados y aún no entregados, del más antiguo al más nuevo. */
  pendingUserMessages(): UserMessageEvent[] {
    return this.queue.filter((e): e is UserMessageEvent => e.type === 'user-message');
  }

  /** Eventos pendientes de `scope` (todos si se omite). */
  pending(scope?: string): RuntimeInboxEvent[] {
    return this.queue.filter((e) => scope === undefined || e.scope === scope);
  }

  subscribe(listener: RuntimeInboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Salida
  // -------------------------------------------------------------------------

  /**
   * Punto seguro: saca de la cola, en orden de llegada, todo lo pendiente de
   * `scope`. Quien drena se compromete a contárselo al modelo en su siguiente
   * petición. `null` si no hay nada que contar.
   *
   * Un job que su dueño ya conoce (lo vio con `get_job_status`, o ya se le
   * avisó por otra vía) sale de la cola sin entrar en el lote.
   */
  drain(scope: string, trace?: TraceScope): RuntimeUpdateBatch | null {
    const mine: RuntimeInboxEvent[] = [];
    const rest: RuntimeInboxEvent[] = [];
    for (const e of this.queue) (e.scope === scope ? mine : rest).push(e);
    if (mine.length === 0) return null;
    this.queue = rest;

    const updates: RuntimeUpdate[] = [];
    const stale: RuntimeInboxEvent[] = [];
    for (const event of mine) {
      if (event.type === 'user-message') {
        updates.push({ kind: 'user', event });
        continue;
      }
      const notification = this.jobs?.claimNotification(event.jobId, scope) ?? null;
      if (notification) updates.push({ kind: 'job', event, notification });
      else stale.push(event);
    }
    if (stale.length > 0) this.drop(stale, 'already-known');
    if (updates.length === 0) return null;

    const consumed = updates.map((u) => u.event);
    const at = this.now();
    const sink = trace ?? this.trace;
    for (const event of consumed) {
      sink?.runtime({
        event: 'inbox',
        phase: 'consume',
        id: event.id,
        type: event.type,
        scope,
        waitMs: Math.max(0, at - event.createdAt),
        batch: consumed.length,
        ...(event.type === 'user-message' ? { chars: event.text.length } : { jobId: event.jobId }),
      });
    }
    this.emit({ type: 'consumed', events: consumed, scope });
    return {
      updates,
      userMessages: updates.flatMap((u) => (u.kind === 'user' ? [u.event] : [])),
      jobs: updates.flatMap((u) => (u.kind === 'job' ? [u.notification] : [])),
    };
  }

  /**
   * Steering que un turno cortado dejó sin entregar. Lo recoge `StratumAgent`
   * al abrir el turno siguiente, para ponerlo delante de la petición nueva.
   */
  takeUndeliveredUserMessages(trace?: TraceScope): UserMessageEvent[] {
    const mine = this.pendingUserMessages();
    if (mine.length === 0) return [];
    this.queue = this.queue.filter((e) => e.type !== 'user-message');
    const at = this.now();
    const sink = trace ?? this.trace;
    for (const event of mine) {
      sink?.runtime({
        event: 'inbox',
        phase: 'consume',
        id: event.id,
        type: event.type,
        scope: event.scope,
        waitMs: Math.max(0, at - event.createdAt),
        batch: mine.length,
        chars: event.text.length,
        late: true,
      });
    }
    this.emit({ type: 'consumed', events: mine, scope: MAIN_JOB_SCOPE });
    return mine;
  }

  /**
   * El subagente dueño de `scope` terminó: nadie va a drenar lo suyo. Lo
   * pendiente se descarta y lo que llegue después (sus jobs, que se cancelan
   * con él) ya no se encola.
   */
  closeScope(scope: string): void {
    if (scope === MAIN_JOB_SCOPE) return;
    this.closedScopes.add(scope);
    this.dropWhere((e) => e.scope === scope, 'scope-closed');
  }

  /** `/clear` o cambio de sesión: el steering pendiente era de otra conversación. */
  clearUserMessages(): void {
    this.dropWhere((e) => e.type === 'user-message', 'history-cleared');
  }

  /** Cierre de la sesión: suelta la suscripción a los jobs. */
  dispose(): void {
    this.detachJobs?.();
    this.detachJobs = undefined;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------

  private nextId(): string {
    return `rin_${++this.seq}`;
  }

  private push(event: RuntimeInboxEvent): void {
    this.queue.push(event);
    // Del mensaje se traza el tamaño, nunca el texto: el contenido ya queda en
    // el historial cuando se entrega, y la traza no guarda una segunda copia.
    this.trace?.runtime({
      event: 'inbox',
      phase: 'enqueue',
      id: event.id,
      type: event.type,
      scope: event.scope,
      ...(event.type === 'user-message' ? { chars: event.text.length } : { jobId: event.jobId }),
    });
    this.emit({ type: 'enqueued', event });
  }

  private dropWhere(match: (e: RuntimeInboxEvent) => boolean, reason: InboxDropReason): void {
    const dropped = this.queue.filter(match);
    if (dropped.length === 0) return;
    this.queue = this.queue.filter((e) => !match(e));
    this.drop(dropped, reason);
  }

  private drop(events: RuntimeInboxEvent[], reason: InboxDropReason): void {
    this.traceDrop(events, reason);
    this.emit({ type: 'dropped', events, reason });
  }

  private traceDrop(events: RuntimeInboxEvent[], reason: InboxDropReason): void {
    for (const event of events) {
      this.trace?.runtime({
        event: 'inbox',
        phase: 'drop',
        id: event.id,
        type: event.type,
        scope: event.scope,
        reason,
      });
    }
  }

  private emit(change: RuntimeInboxChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        /* un listener de UI nunca puede afectar a la cola */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cómo entra en el contexto
// ---------------------------------------------------------------------------

export const RUNTIME_UPDATES_OPEN = '<runtime_updates>';
const RUNTIME_UPDATES_CLOSE = '</runtime_updates>';

/** ¿Es un mensaje que solo lleva un bloque de avisos del runtime? */
export function isRuntimeUpdatesMessage(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(RUNTIME_UPDATES_OPEN);
}

/** Varias líneas de un mismo mensaje quedan bajo su número, no como ítems nuevos. */
function indentContinuation(text: string): string {
  return text.replace(/\r?\n/g, '\n   ');
}

/**
 * El bloque que ve el modelo. Deja clara la cronología: esto llegó **después**
 * de la petición original, mientras el agente trabajaba; no es parte de ella.
 * `jobLine` formatea un job (lo inyecta el loop, que es quien redacta).
 */
export function formatRuntimeUpdates(
  batch: RuntimeUpdateBatch,
  jobLine: (n: JobNotification) => string,
): string {
  const hasUser = batch.userMessages.length > 0;
  const head = hasUser
    ? 'Runtime updates since your previous model call, oldest first. The user messages below ' +
      'were sent while you were already working on the request above: they are newer than it, ' +
      'they are not part of the original request, and where they conflict with it they take ' +
      'precedence. Take them into account before your next action, and keep working on the same task.'
    : 'Runtime updates since your previous model call, oldest first.';
  const lines = batch.updates.map((u, i) =>
    u.kind === 'user'
      ? `${i + 1}. User: ${indentContinuation(u.event.text)}`
      : `${i + 1}. ${jobLine(u.notification)}`,
  );
  return `${RUNTIME_UPDATES_OPEN}\n${head}\n${lines.join('\n')}\n${RUNTIME_UPDATES_CLOSE}`;
}

/**
 * Steering que quedó sin entregar porque su turno se cortó (Ctrl+C, error,
 * límite de iteraciones). Se antepone a la siguiente petición del usuario,
 * que es su sitio en la cronología.
 */
export function formatUndeliveredUserMessages(messages: readonly UserMessageEvent[]): string {
  const lines = messages.map((m, i) => `${i + 1}. User: ${indentContinuation(m.text)}`);
  return (
    `${RUNTIME_UPDATES_OPEN}\n` +
    'The user sent these messages while the previous turn was still running. That turn ended ' +
    'before you saw them; they are older than the message that follows.\n' +
    `${lines.join('\n')}\n${RUNTIME_UPDATES_CLOSE}`
  );
}

/** Resultado de una tool call que no se ejecutó porque llegó steering antes. */
export const SUPERSEDED_BY_STEERING =
  'Not executed: the user sent a new message after you issued this call and before it ran. ' +
  'Nothing was changed. Read the runtime update below and decide again what to do; repeat ' +
  'this call only if it is still what the user wants.';
