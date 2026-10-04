import type { StratumConfig } from '../config/schema.js';
import type { IProvider, CompletionRequest } from '../providers/base.js';
import type { ToolSchema } from '../providers/base.js';
import { StreamBuffer, ThinkTagSplitter } from '../providers/openai-compatible.js';
import { streamWithRetry } from '../providers/retry.js';
import type {
  AgentEvent,
  AgentMode,
  Message,
  Plan,
  PlanDecision,
  PlanStepStatus,
  QuestionAnswer,
  TokenAccounting,
  ToolCallReady,
  ToolContext,
  RunOptions,
  WorkspaceConfinement,
} from './types.js';
import type { ToolRegistry, DispatchResult, ToolsetFilter } from '../tools/registry.js';
import {
  ToolDispatcher,
  composeToolsetFilters,
  isToolVisibleForProfile,
} from '../tools/registry.js';
import { READ_ONLY_TOOLSET, requirePlanViolation } from '../tools/call-policy.js';
import { callEffects } from '../tools/environments.js';
import {
  PLAN_ALLOWLIST,
  PLAN_READ_ONLY_CALL_TOOLS,
  PRESENT_PLAN_TOOL,
  UPDATE_PLAN_TOOL,
  makePlanFromProposal,
  buildExecutionInjection,
  isPlanComplete,
} from './plan.js';
import { DELEGATE_TASK_TOOL } from '../tools/agent/delegate.js';
import {
  QUESTION_TOOL,
  parseQuestionInput,
  formatQuestionAnswers,
  resolveQuestionAnswers,
} from '../tools/question.js';
import { TODO_TOOL } from '../tools/todo.js';
import { untilAborted } from './concurrency.js';
import { CANCELLED_BY_USER } from './cancel.js';
import { TEST_EVIDENCE_TOOL } from '../tools/tdd.js';
import {
  TddError,
  TddLedger,
  applyTddToSystemMessage,
  formatTddSnapshot,
  type TddRecordInput,
} from './tdd.js';
import {
  TodoError,
  TodoList,
  applyTodoToSystemMessage,
  formatTodoSnapshot,
  type TodoInput,
} from './todo.js';
import { truncateToolOutput } from '../tools/truncate.js';
import { redactText } from '../security/redact-output.js';
import type { ProfileLoader } from './profiles.js';
import { ChangeTracker, changeFromToolCall } from './risk.js';
import { serializeSubagentResult, generateSubagentId } from './subagent.js';
import { executeDelegations, resolveDelegationProfile, type DelegationJob } from './delegation.js';
import { getDecisionMemory } from '../memory/decision-memory.js';
import { getLogger } from '../logging/index.js';
import type { FileStateTracker } from '../tools/fs/file-state.js';

const log = getLogger('agent');

// Fix #4: respeta toolErrorFormat de config (spec 12.3)
function formatToolError(
  toolName: string,
  error: string,
  format: 'xml' | 'json' = 'xml',
  suggestion?: string,
): string {
  const hint =
    suggestion ?? 'Review the error above and adjust the tool call parameters accordingly.';
  if (format === 'json') {
    return JSON.stringify({ tool: toolName, error, suggestion: hint });
  }
  return `<tool_error>\n  <tool>${toolName}</tool>\n  <error>${error}</error>\n  <suggestion>${hint}</suggestion>\n</tool_error>`;
}

// ---------------------------------------------------------------------------
// Resultado de compresión (para emitir eventos desde el loop)
// ---------------------------------------------------------------------------
export type CompressionResult =
  | { kind: 'skipped' }
  | { kind: 'compressed'; tokensBefore: number; tokensAfter: number; roundsCompressed: number }
  | {
      kind: 'truncated';
      tokensBefore: number;
      tokensAfter: number;
      roundsRemoved: number;
      /** Por qué no sirvió el resumen LLM (ausente si no había compresor). */
      compressorError?: string;
    }
  /** `/compact` forzado: el resumen falló y no hacía falta truncar nada. */
  | { kind: 'failed'; error: string }
  | { kind: 'pressure'; compressorError?: string }; // zona protegida sola ya supera umbral

/** Timeout por defecto del resumen LLM: un modelo local con razonamiento tarda ~40 s. */
export const DEFAULT_COMPRESSION_TIMEOUT_MS = 120_000;

/** Tope por mensaje en la entrada del compresor: el resumen necesita el hilo, no los volcados. */
const COMPRESSOR_TOOL_CHARS = 1_500;
const COMPRESSOR_TEXT_CHARS = 4_000;

const COMPRESSOR_PROMPT =
  'Summarize the conversation below so an agent can continue the work without it. ' +
  'At most 500 words. Preserve: the user requests and goals, technical decisions and ' +
  'their reasons, files read or changed, commands run and their outcome, errors found, ' +
  'and what is still pending. Write in the language the user writes in. ' +
  'Output only the summary.';

/**
 * Error del compresor. `cancelled` distingue la cancelación del usuario de un
 * fallo: cancelar no debe tocar el historial.
 */
class CompressorError extends Error {
  constructor(
    message: string,
    readonly cancelled = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// ContextManager — §12.4
// ---------------------------------------------------------------------------
export class ContextManager {
  /** Dato real de `usage.prompt_tokens` del último LLM call (null = no disponible aún). */
  private lastPromptTokens: number | null = null;

  /**
   * Tokens por "char-token" del proxy, calibrado con el último `usage` real
   * (null = sin dato todavía → se usa el proxy chars/3.5 sin corregir).
   */
  private tokenRatio: number | null = null;

  /** Modo de compresión activo (F6). 'conservative' sube el umbral y conserva más rondas. */
  private mode: 'normal' | 'conservative' = 'normal';

  constructor(
    private readonly contextWindow: number,
    private readonly baseKeepRounds: number,
    private readonly provider?: IProvider,
    private readonly model?: string,
    private readonly baseCompressionThreshold = 0.8,
    private readonly compressorModel?: string,
    private readonly compressionTimeoutMs = DEFAULT_COMPRESSION_TIMEOUT_MS,
  ) {}

  setCompressionMode(mode: 'normal' | 'conservative'): void {
    this.mode = mode;
  }

  /** Umbral efectivo según el modo (F6: en conservative se sube a ≥0.92). */
  private get compressionThreshold(): number {
    return this.mode === 'conservative'
      ? Math.max(this.baseCompressionThreshold, 0.92)
      : this.baseCompressionThreshold;
  }

  /** Rondas protegidas efectivas según el modo (F6: en conservative se duplican). */
  private get keepRounds(): number {
    return this.mode === 'conservative' ? this.baseKeepRounds * 2 : this.baseKeepRounds;
  }

  // -------------------------------------------------------------------------
  // Estimación de tokens — cascada §12.4
  // -------------------------------------------------------------------------

  /**
   * Registra el `usage.prompt_tokens` reportado por el provider.
   *
   * Si se pasan los mensajes con los que se hizo ese request, se calibra el
   * proxy chars/3.5 contra el tokenizador real del modelo: la constante fija
   * se desvía con facilidad un 40% (código y texto repetitivo tokenizan mucho
   * mejor que prosa), lo que hace comprimir de más o de menos.
   */
  /**
   * El historial se sustituyó por completo (`/clear`, reanudar otra sesión): el
   * último `prompt_tokens` ya no describe nada. La calibración del tokenizador
   * se conserva, es del modelo y no del historial.
   */
  forgetLastUsage(): void {
    this.lastPromptTokens = null;
  }

  recordUsage(promptTokens: number, messages?: Message[]): void {
    this.lastPromptTokens = promptTokens;
    if (messages) {
      const chars = this.estimateFromChars(messages);
      if (chars > 0 && promptTokens > 0) this.tokenRatio = promptTokens / chars;
      log.debug('context calibration', { promptTokens, proxy: chars, ratio: this.tokenRatio });
    }
  }

  /** Estima tokens a partir de chars cuando no hay dato del provider. */
  private estimateFromChars(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (msg.content) chars += msg.content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += tc.function.name.length + tc.function.arguments.length;
        }
      }
    }
    return Math.ceil(chars / 3.5);
  }

  /**
   * Devuelve uso actual del contexto. `estimated=true` cuando se usa proxy chars/3.5.
   *
   * `lastPromptTokens` es el `prompt_tokens` del LLM call **anterior**: no incluye
   * la respuesta del assistant ni los tool results inyectados después (que llegan a
   * ~30k chars ≈ 8.5k tokens tras el truncado del dispatcher). Tomar el máximo de
   * ambas fuentes evita que la compresión se dispare tarde — o nunca — cuando una
   * sola tool ha metido un cuarto de la ventana de contexto desde el último usage.
   */
  usage(messages: Message[]): { used: number; max: number; pct: number; estimated: boolean } {
    const rawChars = this.estimateFromChars(messages);
    // Proxy corregido con el tokenizador real del modelo cuando hay calibración.
    const fromChars = this.tokenRatio !== null ? Math.ceil(rawChars * this.tokenRatio) : rawChars;
    const real = this.lastPromptTokens;

    const used = real !== null ? Math.max(real, fromChars) : fromChars;
    // Solo es dato "real" mientras el proxy por chars no lo supere.
    const estimated = real === null || fromChars > real;

    const max = this.contextWindow;
    const pct = max > 0 ? Math.round((used / max) * 100) : 0;
    return { used, max, pct, estimated };
  }

  /** Proxy por chars corregido con la calibración del tokenizador real. */
  private estimateCalibrated(messages: Message[]): number {
    const raw = this.estimateFromChars(messages);
    return this.tokenRatio !== null ? Math.ceil(raw * this.tokenRatio) : raw;
  }

  // Mantener firma compatible con los tests existentes
  estimateTokens(messages: Message[]): number {
    return this.estimateFromChars(messages);
  }

  // -------------------------------------------------------------------------
  // Compresión — §12.4
  // -------------------------------------------------------------------------

  /**
   * Comprime el historial si supera el umbral configurado (default 80%).
   * Modifica `messages` en el lugar. Devuelve el resultado para emitir eventos.
   * `signal` es la cancelación del turno: cancelar durante el resumen deja el
   * historial intacto.
   */
  async maybeCompress(messages: Message[], signal?: AbortSignal): Promise<CompressionResult> {
    // Sin redondear: `pct` viene de Math.round y un 80.4% real se leería como 0.80.
    const { used, max } = this.usage(messages);
    if (max > 0 && used / max <= this.compressionThreshold) return { kind: 'skipped' };
    return this.compress(messages, signal, false);
  }

  /**
   * Comprime el historial **sin comprobar el umbral** (Hito 10): es la vía que
   * usa `/compact`, donde el usuario pide la compresión explícitamente y el
   * contexto está, por definición, por debajo del umbral automático.
   */
  async compress(
    messages: Message[],
    signal?: AbortSignal,
    forced = true,
  ): Promise<CompressionResult> {
    const tokensBefore = this.usage(messages).used;
    const zone = this.buildProtectedZone(messages);
    const oldMessages = zone.compressible.map((i) => messages[i]!);

    if (oldMessages.length === 0) {
      // Toda la conversación está en zona protegida — presión irresolvible
      return { kind: 'pressure' };
    }

    // -----------------------------------------------------------------------
    // Intento 1: compresión vía LLM call
    // -----------------------------------------------------------------------
    let compressorError: string | undefined;
    if (this.provider) {
      try {
        const anchor = zone.anchor !== null ? messages[zone.anchor] : undefined;
        const summary = await this.callCompressor(oldMessages, anchor, signal);
        this.applySummary(messages, zone, summary);
        this.sanitizeToolPairing(messages);
        // Invalidar cache de tokens reales (el historial cambió)
        this.lastPromptTokens = null;

        const tokensAfter = this.estimateCalibrated(messages);
        const newPct = this.contextWindow > 0 ? tokensAfter / this.contextWindow : 0;
        if (forced || newPct <= this.compressionThreshold) {
          return {
            kind: 'compressed',
            tokensBefore,
            tokensAfter,
            roundsCompressed: oldMessages.length,
          };
        }
        compressorError = 'the summary did not bring the context below the threshold';
      } catch (err) {
        if (err instanceof CompressorError && err.cancelled) return { kind: 'skipped' };
        // Caso A: falla → no reintentar → ir a truncado duro
        compressorError = err instanceof Error ? err.message : String(err);
        log.warn('context compressor failed', { error: compressorError });
      }
    }

    // -----------------------------------------------------------------------
    // Caso B: truncado duro
    // -----------------------------------------------------------------------
    return this.hardTruncate(messages, tokensBefore, compressorError);
  }

  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  /**
   * Zona protegida (§12.4):
   *  - el system prompt (índice 0);
   *  - la **cola**: las últimas `keepRounds` respuestas del assistant con sus
   *    tool results, más el `user` que abre la primera si va justo delante. En
   *    un chat sin tools cada assistant es una ronda; en un turno agéntico, una
   *    iteración;
   *  - el **ancla**: si la cola no contiene ningún `user` (un turno agéntico
   *    largo), el último `user` anterior a ella, que es la tarea en curso. Sin
   *    él, tras comprimir el agente seguiría trabajando sin saber para qué.
   *
   * Lo comprimible es todo lo que hay entre el system y la cola salvo el ancla.
   */
  private buildProtectedZone(messages: Message[]): {
    tailStart: number;
    anchor: number | null;
    compressible: number[];
  } {
    let tailStart = messages.length;
    let assistants = 0;
    for (let i = messages.length - 1; i > 0 && assistants < this.keepRounds; i--) {
      if (messages[i]?.role === 'assistant') {
        assistants++;
        tailStart = i;
      }
    }
    if (assistants < this.keepRounds) tailStart = 1;
    if (tailStart > 1 && messages[tailStart - 1]?.role === 'user') tailStart--;

    let anchor: number | null = null;
    const tailHasUser = messages.slice(tailStart).some((m) => m.role === 'user');
    if (!tailHasUser) {
      for (let i = tailStart - 1; i > 0; i--) {
        if (messages[i]?.role === 'user') {
          anchor = i;
          break;
        }
      }
    }

    const compressible: number[] = [];
    for (let i = 1; i < tailStart; i++) if (i !== anchor) compressible.push(i);
    return { tailStart, anchor, compressible };
  }

  /**
   * Sustituye lo comprimible por el resumen sin romper la alternancia de roles
   * (varias plantillas de chat rechazan dos `assistant` seguidos o que el
   * primer mensaje tras el system no sea `user`):
   *  - con ancla, la cola empieza por un assistant: el resumen va en su texto,
   *    justo después de la tarea, que queda literal;
   *  - si la cola empieza por un `user`, el resumen lo precede en su texto;
   *  - si no, el resumen es un `user` propio tras el system.
   */
  private applySummary(
    messages: Message[],
    zone: { tailStart: number; anchor: number | null },
    summary: string,
  ): void {
    const block = `<summary>\n${summary}\n</summary>`;
    const prepend = (msg: Message): Message => ({
      ...msg,
      content: msg.content ? `${block}\n\n${msg.content}` : block,
    });

    const head: Message[] = [messages[0]!];
    const tail = messages.slice(zone.tailStart);
    if (zone.anchor !== null) head.push(messages[zone.anchor]!);

    if (tail[0] && (zone.anchor !== null || tail[0].role === 'user')) {
      tail[0] = prepend(tail[0]);
    } else {
      head.push({ role: 'user', content: block });
    }
    messages.splice(0, messages.length, ...head, ...tail);
  }

  /**
   * Repara el emparejamiento assistant↔tool tras una compresión (red de seguridad).
   *
   * La API OpenAI-compatible rechaza con 400 tanto un `tool` sin el assistant que lo
   * pidió como un assistant con `tool_calls` sin todas sus respuestas. Como el
   * historial se muta en el lugar, un 400 aquí no es recuperable: la sesión queda
   * rota para siempre. Por eso se sanea siempre, aunque las rutas de compresión ya
   * intenten mantener el invariante por su cuenta.
   */
  private sanitizeToolPairing(messages: Message[]): void {
    // 1) Eliminar tool results huérfanos.
    let openIds = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role === 'assistant') {
        openIds = new Set((msg.tool_calls ?? []).map((tc) => tc.id));
        continue;
      }
      if (msg.role === 'tool') {
        if (!msg.tool_call_id || !openIds.has(msg.tool_call_id)) {
          messages.splice(i, 1);
          i--;
        }
        continue;
      }
      openIds = new Set(); // user/system cierran el bloque de tool calls
    }

    // 2) Rellenar tool_calls sin respuesta con un placeholder mínimo.
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant' || !msg.tool_calls?.length) continue;

      let j = i + 1;
      const answered = new Set<string>();
      while (j < messages.length && messages[j]?.role === 'tool') {
        const id = messages[j]?.tool_call_id;
        if (id) answered.add(id);
        j++;
      }

      const missing = msg.tool_calls.filter((tc) => !answered.has(tc.id));
      if (missing.length === 0) continue;

      messages.splice(
        j,
        0,
        ...missing.map(
          (tc): Message => ({
            role: 'tool',
            tool_call_id: tc.id,
            content: '<elided reason="context_compression"/>',
          }),
        ),
      );
    }
  }

  /**
   * Truncado duro: elimina lo comprimible de más antiguo a más reciente, por
   * unidades (un `user`, o un assistant con sus tool results), hasta bajar del
   * umbral. La zona protegida —ancla incluida— nunca se toca.
   */
  private hardTruncate(
    messages: Message[],
    tokensBefore: number,
    compressorError?: string,
  ): CompressionResult {
    let { tailStart, anchor } = this.buildProtectedZone(messages);
    let roundsRemoved = 0;
    let removedAny = false;

    const belowThreshold = () => {
      const tokens = this.estimateCalibrated(messages);
      return this.contextWindow > 0 && tokens / this.contextWindow <= this.compressionThreshold;
    };

    while (!belowThreshold()) {
      const start = anchor === 1 ? 2 : 1;
      if (start >= tailStart) break; // No queda nada que eliminar

      // Un assistant arrastra los `tool` que le responden: quedarían huérfanos y
      // el provider rechazaría el historial con un 400 irrecuperable.
      let end = start + 1;
      if (messages[start]?.role === 'assistant') {
        while (end < tailStart && messages[end]?.role === 'tool') end++;
      }
      const count = end - start;
      if (messages[start]?.role === 'user' || messages[start]?.role === 'assistant') {
        roundsRemoved++;
      }
      messages.splice(start, count);
      tailStart -= count;
      if (anchor !== null && anchor > start) anchor -= count;
      removedAny = true;
    }

    // Lo que queda tras el system puede empezar por un assistant (se cortó una
    // ronda por la mitad, o solo queda la cola): muchas plantillas exigen que
    // la conversación empiece por `user`.
    if (removedAny && messages[1] && messages[1].role !== 'user') {
      messages.splice(1, 0, {
        role: 'user',
        content:
          '<context_truncated>Older messages were removed to fit the context window.</context_truncated>',
      });
    }

    this.sanitizeToolPairing(messages);

    const tokensAfter = this.estimateCalibrated(messages);
    this.lastPromptTokens = null;

    const newPct = this.contextWindow > 0 ? tokensAfter / this.contextWindow : 0;
    if (newPct > this.compressionThreshold) {
      return compressorError ? { kind: 'pressure', compressorError } : { kind: 'pressure' };
    }
    // `/compact` por debajo del umbral con el compresor caído: no hacía falta
    // truncar, así que no hay nada que decir salvo que el resumen falló.
    if (!removedAny && compressorError) return { kind: 'failed', error: compressorError };

    return compressorError
      ? { kind: 'truncated', tokensBefore, tokensAfter, roundsRemoved, compressorError }
      : { kind: 'truncated', tokensBefore, tokensAfter, roundsRemoved };
  }

  /**
   * Texto que ve el compresor. Incluye las tool calls (sin ellas cada
   * iteración llegaba como un «assistant:» vacío y el resumen no podía decir
   * qué se leyó ni qué se ejecutó) y recorta cada mensaje: un volcado de 30k
   * caracteres no aporta al resumen y podría desbordar la propia petición.
   */
  private compressorInput(oldMessages: Message[], anchor?: Message): string {
    const names = new Map<string, string>();
    const lines: string[] = [];
    for (const msg of oldMessages) {
      if (msg.role === 'assistant') {
        const parts = [`[assistant]`];
        if (msg.content) parts.push(truncateToolOutput(msg.content, COMPRESSOR_TEXT_CHARS));
        for (const tc of msg.tool_calls ?? []) {
          names.set(tc.id, tc.function.name);
          parts.push(
            `-> ${tc.function.name}(${truncateToolOutput(tc.function.arguments, COMPRESSOR_TEXT_CHARS / 4)})`,
          );
        }
        lines.push(parts.join('\n'));
      } else if (msg.role === 'tool') {
        const name = (msg.tool_call_id && names.get(msg.tool_call_id)) || 'tool';
        lines.push(
          `[${name} result]\n${truncateToolOutput(msg.content ?? '', COMPRESSOR_TOOL_CHARS)}`,
        );
      } else {
        lines.push(
          `[${msg.role}]\n${truncateToolOutput(msg.content ?? '', COMPRESSOR_TEXT_CHARS)}`,
        );
      }
    }

    // La propia petición tiene que caber en la ventana con sitio para el resumen.
    const ratio = this.tokenRatio ?? 1;
    const budgetChars = Math.max(8_000, Math.floor(((this.contextWindow * 0.6) / ratio) * 3.5));
    const conversation = truncateToolOutput(lines.join('\n\n'), budgetChars);

    const context = anchor?.content
      ? `The user's current request stays in the conversation verbatim; use it as context:\n${truncateToolOutput(anchor.content, COMPRESSOR_TEXT_CHARS)}\n\n`
      : '';
    return `${COMPRESSOR_PROMPT}\n\n${context}<conversation>\n${conversation}\n</conversation>`;
  }

  /** Llama al LLM para comprimir el historial antiguo. */
  private async callCompressor(
    oldMessages: Message[],
    anchor?: Message,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.provider || !this.model) throw new CompressorError('no provider for compression');

    const timeout = AbortSignal.timeout(this.compressionTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const model = this.compressorModel ?? this.model;
    // Un `<think>` al principio es razonamiento (backends que no lo separan a
    // `reasoning_content`): no es parte del resumen.
    const think = new ThinkTagSplitter();
    let result = '';

    try {
      for await (const chunk of this.provider.complete({
        messages: [{ role: 'user', content: this.compressorInput(oldMessages, anchor) }],
        stream: true,
        model,
        signal: combined,
      })) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) result += think.feed(content).text;
      }
    } catch (err) {
      if (signal?.aborted) throw new CompressorError('cancelled', true);
      if (timeout.aborted) {
        throw new CompressorError(
          `timed out after ${Math.round(this.compressionTimeoutMs / 1000)} s`,
        );
      }
      throw new CompressorError(err instanceof Error ? err.message : String(err));
    }
    if (signal?.aborted) throw new CompressorError('cancelled', true);
    result += think.flush().text;

    const summary = result.trim();
    // Un resumen vacío no sustituye a nada: sería borrar el historial.
    if (!summary) throw new CompressorError('the compressor returned an empty summary');
    return summary;
  }
}

// ---------------------------------------------------------------------------
// ReactLoop
// ---------------------------------------------------------------------------
export class ReactLoop {
  private readonly dispatcher: ToolDispatcher;
  private readonly contextManager: ContextManager;
  /** Lista de tareas del turno (Hito 11). De sesión cuando `extras.todos` la aporta. */
  private readonly todos: TodoList;
  /** Write-log acumulado (Hito 12). De sesión cuando `extras.changes` lo aporta. */
  private readonly changes: ChangeTracker;
  /** Evidencia del ciclo TDD (Hito 13). De sesión cuando `extras.tdd` la aporta. */
  private readonly tdd: TddLedger;
  /** Iteraciones del loop realmente ejecutadas en el último run (Hito 8: usage). */
  private _iterations = 0;
  /**
   * Tokens acumulados (best-effort) del último run (Hito 8B). Solo se incrementa
   * cuando el backend devuelve `usage`; 0 si no. Fuente del `usage.tokens` de los
   * subagentes y del presupuesto duro-si-hay-métrica `maxTokens`.
   */
  private _tokensUsed = 0;
  /**
   * Contabilidad con estado (Hito 13). `_usageReports` cuenta chunks que
   * trajeron `usage`; `_completedRequests`, streams que terminaron sin
   * cancelarse. Con los dos se distingue «aún no hay dato» de «este backend
   * nunca lo manda», que es justo lo que antes se degradaba en silencio.
   */
  private _usageReports = 0;
  private _completedRequests = 0;
  /** El aviso de presupuesto sin métrica se emite una sola vez por loop. */
  private _warnedUnmeteredBudget = false;

  constructor(
    private readonly provider: IProvider,
    private readonly registry: ToolRegistry,
    private readonly messages: Message[],
    private readonly config: StratumConfig,
    private readonly model: string,
    contextWindow: number,
    /**
     * Router opcional (Hito 6). Cuando se pasa, el loop usa el provider activo
     * del router en cada intento y, si el activo falla antes de emitir tokens,
     * conmuta automáticamente al siguiente provider (`advanceProvider`).
     */
    private readonly router?: {
      getActive(): IProvider;
      readonly model: string;
      readonly hasFallback: boolean;
      readonly providerName: string;
      advanceProvider(): { name: string; model: string } | null;
    },
    /**
     * Extras Hito 8: `profiles` permite al loop padre resolver perfiles al
     * interceptar delegate_task; `toolsetFilter` restringe el toolset cuando este
     * loop ES un subagente (perfil + profundidad = 1).
     */
    private readonly extras?: {
      profiles?: ProfileLoader;
      toolsetFilter?: ToolsetFilter;
      /**
       * `ContextManager` de sesión (lo aporta `StratumAgent`). El loop vive un
       * solo turno, pero la calibración del estimador de tokens y el último
       * `usage` real deben sobrevivir entre turnos: sin esto, la barra de estado
       * y `/compact` vuelven al proxy chars/3.5 sin corregir.
       */
      contextManager?: ContextManager;
      /**
       * Lista de tareas de la sesión (Hito 11). Como el `ContextManager`, vive
       * fuera del loop: la lista tiene que sobrevivir entre turnos para que la
       * detección de staleness cuente turnos de verdad. Sin ella, `todo` sigue
       * existiendo pero arranca vacía en cada turno.
       */
      todos?: TodoList;
      /**
       * Acumulador del cambio de la sesión (Hito 12). Como los todos, vive
       * fuera del loop: el aviso de «reviewer protection» mide el diff de toda
       * la sesión, no el de un turno.
       */
      changes?: ChangeTracker;
      /**
       * Registro de evidencia TDD (Hito 13). Como los todos y el write-log,
       * vive fuera del loop: un ciclo RED → GREEN abarca varios turnos.
       */
      tdd?: TddLedger;
      /**
       * Bloque `# Skills` renderizado por `StratumAgent` (Hito 12). El loop solo
       * lo transporta: se lo pasa a los subagentes que delegue.
       */
      skillsBlock?: string;
      /**
       * Versión de cada fichero vista por este agente (`read_file`), que
       * `write_file` consulta antes de sobrescribir. De sesión: una lectura de
       * un turno vale para escribir en el siguiente.
       */
      fileState?: FileStateTracker;
      /**
       * Stratum Desktop D2 — workspace al que se confinan las tools de fichero.
       * Se pasa en el `ToolContext` y hace de `cwd`.
       */
      workspace?: WorkspaceConfinement;
    },
  ) {
    // Fix #3: pasa maxToolRetries al dispatcher para aplicarlo en sesión
    this.dispatcher = new ToolDispatcher(registry, config.agent.maxToolRetries);
    // Sin lista de sesión (tests, subagentes) el loop usa una propia: `todo`
    // sigue funcionando dentro del turno, solo que no persiste entre turnos.
    this.todos = extras?.todos ?? new TodoList();
    this.changes = extras?.changes ?? new ChangeTracker();
    this.tdd = extras?.tdd ?? new TddLedger();
    this.contextManager =
      extras?.contextManager ??
      new ContextManager(
        contextWindow,
        config.agent.compressionKeepRounds,
        provider,
        model,
        config.agent.compressionThreshold,
        config.agent.compressorModel,
        config.agent.compressionTimeoutMs,
      );
  }

  async *run(opts?: RunOptions): AsyncGenerator<AgentEvent> {
    const signal = opts?.signal ?? new AbortController().signal;
    const fmt = this.config.agent.toolErrorFormat;
    const compressionMode = opts?.compressionMode ?? 'normal';
    this.contextManager.setCompressionMode(compressionMode);

    // Hito 7 — Plan & Execute. El modo puede transitar 'plan' → 'execute' en el
    // mismo turno tras la aprobación del usuario; por eso es estado mutable y el
    // toolset se recalcula por iteración.
    let mode: AgentMode = opts?.mode ?? 'normal';
    let plan: Plan | null = opts?.plan ?? null;
    const persistPlan = (done: boolean): void => {
      if (plan) {
        try {
          opts?.onPlanPersist?.(plan, done);
        } catch {
          /* la persistencia del plan es auxiliar: nunca aborta el loop */
        }
      }
    };

    // Reanudación / ejecución directa: si ya hay un plan aprobado y entramos en
    // modo execute, inyectarlo como checklist de trabajo (§12.6).
    // isResumePlan=true indica que el preámbulo de reanudación ya fue inyectado
    // en core.ts (incluye los estados de cada paso); no re-inyectar.
    if (mode === 'execute' && plan && !opts?.isResumePlan) {
      this.messages.push({ role: 'user', content: buildExecutionInjection(plan) });
      persistPlan(isPlanComplete(plan));
    }

    // Hito 17 — el modo read-only se compone con el filtro del perfil (sesión,
    // agente o subagente): el modelo no ve lo que no podría ejecutar.
    const readOnly = opts?.readOnly === true;
    const toolsetFilter = composeToolsetFilters(
      this.extras?.toolsetFilter,
      readOnly ? READ_ONLY_TOOLSET : undefined,
    );
    // `requirePlan` escala a modo plan una sola vez por turno.
    let planEscalated = false;

    // Hito 2.5 (F7): la tanda de preguntas es ÚNICA por run. Una segunda llamada
    // a `question` se rechaza con tool_error recuperable para que un modelo
    // pequeño no convierta el turno en un interrogatorio.
    let questionsAsked = false;

    // Hito 11 — lista de tareas. `beginTurn` avanza el contador de staleness y
    // limpia una lista ya terminada; el evento repinta la UI al reanudar una
    // sesión con tareas abiertas, antes de que el modelo diga nada.
    this.todos.beginTurn();
    if (this.todos.snapshot.length > 0) {
      yield {
        type: 'todo_updated',
        items: this.todos.snapshot,
        stale: this.todos.staleTurns,
      };
    }

    // Hito 8: los subagentes aplican el maxIterations de su presupuesto en vez
    // del global de config (límite duro, §12.16).
    const maxIterations = opts?.maxIterations ?? this.config.agent.maxIterations;

    const loopLog = log.child('loop', { model: this.model });
    loopLog.debug('run start', {
      mode,
      messages: this.messages.length,
      maxIterations,
      compressionMode,
    });

    for (let iter = 0; iter < maxIterations; iter++) {
      if (signal.aborted) {
        loopLog.info('cancelled', { iter });
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      // Presupuesto de tokens (Hito 8B, best-effort): solo aplica si el backend
      // devolvió usage en iteraciones previas. Se comprueba entre iteraciones —
      // nunca a mitad de stream— para cerrar limpio con el resultado parcial.
      if (opts?.maxTokens) {
        const accounting = this.tokenAccounting;
        if (accounting.status === 'reported' && this._tokensUsed >= opts.maxTokens) {
          loopLog.info('budget tokens exceeded', {
            iter,
            tokensUsed: this._tokensUsed,
            maxTokens: opts.maxTokens,
          });
          yield { type: 'done', stopReason: 'budget_tokens' };
          return;
        }
      }
      // Contar la iteración solo cuando realmente procede (no si se canceló antes).
      this._iterations = iter + 1;

      const ctxUsage = this.contextManager.usage(this.messages);
      loopLog.debug('iteration', {
        iter,
        messages: this.messages.length,
        ctxPct: ctxUsage.pct,
        ctxEstimated: ctxUsage.estimated,
      });

      // Comprimir contexto antes de cada iteración (§12.4)
      const comprResult = await this.contextManager.maybeCompress(this.messages, signal);
      if (comprResult.kind === 'compressed' || comprResult.kind === 'truncated') {
        loopLog.info(`context ${comprResult.kind}`, {
          tokensBefore: comprResult.tokensBefore,
          tokensAfter: comprResult.tokensAfter,
        });
      } else if (comprResult.kind === 'pressure') {
        loopLog.warn('context window pressure', { ctxPct: ctxUsage.pct });
      }
      // Un resumen que no llega cae al truncado duro: sin este aviso el usuario
      // solo vería que el agente ha olvidado cosas.
      if (
        (comprResult.kind === 'truncated' || comprResult.kind === 'pressure') &&
        comprResult.compressorError
      ) {
        yield {
          type: 'warning',
          message: `context_summary_failed: ${comprResult.compressorError}; older messages were truncated instead`,
        };
      }
      // F6: en modo conservative (p. ej. /init) la compresión destruye el
      // contexto investigado — avisar de forma visible si llegó a activarse.
      if (
        compressionMode === 'conservative' &&
        (comprResult.kind === 'compressed' || comprResult.kind === 'truncated')
      ) {
        yield {
          type: 'warning',
          message:
            'context_compressed_during_init: el historial superó el umbral incluso en modo conservador; ' +
            'considera configurar un contextWindow mayor en .stratumrc.json',
        };
      }
      if (comprResult.kind === 'compressed') {
        yield {
          type: 'context_compressed',
          tokensBefore: comprResult.tokensBefore,
          tokensAfter: comprResult.tokensAfter,
          roundsCompressed: comprResult.roundsCompressed,
        };
      } else if (comprResult.kind === 'truncated') {
        yield {
          type: 'context_compressed',
          tokensBefore: comprResult.tokensBefore,
          tokensAfter: comprResult.tokensAfter,
          roundsCompressed: comprResult.roundsRemoved,
        };
      } else if (comprResult.kind === 'pressure') {
        yield { type: 'warning', message: 'context_window_pressure' };
      }

      // Toolset según el modo activo (Hito 7): en 'plan' se restringe a la
      // allowlist read-only + present_plan; en 'execute' aparece update_plan.
      // Hito 8: el filtro de subagente restringe además por perfil + profundidad=1.
      const tools: ToolSchema[] = this.registry.toToolSchemas(mode, toolsetFilter);

      // Hito 11 — re-inyectar las tareas abiertas en el system prompt antes de
      // cada iteración. Una descripción estática de tool no basta para que un
      // modelo pequeño mantenga la lista al día; recordárselo cada vez sí. Va
      // dentro del mensaje system (entre marcadores, idempotente) y no como
      // mensaje nuevo: así no acumula basura por iteración y la compresión de
      // contexto, que protege el system prompt, no se lo lleva por delante.
      applyTodoToSystemMessage(this.messages, this.todos.injection());
      // Hito 13 — mismo mecanismo para el ciclo TDD abierto: un modelo pequeño
      // declara la tarea terminada en cuanto los tests pasan una vez, así que
      // el recordatorio de lo que le falta tiene que estar delante cada turno.
      applyTddToSystemMessage(this.messages, this.tdd.injection());

      const request: CompletionRequest = {
        messages: this.messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        model: this.model,
        signal,
        onStreamWarning: (message) => streamWarnings.push(message),
      };
      // Incidencias del stream (chunks descartados): se emiten como `warning`
      // en cuanto el loop recupera el control, sin cortar la respuesta.
      const streamWarnings: string[] = [];
      const drainStreamWarnings = function* (): Generator<AgentEvent> {
        while (streamWarnings.length > 0) {
          yield { type: 'warning', message: streamWarnings.shift()! };
        }
      };

      const buffer = new StreamBuffer();
      let assistantText = '';
      // Solo para la traza: el razonamiento nunca entra en el historial.
      let reasoningText = '';
      const readyCalls: ToolCallReady[] = [];
      // Fix #2: rastrear parse errors del buffer para inject & recover (spec 12.3)
      type ParseError = {
        type: 'tool_error';
        id: string;
        name: string;
        error: string;
        recoverable: boolean;
      };
      const parseErrors: ParseError[] = [];
      const toolArgBuffers = new Map<string, string>(); // id → args raw acumulados
      let fatalError: string | null = null;

      // Bucle de fallback automático por orden (§Hito 6): si el provider activo
      // falla ANTES de emitir tokens, se conmuta al siguiente del router y se
      // reintenta este mismo turno. No se hace fallback a mitad de stream.
      const router = this.router;
      streamLoop: while (true) {
        const activeProvider = router?.getActive() ?? this.provider;
        request.model = router?.model ?? this.model;

        // ¿Se emitió algún evento visible? Si no, es seguro reintentar con otro provider.
        let emittedVisible = false;
        let streamErr: unknown = null;
        const modelSpan = opts?.trace?.modelStart({
          iteration: iter,
          provider: router?.providerName,
          model: request.model,
          messages: this.messages,
          tools: tools.length,
        });

        // Acumula cada evento del buffer en el estado del turno y devuelve el
        // que hay que emitir (el mismo, o su versión redactada).
        const absorb = (ev: AgentEvent): AgentEvent => {
          emittedVisible = true;
          if (ev.type === 'text_delta') {
            assistantText += ev.delta;
          } else if (ev.type === 'thinking') {
            reasoningText += ev.text;
          } else if (ev.type === 'tool_call_start') {
            toolArgBuffers.set(ev.id, ev.input_so_far);
          } else if (ev.type === 'tool_call_ready') {
            toolArgBuffers.delete(ev.id);
            readyCalls.push(ev);
          } else if (ev.type === 'tool_error') {
            // Hito 16: el error de parseo cita los argumentos crudos del
            // modelo; se redacta aquí para que el evento (UI, subagent_event)
            // y el mensaje del historial lleven el mismo texto seguro.
            const safe = { ...ev, error: redactText(ev.error, this.config) };
            parseErrors.push(safe as ParseError);
            return safe;
          }
          return ev;
        };

        try {
          for await (const chunk of streamWithRetry(activeProvider, request)) {
            if (signal.aborted) break;
            modelSpan?.firstChunk();
            if (chunk.usage) modelSpan?.usage(chunk.usage);

            // Registrar usage real si viene en el chunk (§12.4)
            if (chunk.usage?.prompt_tokens) {
              // `this.messages` es exactamente el prompt de este request (la
              // respuesta aún no se ha añadido): sirve para calibrar el proxy.
              this.contextManager.recordUsage(chunk.usage.prompt_tokens, this.messages);
            }
            // Tokens acumulados best-effort (Hito 8B): total del request si viene,
            // si no la suma prompt+completion. Alimenta el presupuesto `maxTokens`.
            if (chunk.usage) {
              const u = chunk.usage;
              this._usageReports++;
              this._tokensUsed +=
                u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
            }

            for (const ev of buffer.feed(chunk)) yield absorb(ev);
            yield* drainStreamWarnings();
          }
          // Fin normal del cuerpo: cierra las tool calls que ningún
          // `finish_reason` cerró (backend que no lo manda o corte limpio).
          if (!signal.aborted) {
            for (const ev of buffer.finish()) yield absorb(ev);
          }
        } catch (err) {
          streamErr = err;
        }
        modelSpan?.end({
          text: assistantText,
          reasoning: reasoningText,
          toolCalls: [
            ...readyCalls.map((rc) => ({
              id: rc.id,
              name: rc.name,
              arguments: JSON.stringify(rc.input),
            })),
            ...parseErrors.map((pe) => ({
              id: pe.id,
              name: pe.name,
              arguments: toolArgBuffers.get(pe.id) ?? '',
            })),
          ],
          cancelled: signal.aborted,
          error:
            streamErr === null || signal.aborted
              ? undefined
              : streamErr instanceof Error
                ? streamErr.message
                : String(streamErr),
        });
        yield* drainStreamWarnings();

        // Request completa (ni error ni cancelación): si no trajo `usage` pese a
        // haberlo pedido con `stream_options.include_usage`, este backend no lo
        // manda. Es lo que separa `unsupported` de «todavía no hay dato».
        if (streamErr === null && !signal.aborted) this._completedRequests++;

        // Hito 13: un presupuesto que no se puede medir se ignoraba en silencio.
        // El aviso va AQUÍ y no al inicio de la iteración siguiente: un turno que
        // se resuelve en una sola iteración —el caso más común— nunca llegaría a
        // una segunda, y el usuario se quedaría sin enterarse. Una vez por loop.
        if (
          opts?.maxTokens &&
          !this._warnedUnmeteredBudget &&
          this.tokenAccounting.status === 'unsupported'
        ) {
          this._warnedUnmeteredBudget = true;
          loopLog.warn('token budget unmetered', { iter, maxTokens: opts.maxTokens });
          yield {
            type: 'warning',
            message:
              `token_budget_unmetered: el presupuesto de ${opts.maxTokens} tokens no se puede ` +
              'aplicar porque este backend no devuelve `usage`. El límite efectivo pasa a ser ' +
              'maxIterations + timeout.',
          };
        }

        if (streamErr !== null) {
          const isAbort = streamErr instanceof Error && streamErr.name === 'AbortError';
          // Fallback solo si: no es cancelación, no se emitió nada todavía y el
          // router tiene alternativas que aún no han fallado en este run.
          if (!isAbort && !emittedVisible && router?.hasFallback) {
            const from = router.providerName;
            const next = router.advanceProvider();
            if (next) {
              // Descartar lo acumulado del intento fallido antes de reintentar.
              buffer.reset();
              assistantText = '';
              reasoningText = '';
              readyCalls.length = 0;
              parseErrors.length = 0;
              toolArgBuffers.clear();
              loopLog.warn('provider fallback', { from, to: next.name, model: next.model });
              yield {
                type: 'warning',
                message:
                  `provider_fallback: "${from}" no respondió; ` +
                  `conmutando a "${next.name}" (modelo ${next.model}).`,
              };
              continue streamLoop;
            }
          }
          fatalError = streamErr instanceof Error ? streamErr.message : String(streamErr);
        }
        break;
      }

      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }

      if (fatalError !== null) {
        loopLog.error('fatal stream error', { iter, message: fatalError });
        yield { type: 'error', message: fatalError, fatal: true };
        yield { type: 'done', stopReason: 'error' };
        return;
      }

      // Construir mensaje del asistente incluyendo tanto calls válidas como las que fallaron parse
      const assistantMsg: Message = {
        role: 'assistant',
        content: assistantText || null,
      };

      const allToolCalls = [
        ...readyCalls.map((rc) => ({
          id: rc.id,
          type: 'function' as const,
          function: { name: rc.name, arguments: JSON.stringify(rc.input) },
        })),
        ...parseErrors.map((pe) => ({
          id: pe.id,
          type: 'function' as const,
          function: { name: pe.name, arguments: toolArgBuffers.get(pe.id) ?? '' },
        })),
      ];

      if (allToolCalls.length > 0) {
        assistantMsg.tool_calls = allToolCalls;
      }
      // Solo guardar si tiene contenido real — un mensaje {content:null, sin tool_calls}
      // es inválido en la spec OpenAI y causa error 400 en la siguiente llamada.
      if (assistantMsg.content !== null || assistantMsg.tool_calls) {
        this.messages.push(assistantMsg);
      }

      // Parar solo cuando no hay ningún tool call (ni válido ni con parse error)
      if (readyCalls.length === 0 && parseErrors.length === 0) {
        loopLog.debug('done', { iter, stopReason: 'stop', textChars: assistantText.length });
        yield { type: 'done', stopReason: 'stop' };
        return;
      }

      if (readyCalls.length > 0 || parseErrors.length > 0) {
        loopLog.debug('dispatching tool calls', {
          iter,
          ready: readyCalls.length,
          parseErrors: parseErrors.length,
          tools: readyCalls.map((c) => c.name),
        });
      }

      // Inyectar parse errors al historial para que el LLM pueda recuperarse
      for (const pe of parseErrors) {
        this.messages.push(
          this.toolMessage(
            pe.id,
            pe.name,
            formatToolError(
              pe.name,
              pe.error,
              fmt,
              'Ensure the tool call arguments are valid JSON.',
            ),
          ),
        );
      }

      // -----------------------------------------------------------------------
      // Hito 7 — Plan & Execute: separar las tools de control de plan y aplicar
      // el allowlist read-only del modo plan ANTES de despachar nada normal.
      // -----------------------------------------------------------------------
      const regularCalls: ToolCallReady[] = [];
      const updatePlanCalls: ToolCallReady[] = [];
      const delegateCalls: ToolCallReady[] = [];
      let presentPlanCall: ToolCallReady | null = null;
      let questionCall: ToolCallReady | null = null;

      for (const call of readyCalls) {
        // Hito 15 — el filtro de toolset también se impone al ejecutar. Ocultar
        // una tool del schema no impide que el modelo la invente, y sin esto un
        // perfil restringido podría llamar a `exec` o delegar en `general`.
        const filter = toolsetFilter;
        if (filter && !isToolVisibleForProfile(call.name, filter)) {
          const err =
            readOnly && !isToolVisibleForProfile(call.name, READ_ONLY_TOOLSET)
              ? `tool '${call.name}' is not available in a read-only session`
              : `tool '${call.name}' is not available to this agent profile`;
          const o = this.toolErrorOutcome(
            call.id,
            call.name,
            err,
            true,
            fmt,
            'Use only the tools offered to you in this conversation.',
          );
          yield o.event;
          this.messages.push(o.message);
          continue;
        }

        // question (Hito 2.5, F7): tanda única de preguntas al usuario. Tool de
        // control — se intercepta aquí y nunca llega al dispatcher.
        if (call.name === QUESTION_TOOL) {
          if (!questionsAsked && !questionCall) {
            questionCall = call;
          } else {
            const err =
              'Ya preguntaste al usuario en este turno: `question` es una tanda única. ' +
              'Continúa con los supuestos más razonables.';
            const o = this.toolErrorOutcome(call.id, call.name, err, true, fmt);
            yield o.event;
            this.messages.push(o.message);
          }
          continue;
        }

        // todo (Hito 11): tool de control. Se aplica aquí mismo, en orden, para
        // que el snapshot que se inyecta como tool result refleje ya el cambio
        // y una tanda de varias llamadas (update + update) se acumule bien.
        if (call.name === TODO_TOOL) {
          // Fuera del modo normal la lista no existe: en plan/execute el
          // checklist del plan es la única fuente de verdad del progreso.
          if (mode !== 'normal') {
            const err =
              mode === 'plan'
                ? 'todo no está disponible en modo plan: describe los pasos en present_plan.'
                : 'todo no está disponible durante la ejecución de un plan: usa update_plan.';
            const o = this.toolErrorOutcome(call.id, call.name, err, true, fmt);
            yield o.event;
            this.messages.push(o.message);
            continue;
          }
          try {
            const applied = this.todos.apply(call.input as unknown as TodoInput);
            const snapshot = formatTodoSnapshot(applied.items, applied.notes);
            yield {
              type: 'todo_updated',
              items: this.todos.snapshot,
              stale: this.todos.staleTurns,
            };
            const o = this.toolResultOutcome(call.id, call.name, snapshot, 0);
            yield o.event;
            this.messages.push(o.message);
          } catch (err) {
            const message = err instanceof TodoError ? err.message : String(err);
            const o = this.toolErrorOutcome(call.id, call.name, message, true, fmt);
            yield o.event;
            this.messages.push(o.message);
          }
          continue;
        }

        // test_evidence (Hito 13): tool de control. Se aplica en orden, aquí
        // mismo, para que dos fases registradas en la misma tanda se validen
        // una contra otra (un `green` tras el `red` del mismo turno es válido).
        if (call.name === TEST_EVIDENCE_TOOL) {
          try {
            const input = call.input as unknown as TddRecordInput & { action?: string };
            const applied =
              input.action === 'list'
                ? { entries: this.tdd.snapshot, notes: [] as string[] }
                : this.tdd.record(input);
            const snapshot = formatTddSnapshot(applied.entries, applied.notes);
            const o = this.toolResultOutcome(call.id, call.name, snapshot, 0);
            yield o.event;
            this.messages.push(o.message);
          } catch (err) {
            const message = err instanceof TddError ? err.message : String(err);
            const o = this.toolErrorOutcome(call.id, call.name, message, true, fmt);
            yield o.event;
            this.messages.push(o.message);
          }
          continue;
        }

        // delegate_task (Hito 8): interceptada como las tools de control de plan.
        // En modo plan (read-only) cae al rechazo de tool mutante de más abajo.
        if (call.name === DELEGATE_TASK_TOOL && mode !== 'plan') {
          delegateCalls.push(call);
          continue;
        }

        // present_plan: cierre de Fase 1. Solo válido (una vez) en modo plan.
        if (call.name === PRESENT_PLAN_TOOL) {
          if (mode === 'plan' && !presentPlanCall) {
            presentPlanCall = call;
          } else {
            const err =
              mode === 'plan'
                ? 'present_plan ya fue invocada en este turno.'
                : 'present_plan solo está disponible en modo plan.';
            const o = this.toolErrorOutcome(call.id, call.name, err, true, fmt);
            yield o.event;
            this.messages.push(o.message);
          }
          continue;
        }

        // update_plan: actualización de estado de paso. Solo válido en execute.
        if (call.name === UPDATE_PLAN_TOOL) {
          if (mode === 'execute') {
            updatePlanCalls.push(call);
          } else {
            const err = 'update_plan solo está disponible durante la ejecución de un plan.';
            const o = this.toolErrorOutcome(call.id, call.name, err, true, fmt);
            yield o.event;
            this.messages.push(o.message);
          }
          continue;
        }

        // Modo plan: cualquier tool mutante fuera del allowlist read-only se
        // rechaza con un tool_error recuperable inyectado (UI §5.4, Fase 1).
        // Hito 17: `exec` pasa si el comando solo observa.
        const planReadOnlyCall =
          PLAN_READ_ONLY_CALL_TOOLS.has(call.name) && !callEffects(call.name, call.input).mutating;
        if (mode === 'plan' && !PLAN_ALLOWLIST.has(call.name) && !planReadOnlyCall) {
          const effects = PLAN_READ_ONLY_CALL_TOOLS.has(call.name)
            ? callEffects(call.name, call.input)
            : null;
          const err = effects
            ? `Plan mode: only read-only commands can run until the plan is approved (${effects.reason ?? 'this command changes state'})`
            : `Plan mode: tool '${call.name}' deshabilitada hasta aprobar el plan`;
          const o = this.toolErrorOutcome(
            call.id,
            call.name,
            err,
            true,
            fmt,
            'Use only read-only tools, then call present_plan with your plan.',
          );
          yield o.event;
          this.messages.push(o.message);
          continue;
        }

        // Hito 17 — `requirePlan` de un entorno (§12.18): fuera de un plan
        // aprobado nada cambia allí. Leer sí se puede (así se investiga para el
        // plan). Con un gate de aprobación disponible, el turno escala a modo
        // plan; sin él (subagente, `run` sin TTY, Desktop) solo se rechaza.
        if (mode !== 'execute' && opts?.planApproved !== true) {
          const violation = requirePlanViolation(
            call.name,
            call.input,
            this.config,
            this.extras?.workspace,
          );
          if (violation) {
            const { env, target } = violation;
            const canEscalate = mode === 'normal' && opts?.onApprovePlan !== undefined;
            if (canEscalate && !planEscalated) {
              planEscalated = true;
              mode = 'plan';
              yield { type: 'warning', message: `plan_required:${env.name}` };
            }
            const err = canEscalate
              ? `Environment "${env.name}" requires an approved plan before changing anything on ` +
                `${target}. You are now in PLAN MODE: investigate with read-only tools (exec is ` +
                'allowed for commands that only read state), then call present_plan with the ' +
                'concrete steps. The change runs after the user approves the plan.'
              : `Environment "${env.name}" requires an approved plan before changing anything on ` +
                `${target}, and this session cannot present one for approval. Report what you ` +
                'would change and ask the user to run the task as a plan (/plan in the chat, or ' +
                'stratum run --plan).';
            const o = this.toolErrorOutcome(call.id, call.name, err, true, fmt);
            yield o.event;
            this.messages.push(o.message);
            continue;
          }
        }

        regularCalls.push(call);
      }

      // ----- Fase 3: aplicar update_plan (estados vivos) -----
      for (const call of updatePlanCalls) {
        const stepId = String((call.input as { stepId?: unknown }).stepId ?? '');
        const status = String((call.input as { status?: unknown }).status ?? '') as PlanStepStatus;
        const step = plan?.steps.find((s) => s.id === stepId);
        if (!step) {
          const err = `No existe el paso "${stepId}" en el plan.`;
          const o = this.toolErrorOutcome(call.id, call.name, err, true, fmt);
          yield o.event;
          this.messages.push(o.message);
          continue;
        }
        step.status = status;
        yield { type: 'plan_step_update', stepId, status };
        persistPlan(plan ? isPlanComplete(plan) : false);
        this.messages.push(this.toolMessage(call.id, call.name, `Paso ${stepId} → ${status}.`));
      }

      // Despachar tool calls con JSON válido (excluyendo las de control de plan)
      if (regularCalls.length > 0) {
        const ctx: ToolContext = {
          signal,
          cwd: this.extras?.workspace?.root ?? process.cwd(),
          config: this.config,
          sessionId: opts?.sessionId,
          workspace: this.extras?.workspace,
          fileState: this.extras?.fileState,
          allowDestructive: opts?.allowDestructive,
          destructivePolicy:
            opts?.destructivePolicy ?? (opts?.allowDestructive === true ? 'allow' : 'ask'),
          confirmDestructive: opts?.onConfirmDestructive,
          readOnly,
        };

        const results: DispatchResult[] = await this.dispatcher.dispatch(regularCalls, ctx);

        for (const res of results) {
          if (res.result.ok) {
            const o = this.toolResultOutcome(
              res.callId,
              res.toolName,
              res.result.output,
              res.durationMs,
            );
            yield o.event;
            this.messages.push(o.message);
            // Hito 12 — write-log de sesión: alimenta la protección del revisor.
            const originCall = regularCalls.find((c) => c.id === res.callId);
            if (originCall) {
              const change = changeFromToolCall(res.toolName, originCall.input, res.result.output);
              if (change) this.changes.record(change.path, change.added, change.deleted);
            }
            // Señal semántica de recuperación de memoria (§5/UI §11): el agente
            // ejecutó recall_decisions con éxito. Emitir el evento con las
            // decisiones estructuradas que el orquestador acaba de devolver.
            if (res.toolName === 'recall_decisions') {
              const recalled = getDecisionMemory(this.config).takeLastRecall();
              if (recalled.length > 0) {
                yield {
                  type: 'memory_retrieved',
                  decisions: recalled.map((r) => ({
                    id: r.record.id,
                    title: r.record.title,
                    content: r.record.content,
                    type: r.record.type,
                    tags: r.record.tags,
                    importance: r.record.importance,
                    timestamp: r.record.timestamp,
                  })),
                };
              }
            }
          } else {
            const o = this.toolErrorOutcome(
              res.callId,
              res.toolName,
              res.result.error,
              res.result.recoverable,
              fmt,
              undefined,
              res.result.executed,
            );
            yield o.event;
            this.messages.push(o.message);
          }
        }

        // Protección del revisor (Hito 12): un aviso cuando el cambio acumulado
        // de la sesión cruza el umbral de lo que un humano revisa bien. No
        // bloquea nada; solo informa, y se re-arma cada vez que se duplica.
        const largeChange = this.changes.takeLargeChangeWarning();
        if (largeChange) {
          loopLog.info('large change warning', { message: largeChange });
          yield { type: 'warning', message: largeChange };
        }
      }

      // -----------------------------------------------------------------------
      // Hito 8 — Delegación (§12.16). En 8C, los delegate_task de un mismo turno
      // se ejecutan en PARALELO acotados por un semáforo (agents.maxConcurrency);
      // con maxConcurrency=1 el comportamiento es secuencial (8A/8B). Los eventos
      // del hijo se re-emiten envueltos (subagent_event) y los resultados,
      // truncados, se inyectan como tool results (inject & recover). Ver
      // runDelegations() más abajo.
      // -----------------------------------------------------------------------
      if (delegateCalls.length > 0) {
        // Hito 17: un hijo delegado durante la Fase 3 trabaja bajo el plan aprobado.
        const delegationOpts: RunOptions | undefined =
          mode === 'execute' ? { ...opts, planApproved: true } : opts;
        yield* this.runDelegations(delegateCalls, delegationOpts, signal, fmt);
      }

      // §12.12 — cancelado mientras corrían las tools o los subagentes: no se
      // abre ningún gate más (preguntar o pedir aprobación después de un Ctrl+C
      // sería justo lo contrario de lo que pidió el usuario), pero las tool
      // calls de control pendientes reciben su resultado, para que el
      // `assistant` con `tool_calls` no quede sin respuesta en el historial.
      if (signal.aborted) {
        for (const call of [questionCall, presentPlanCall]) {
          if (!call) continue;
          const o = this.toolErrorOutcome(call.id, call.name, CANCELLED_BY_USER, true, fmt);
          yield o.event;
          this.messages.push(o.message);
        }
        loopLog.info('cancelled', { iter });
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }

      // -----------------------------------------------------------------------
      // Hito 2.5 (F7) — Gate de preguntas. Como el de plan, se resuelve al final
      // de la iteración (tras las tools del mismo turno) y siempre inyecta un
      // tool result: sin callback o sin respuestas, se instruye al agente a
      // continuar con supuestos razonables en vez de bloquear el loop.
      // -----------------------------------------------------------------------
      if (questionCall) {
        questionsAsked = true;
        const items = parseQuestionInput(questionCall.input);
        if (items.length === 0) {
          const err = 'question requiere al menos una pregunta no vacía.';
          const o = this.toolErrorOutcome(questionCall.id, questionCall.name, err, true, fmt);
          yield o.event;
          this.messages.push(o.message);
        } else {
          yield { type: 'questions_asked', questions: items };
          let answers: QuestionAnswer[] | null = null;
          try {
            answers = opts?.onAskQuestions
              ? await untilAborted(opts.onAskQuestions(items), signal, null)
              : null;
          } catch {
            answers = null;
          }
          // La resolución estricta (token opaco / dominio cerrado) la aplica
          // `formatQuestionAnswers`; aquí se recalcula solo para dejar los
          // descartes en el log: sin esto, una respuesta fuera de dominio
          // desaparecería sin rastro para quien depura el gate.
          const { rejections } = resolveQuestionAnswers(items, answers);
          loopLog.info('questions asked', {
            count: items.length,
            answered: answers !== null,
            ...(rejections.length > 0 ? { rejected: rejections.map((r) => r.reason) } : {}),
          });
          yield { type: 'questions_answered', answers };
          if (signal.aborted) {
            this.messages.push(
              this.toolMessage(questionCall.id, questionCall.name, CANCELLED_BY_USER),
            );
            yield { type: 'done', stopReason: 'cancelled' };
            return;
          }
          this.messages.push(
            this.toolMessage(
              questionCall.id,
              questionCall.name,
              formatQuestionAnswers(items, answers),
            ),
          );
        }
      }

      // -----------------------------------------------------------------------
      // Hito 7 — Fase 2: gate de aprobación. Se procesa AL FINAL del turno, tras
      // cualquier tool read-only del mismo turno, para cerrar la planificación.
      // -----------------------------------------------------------------------
      if (presentPlanCall) {
        const proposed = makePlanFromProposal(
          presentPlanCall.input as {
            summary: string;
            steps: Array<{ title: string; detail?: string }>;
          },
        );
        plan = proposed;
        yield { type: 'plan_proposed', plan: proposed };
        // No persistir antes del gate: si el usuario rechaza, el plan nunca
        // llega a ejecutarse y no debe quedar como in_progress en disco.

        // Resolver el gate. Sin callback (CI/piped sin TTY) → rechazo.
        let decision: PlanDecision;
        try {
          decision = opts?.onApprovePlan
            ? await untilAborted(opts.onApprovePlan(proposed), signal, {
                decision: 'reject',
              } as PlanDecision)
            : { decision: 'reject' };
        } catch {
          decision = { decision: 'reject' };
        }
        if (signal.aborted) {
          this.messages.push(
            this.toolMessage(presentPlanCall.id, presentPlanCall.name, CANCELLED_BY_USER),
          );
          yield { type: 'done', stopReason: 'cancelled' };
          return;
        }

        if (decision.decision === 'approve') {
          plan = decision.plan;
          mode = 'execute';
          persistPlan(isPlanComplete(plan));
          loopLog.info('plan approved', { steps: plan.steps.length });
          this.messages.push(
            this.toolMessage(
              presentPlanCall.id,
              presentPlanCall.name,
              buildExecutionInjection(plan),
            ),
          );
          // Continúa el loop: la próxima iteración ya corre en modo execute.
          continue;
        }

        // Rechazo: el turno termina sin ejecutar (UI §5.4 Fase 2).
        loopLog.info('plan rejected');
        this.messages.push(
          this.toolMessage(
            presentPlanCall.id,
            presentPlanCall.name,
            'El usuario rechazó el plan. Detente y espera nuevas instrucciones.',
          ),
        );
        yield { type: 'done', stopReason: 'stop' };
        return;
      }
    }

    loopLog.warn('max iterations reached', { maxIterations });
    yield { type: 'done', stopReason: 'max_iterations' };
  }

  /**
   * Orquesta los `delegate_task` de un turno (Hito 8C). Desde el Hito 15 la
   * ejecución vive en `executeDelegations` (`agent/delegation.ts`), compartida
   * con la invocación directa del usuario; aquí queda lo propio del loop:
   * resolver los perfiles que pidió el modelo (los inválidos → `tool_error`) e
   * inyectar los tool results en el ORDEN original de las tool calls (inject &
   * recover, §12.3).
   */
  private async *runDelegations(
    delegateCalls: ToolCallReady[],
    opts: RunOptions | undefined,
    signal: AbortSignal,
    fmt: 'xml' | 'json',
  ): AsyncGenerator<AgentEvent> {
    const jobs: DelegationJob[] = [];
    for (const call of delegateCalls) {
      const input = call.input as { task?: unknown; profile?: unknown; context?: unknown };
      const profileName =
        typeof input.profile === 'string' && input.profile
          ? input.profile
          : this.config.agents.defaultProfile;
      const resolved = resolveDelegationProfile(this.extras?.profiles, profileName);

      if (!resolved.ok) {
        const o = this.toolErrorOutcome(
          call.id,
          call.name,
          resolved.error,
          true,
          fmt,
          resolved.hint,
        );
        yield o.event;
        this.messages.push(o.message);
        continue;
      }

      const context = Array.isArray(input.context)
        ? input.context.filter((p): p is string => typeof p === 'string')
        : undefined;
      jobs.push({
        callId: call.id,
        profile: resolved.profile,
        taskText: String(input.task ?? ''),
        context,
        subId: generateSubagentId(),
      });
    }

    if (jobs.length === 0) return;

    const results = yield* executeDelegations(jobs, {
      registry: this.registry,
      config: this.config,
      signal,
      opts,
      skillsBlock: this.extras?.skillsBlock,
    });

    for (const job of jobs) {
      const result = results.get(job.subId);
      if (!result) continue; // no debería ocurrir; defensivo.
      const serialized = truncateToolOutput(serializeSubagentResult(result, job.profile.name));
      const o = this.toolResultOutcome(
        job.callId,
        DELEGATE_TASK_TOOL,
        serialized,
        result.usage.durationMs,
      );
      yield o.event;
      this.messages.push(o.message);
    }
  }

  // -------------------------------------------------------------------------
  // Hito 16 — frontera única hacia el historial. Todo lo que el loop entrega
  // como resultado de una tool (despachada, de control, rechazo o delegación)
  // pasa por aquí: se redacta UNA vez y el mismo texto va al evento (UI,
  // subagent_event del padre) y al mensaje (historial, SessionStore, provider).
  // Idempotente con lo que el dispatcher ya redactó.
  // -------------------------------------------------------------------------

  private toolMessage(id: string, name: string, content: string): Message {
    return { role: 'tool', tool_call_id: id, name, content: redactText(content, this.config) };
  }

  private toolResultOutcome(
    id: string,
    name: string,
    result: string,
    durationMs: number,
  ): { event: AgentEvent; message: Message } {
    const safe = redactText(result, this.config);
    return {
      event: { type: 'tool_result', id, name, result: safe, durationMs },
      message: { role: 'tool', tool_call_id: id, name, content: safe },
    };
  }

  private toolErrorOutcome(
    id: string,
    name: string,
    error: string,
    recoverable: boolean,
    fmt: 'xml' | 'json',
    suggestion?: string,
    executed?: boolean,
  ): { event: AgentEvent; message: Message } {
    const safe = redactText(error, this.config);
    return {
      event: {
        type: 'tool_error',
        id,
        name,
        error: safe,
        recoverable,
        ...(executed ? { executed: true } : {}),
      },
      message: {
        role: 'tool',
        tool_call_id: id,
        name,
        content: formatToolError(name, safe, fmt, suggestion),
      },
    };
  }

  getContextUsage(): { used: number; max: number; pct: number; estimated: boolean } {
    return this.contextManager.usage(this.messages);
  }

  /** Iteraciones del loop ejecutadas en el último run (para usage de subagentes). */
  get iterationsRun(): number {
    return this._iterations;
  }

  /**
   * Tokens acumulados del último run (Hito 8B, best-effort). 0 si el backend
   * nunca devolvió `usage`. Los subagentes lo exponen como `usage.tokens`.
   */
  get tokensUsed(): number {
    return this._tokensUsed;
  }

  /**
   * Contabilidad de tokens con estado explícito (Hito 13). Prefiérela a
   * `tokensUsed`: un 0 puede significar «cero tokens» o «el backend no lo
   * dice», y esas dos cosas se tratan distinto.
   */
  get tokenAccounting(): TokenAccounting {
    if (this._usageReports > 0) return { status: 'reported', tokens: this._tokensUsed };
    if (this._completedRequests > 0) return { status: 'unsupported' };
    return { status: 'unavailable' };
  }
}
