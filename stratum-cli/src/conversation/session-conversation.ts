/**
 * La conversación de **una** sesión (M11): las tres capas, separadas.
 *
 *   ConversationStore   todo lo que se dijo, entero y duradero (no se compacta)
 *   SessionMemory       lo extraído de lo antiguo, con procedencia
 *   ContextState        qué entradas forman hoy el contexto activo del agente
 *
 * El agente sigue trabajando con su historial en memoria (lo reciente); esta
 * pieza lo **registra** en el store —cada mensaje con un id estable— y hace la
 * compactación: extraer y resumir un trozo antiguo, y solo si todo sale bien
 * (y la memoria nueva está en disco) dejar que el `ContextManager` lo quite
 * del contexto. Un fallo no toca ni el store ni la memoria anterior.
 */
import type { Message } from '../agent/types.js';
import type { TraceScope } from '../trace/recorder.js';
import { getLogger } from '../logging/index.js';
import { MemoryCallError, runExtractor, runSummarizer, type ChunkEntry } from './extract.js';
import {
  MAX_COMPACTION_RECORDS,
  emptyContextState,
  type CompactionRecord,
  type ContextState,
} from './files.js';
import { fromStoredMessage, toStoredMessage } from './messages.js';
import type { MemoryModels } from './models.js';
import {
  applyMemoryUpdate,
  emptySessionMemory,
  memoryCounts,
  renderSessionMemory,
  type MemoryItemKind,
  type SessionMemory,
  type UpdateReport,
} from './session-memory.js';
import type { ConversationStore } from './store.js';

const log = getLogger('conversation');

/** Dónde se guardan memoria y estado. Atómico; lanza si no pudo. */
export interface ConversationPersistence {
  saveMemory(memory: SessionMemory): void;
  saveState(state: ContextState): void;
}

export interface SessionConversationOptions {
  sessionId: string;
  store: ConversationStore;
  memory?: SessionMemory;
  state?: ContextState;
  persistence?: ConversationPersistence;
  now?: () => number;
}

export type CompactionOutcome =
  | { ok: true; memoryVersion: number; report: UpdateReport }
  | {
      ok: false;
      cancelled: boolean;
      reason: 'busy' | 'models' | 'extractor' | 'summarizer' | 'persist' | 'cancelled';
      error: string;
    };

export interface CompactionCall {
  chunk: Message[];
  models: MemoryModels;
  timeoutMs: number;
  signal?: AbortSignal;
  trace?: TraceScope;
  tokensBefore: number;
  tokensAfter: number;
}

export interface ConversationStats {
  /** Mensajes del historial del agente guardados. */
  storedAgentMessages: number;
  /** Mensajes de la conversación para personas guardados. */
  storedMessages: number;
  /** Mensajes de la conversación en el contexto activo. */
  activeMessages: number;
  compactions: number;
  lastCompactionAt: number | null;
  lastCompactionError: string | null;
  compacting: boolean;
  memory: {
    version: number;
    updatedAt: string | null;
    hasSummary: boolean;
    items: Record<MemoryItemKind, number>;
    sourceCursor: string | null;
  };
}

interface Recorded {
  id: string;
  content: string | null;
}

export class SessionConversation {
  readonly sessionId: string;
  readonly store: ConversationStore;
  private memoryValue: SessionMemory;
  private stateValue: ContextState;
  private readonly persistence: ConversationPersistence | undefined;
  private readonly now: () => number;
  /** Qué objeto del historial es qué entrada del store, y con qué contenido se guardó. */
  private readonly recorded = new WeakMap<Message, Recorded>();
  private inFlight: Promise<CompactionOutcome> | null = null;

  constructor(opts: SessionConversationOptions) {
    this.sessionId = opts.sessionId;
    this.store = opts.store;
    this.memoryValue = opts.memory ?? emptySessionMemory(opts.sessionId);
    this.stateValue = opts.state ?? emptyContextState(opts.sessionId);
    this.persistence = opts.persistence;
    this.now = opts.now ?? Date.now;
  }

  get memory(): SessionMemory {
    return this.memoryValue;
  }

  get state(): ContextState {
    return this.stateValue;
  }

  get compacting(): boolean {
    return this.inFlight !== null;
  }

  /** Id en el store de un mensaje del historial, si ya se registró. */
  idOf(message: Message): string | undefined {
    return this.recorded.get(message)?.id;
  }

  /**
   * Registra en el store lo nuevo del historial activo: un mensaje que aún no
   * tiene id se añade; uno cuyo contenido creció (un aviso del runtime anexado)
   * se enmienda. El system prompt no se guarda: se recompone siempre.
   */
  record(messages: readonly Message[]): void {
    for (const message of messages) {
      if (message.role === 'system') continue;
      const seen = this.recorded.get(message);
      const content = message.content ?? null;
      if (!seen) {
        const id = this.store.appendAgent(toStoredMessage(message), { at: this.now() });
        this.recorded.set(message, { id, content });
      } else if (seen.content !== content) {
        this.store.amendAgent(seen.id, content);
        seen.content = content;
      }
    }
  }

  /**
   * El contexto activo que había al guardar el estado, reconstruido desde el
   * store (sin el system prompt, que recompone el agente). Los mensajes quedan
   * asociados a sus ids: no se vuelven a guardar.
   */
  restoreActive(): Message[] {
    const out: Message[] = [];
    let missing = 0;
    for (const id of this.stateValue.activeIds) {
      const entry = this.store.getAgent(id);
      if (!entry) {
        missing++;
        continue;
      }
      const message = fromStoredMessage(entry.message);
      this.recorded.set(message, { id, content: message.content ?? null });
      out.push(message);
    }
    if (missing > 0) log.warn('active context entries missing from the store', { missing });
    return dropUnpaired(out);
  }

  /** Guarda qué entradas forman el contexto activo (fin de turno, tras compactar). */
  saveState(messages: readonly Message[]): void {
    this.record(messages);
    const activeIds: string[] = [];
    for (const m of messages) {
      const id = this.recorded.get(m)?.id;
      if (id) activeIds.push(id);
    }
    this.stateValue = { ...this.stateValue, activeIds };
    this.persistState();
    this.store.flush();
  }

  private persistState(): void {
    try {
      this.persistence?.saveState(this.stateValue);
    } catch (err) {
      log.warn('context state not saved', { sessionId: this.sessionId, err });
    }
  }

  /**
   * Compacta un trozo a la memoria de sesión. Una sola a la vez por sesión.
   * Solo devuelve `ok` si la memoria nueva quedó guardada; entonces, y no
   * antes, quien llama puede quitar el trozo del contexto.
   */
  compact(call: CompactionCall): Promise<CompactionOutcome> {
    if (this.inFlight) {
      return Promise.resolve({
        ok: false,
        cancelled: false,
        reason: 'busy',
        error: 'a compaction is already running',
      });
    }
    const run = this.runCompaction(call).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async runCompaction(call: CompactionCall): Promise<CompactionOutcome> {
    if (!call.models.ok) {
      return this.fail('models', call.models.message);
    }
    const { extractor, summarizer } = call.models;
    // Cada mensaje del trozo tiene que tener ya su id: la procedencia apunta ahí.
    this.record(call.chunk);
    const entries: ChunkEntry[] = call.chunk.map((m) => ({
      id: this.recorded.get(m)!.id,
      message: toStoredMessage(m),
    }));
    const opts = {
      timeoutMs: call.timeoutMs,
      sessionId: this.sessionId,
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.trace ? { trace: call.trace } : {}),
    };
    const before = this.memoryValue;
    let extraction;
    let summary: string;
    try {
      extraction = await runExtractor(extractor, before, entries, opts);
    } catch (err) {
      return this.callFailed('extractor', err);
    }
    try {
      summary = await runSummarizer(summarizer, before, entries, opts);
    } catch (err) {
      return this.callFailed('summarizer', err);
    }
    const ids = entries.map((e) => e.id);
    const { memory, report } = applyMemoryUpdate(before, {
      extraction,
      summary,
      chunk: ids,
      order: (id) => this.store.orderOf(id),
      now: new Date(this.now()).toISOString(),
    });
    try {
      this.persistence?.saveMemory(memory);
    } catch (err) {
      // La memoria anterior sigue siendo la buena: no se ha cambiado nada.
      return this.fail('persist', `session memory not saved: ${errorText(err)}`);
    }
    this.memoryValue = memory;
    const record: CompactionRecord = {
      at: this.now(),
      ids,
      memoryVersion: memory.version,
      tokensBefore: call.tokensBefore,
      tokensAfter: call.tokensAfter,
      extractor: `${extractor.providerName}/${extractor.model}`,
      summarizer: `${summarizer.providerName}/${summarizer.model}`,
    };
    this.stateValue = {
      ...this.stateValue,
      compactions: [...this.stateValue.compactions, record].slice(-MAX_COMPACTION_RECORDS),
      compactionCount: this.stateValue.compactionCount + 1,
      lastCompactionAt: record.at,
      lastCompactionError: null,
    };
    const version = memory.version;
    // Solo recuentos: ni el texto de la memoria ni el de la conversación.
    log.info('conversation compacted', {
      sessionId: this.sessionId,
      entries: ids.length,
      memoryVersion: version,
      ...report,
    });
    return { ok: true, memoryVersion: version, report };
  }

  private callFailed(reason: 'extractor' | 'summarizer', err: unknown): CompactionOutcome {
    if (err instanceof MemoryCallError && err.cancelled) {
      return { ok: false, cancelled: true, reason: 'cancelled', error: 'cancelled' };
    }
    return this.fail(reason, errorText(err));
  }

  private fail(
    reason: Extract<CompactionOutcome, { ok: false }>['reason'],
    error: string,
  ): CompactionOutcome {
    // Sin el contenido de la conversación: solo el motivo.
    log.warn('compaction deferred', { sessionId: this.sessionId, reason, error });
    this.stateValue = { ...this.stateValue, lastCompactionError: error };
    this.persistState();
    return { ok: false, cancelled: false, reason, error };
  }

  /** El bloque de memoria para el system prompt, dentro de su presupuesto. */
  renderMemory(maxChars: number): string {
    return renderSessionMemory(this.memoryValue, maxChars);
  }

  stats(activeMessages?: number): ConversationStats {
    const memory = this.memoryValue;
    return {
      storedAgentMessages: this.store.agentCount(),
      storedMessages: this.store.chatCount(),
      activeMessages: activeMessages ?? this.stateValue.activeIds.length,
      compactions: this.stateValue.compactionCount,
      lastCompactionAt: this.stateValue.lastCompactionAt,
      lastCompactionError: this.stateValue.lastCompactionError,
      compacting: this.compacting,
      memory: {
        version: memory.version,
        updatedAt: memory.updatedAt,
        hasSummary: memory.summary !== null,
        items: memoryCounts(memory),
        sourceCursor: memory.sourceCursor,
      },
    };
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Un contexto reconstruido no puede empezar por resultados de tools sin su
 * llamada, ni acabar con llamadas sin respuesta: el provider lo rechazaría.
 */
function dropUnpaired(messages: Message[]): Message[] {
  const out: Message[] = [];
  let open = new Set<string>();
  for (const m of messages) {
    if (m.role === 'assistant') {
      open = new Set((m.tool_calls ?? []).map((c) => c.id));
      out.push(m);
    } else if (m.role === 'tool') {
      if (m.tool_call_id && open.has(m.tool_call_id)) out.push(m);
    } else {
      open = new Set();
      out.push(m);
    }
  }
  // Llamadas sin respuesta al final (el proceso murió a mitad de un lote).
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    let j = i + 1;
    while (j < out.length && out[j]!.role === 'tool') answered.add(out[j++]!.tool_call_id ?? '');
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    if (missing.length > 0) {
      out.splice(
        j,
        0,
        ...missing.map(
          (c): Message => ({
            role: 'tool',
            tool_call_id: c.id,
            name: c.function.name,
            content: '<interrupted reason="session_restored"/>',
          }),
        ),
      );
    }
  }
  return out;
}
