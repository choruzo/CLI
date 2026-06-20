import type { StratumConfig } from '../config/schema.js';
import type { IProvider, CompletionRequest, OpenAIStreamChunk } from '../providers/base.js';
import type { ToolSchema } from '../providers/base.js';
import { StreamBuffer } from '../providers/openai-compatible.js';
import type {
  AgentEvent,
  AgentMode,
  Message,
  Plan,
  PlanDecision,
  PlanStepStatus,
  ToolCallReady,
  ToolContext,
  RunOptions,
} from './types.js';
import type { ToolRegistry, DispatchResult, ToolsetFilter } from '../tools/registry.js';
import { ToolDispatcher } from '../tools/registry.js';
import {
  PLAN_ALLOWLIST,
  PRESENT_PLAN_TOOL,
  UPDATE_PLAN_TOOL,
  makePlanFromProposal,
  buildExecutionInjection,
  isPlanComplete,
} from './plan.js';
import { DELEGATE_TASK_TOOL } from '../tools/agent/delegate.js';
import type { ProfileLoader } from './profiles.js';
import { runSubagent, serializeSubagentResult, generateSubagentId } from './subagent.js';
import { getDecisionMemory } from '../memory/decision-memory.js';
import { getLogger } from '../logging/index.js';

const log = getLogger('agent');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fix #5: 4 intentos totales = 3 retries con delays 1s/2s/4s (spec 12.3)
async function* streamWithRetry(
  provider: IProvider,
  request: CompletionRequest,
  maxAttempts = 4,
): AsyncGenerator<OpenAIStreamChunk> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * Math.pow(2, attempt - 1);
      log.warn('stream retry', {
        attempt,
        maxAttempts,
        backoffMs: backoff,
        err: lastErr,
      });
      await delay(backoff);
    }
    try {
      const gen = provider.complete(request);
      const first = await gen.next();
      if (first.done) return;
      yield first.value;
      yield* gen;
      return;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  log.error('stream failed after retries', { maxAttempts, err: lastErr });
  throw lastErr;
}

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
  | { kind: 'truncated'; tokensBefore: number; tokensAfter: number; roundsRemoved: number }
  | { kind: 'pressure' }; // zona protegida sola ya supera umbral

// ---------------------------------------------------------------------------
// ContextManager — §12.4
// ---------------------------------------------------------------------------
export class ContextManager {
  /** Dato real de `usage.prompt_tokens` del último LLM call (null = no disponible aún). */
  private lastPromptTokens: number | null = null;

  /** Modo de compresión activo (F6). 'conservative' sube el umbral y conserva más rondas. */
  private mode: 'normal' | 'conservative' = 'normal';

  constructor(
    private readonly contextWindow: number,
    private readonly baseKeepRounds: number,
    private readonly provider?: IProvider,
    private readonly model?: string,
    private readonly baseCompressionThreshold = 0.8,
    private readonly compressorModel?: string,
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

  /** Registra el `usage.prompt_tokens` reportado por el provider. */
  recordUsage(promptTokens: number): void {
    this.lastPromptTokens = promptTokens;
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

  /** Devuelve uso actual del contexto. `estimated=true` cuando se usa proxy chars/3.5. */
  usage(messages: Message[]): { used: number; max: number; pct: number; estimated: boolean } {
    let used: number;
    let estimated: boolean;

    if (this.lastPromptTokens !== null) {
      used = this.lastPromptTokens;
      estimated = false;
    } else {
      used = this.estimateFromChars(messages);
      estimated = true;
    }

    const max = this.contextWindow;
    const pct = max > 0 ? Math.round((used / max) * 100) : 0;
    return { used, max, pct, estimated };
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
   */
  async maybeCompress(messages: Message[]): Promise<CompressionResult> {
    const { pct, used } = this.usage(messages);
    if (pct / 100 <= this.compressionThreshold) return { kind: 'skipped' };

    const tokensBefore = used;

    // -----------------------------------------------------------------------
    // Identificar zona protegida:
    // - messages[0] (system prompt)
    // - últimas keepRounds rondas: recorremos desde el final
    // -----------------------------------------------------------------------
    const protectedSet = this.buildProtectedSet(messages);

    // Mensajes candidatos a comprimir (fuera de la zona protegida)
    const oldMessages = messages.filter((_, i) => !protectedSet.has(i));

    if (oldMessages.length === 0) {
      // Toda la conversación está en zona protegida — presión irresolvible
      return { kind: 'pressure' };
    }

    // -----------------------------------------------------------------------
    // Intento 1: compresión vía LLM call
    // -----------------------------------------------------------------------
    let summary: string | null = null;
    if (this.provider) {
      try {
        summary = await this.callCompressor(oldMessages);
      } catch {
        // Caso A: falla → no reintentar → ir a truncado duro
        summary = null;
      }
    }

    if (summary !== null) {
      // Reemplazar historial antiguo por el resumen
      const summaryMsg: Message = {
        role: 'assistant',
        content: `<summary>${summary}</summary>`,
      };

      // Reconstruir messages en el lugar: system + summaryMsg + zona protegida (sin system)
      const protectedMessages = messages.filter((_, i) => protectedSet.has(i) && i !== 0);
      messages.splice(0, messages.length, messages[0]!, summaryMsg, ...protectedMessages);

      const tokensAfter = this.estimateFromChars(messages);
      // Invalidar cache de tokens reales (el historial cambió)
      this.lastPromptTokens = null;

      // Verificar si la compresión fue suficiente
      const newPct = this.contextWindow > 0 ? tokensAfter / this.contextWindow : 0;
      if (newPct <= this.compressionThreshold) {
        return {
          kind: 'compressed',
          tokensBefore,
          tokensAfter,
          roundsCompressed: oldMessages.length,
        };
      }
      // Si no bajó suficiente → caer a truncado duro
    }

    // -----------------------------------------------------------------------
    // Caso B: truncado duro en bloques de 2 rondas
    // -----------------------------------------------------------------------
    return this.hardTruncate(messages, tokensBefore, protectedSet);
  }

  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  /**
   * Construye el Set de índices de la zona protegida:
   * - índice 0 (system prompt)
   * - últimas `keepRounds` rondas (par user+assistant + sus tool messages asociados)
   */
  private buildProtectedSet(messages: Message[]): Set<number> {
    const protected_ = new Set<number>();
    protected_.add(0); // system prompt

    // Recorrer desde el final contando "rondas" (user+assistant)
    let rounds = 0;
    let i = messages.length - 1;
    while (i > 0 && rounds < this.keepRounds) {
      const msg = messages[i];
      if (!msg) {
        i--;
        continue;
      }

      if (msg.role === 'assistant') {
        protected_.add(i);
        // incluir los tool results que siguen a este assistant
        let j = i + 1;
        while (j < messages.length && messages[j]?.role === 'tool') {
          protected_.add(j);
          j++;
        }
        // incluir el user message anterior
        if (i - 1 > 0 && messages[i - 1]?.role === 'user') {
          protected_.add(i - 1);
          i -= 2;
        } else {
          i--;
        }
        rounds++;
      } else {
        protected_.add(i);
        i--;
      }
    }

    return protected_;
  }

  /** Truncado duro: elimina mensajes fuera de la zona protegida en bloques de 2 rondas. */
  private hardTruncate(
    messages: Message[],
    tokensBefore: number,
    protectedSet: Set<number>,
  ): CompressionResult {
    let roundsRemoved = 0;

    const belowThreshold = () => {
      const tokens = this.estimateFromChars(messages);
      return this.contextWindow > 0 && tokens / this.contextWindow <= this.compressionThreshold;
    };

    while (!belowThreshold()) {
      // Encontrar el bloque no-protegido más antiguo (después del system)
      let removed = false;
      for (let i = 1; i < messages.length; i++) {
        if (protectedSet.has(i)) continue;

        // Eliminar hasta 2 mensajes no protegidos consecutivos (user+assistant)
        const toRemove: number[] = [];
        let j = i;
        let blockRounds = 0;
        while (j < messages.length && !protectedSet.has(j) && blockRounds < 2) {
          toRemove.push(j);
          if (messages[j]?.role === 'user' || messages[j]?.role === 'assistant') blockRounds++;
          j++;
        }

        if (toRemove.length === 0) break;

        // Eliminar en orden inverso para no alterar índices
        for (let k = toRemove.length - 1; k >= 0; k--) {
          messages.splice(toRemove[k]!, 1);
          // Ajustar protectedSet (desplazar índices mayores)
          const newProtected = new Set<number>();
          for (const idx of protectedSet) {
            if (idx < toRemove[k]!) newProtected.add(idx);
            else if (idx > toRemove[k]!) newProtected.add(idx - 1);
          }
          protectedSet.clear();
          for (const idx of newProtected) protectedSet.add(idx);
        }

        roundsRemoved += blockRounds;
        removed = true;
        break;
      }

      if (!removed) break; // No queda nada que eliminar
    }

    const tokensAfter = this.estimateFromChars(messages);
    this.lastPromptTokens = null;

    const newPct = this.contextWindow > 0 ? tokensAfter / this.contextWindow : 0;
    if (newPct > this.compressionThreshold) {
      return { kind: 'pressure' };
    }

    return { kind: 'truncated', tokensBefore, tokensAfter, roundsRemoved };
  }

  /** Llama al LLM para comprimir el historial antiguo. */
  private async callCompressor(oldMessages: Message[]): Promise<string> {
    if (!this.provider || !this.model) throw new Error('No provider para compresión');

    const conversationText = oldMessages.map((m) => `${m.role}: ${m.content ?? ''}`).join('\n');

    const compressorMessages: Message[] = [
      {
        role: 'user',
        content:
          'Resume esta conversación en máximo 500 palabras preservando decisiones técnicas y contexto clave:\n\n' +
          conversationText,
      },
    ];

    const model = this.compressorModel ?? this.model;
    let result = '';

    for await (const chunk of this.provider.complete({
      messages: compressorMessages,
      stream: true,
      model,
      signal: AbortSignal.timeout(30000),
    })) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) result += content;
    }

    return result.trim();
  }
}

// ---------------------------------------------------------------------------
// ReactLoop
// ---------------------------------------------------------------------------
export class ReactLoop {
  private readonly dispatcher: ToolDispatcher;
  private readonly contextManager: ContextManager;

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
    },
  ) {
    // Fix #3: pasa maxToolRetries al dispatcher para aplicarlo en sesión
    this.dispatcher = new ToolDispatcher(registry, config.agent.maxToolRetries);
    this.contextManager = new ContextManager(
      contextWindow,
      config.agent.compressionKeepRounds,
      provider,
      model,
      config.agent.compressionThreshold,
      config.agent.compressorModel,
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

      const ctxUsage = this.contextManager.usage(this.messages);
      loopLog.debug('iteration', {
        iter,
        messages: this.messages.length,
        ctxPct: ctxUsage.pct,
        ctxEstimated: ctxUsage.estimated,
      });

      // Comprimir contexto antes de cada iteración (§12.4)
      const comprResult = await this.contextManager.maybeCompress(this.messages);
      if (comprResult.kind === 'compressed' || comprResult.kind === 'truncated') {
        loopLog.info(`context ${comprResult.kind}`, {
          tokensBefore: comprResult.tokensBefore,
          tokensAfter: comprResult.tokensAfter,
        });
      } else if (comprResult.kind === 'pressure') {
        loopLog.warn('context window pressure', { ctxPct: ctxUsage.pct });
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
      const tools: ToolSchema[] = this.registry.toToolSchemas(mode, this.extras?.toolsetFilter);

      const request: CompletionRequest = {
        messages: this.messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        model: this.model,
        signal,
      };

      const buffer = new StreamBuffer();
      let assistantText = '';
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

        try {
          for await (const chunk of streamWithRetry(activeProvider, request)) {
            if (signal.aborted) break;

            // Registrar usage real si viene en el chunk (§12.4)
            if (chunk.usage?.prompt_tokens) {
              this.contextManager.recordUsage(chunk.usage.prompt_tokens);
            }

            for (const ev of buffer.feed(chunk)) {
              emittedVisible = true;
              if (ev.type === 'text_delta') {
                assistantText += ev.delta;
                yield ev;
              } else if (ev.type === 'tool_call_start') {
                toolArgBuffers.set(ev.id, ev.input_so_far);
                yield ev;
              } else if (ev.type === 'tool_call_ready') {
                toolArgBuffers.delete(ev.id);
                readyCalls.push(ev);
                yield ev;
              } else if (ev.type === 'tool_error') {
                parseErrors.push(ev as ParseError);
                yield ev;
              } else {
                yield ev;
              }
            }
          }
        } catch (err) {
          streamErr = err;
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
        this.messages.push({
          role: 'tool',
          tool_call_id: pe.id,
          name: pe.name,
          content: formatToolError(
            pe.name,
            pe.error,
            fmt,
            'Ensure the tool call arguments are valid JSON.',
          ),
        });
      }

      // -----------------------------------------------------------------------
      // Hito 7 — Plan & Execute: separar las tools de control de plan y aplicar
      // el allowlist read-only del modo plan ANTES de despachar nada normal.
      // -----------------------------------------------------------------------
      const regularCalls: ToolCallReady[] = [];
      const updatePlanCalls: ToolCallReady[] = [];
      const delegateCalls: ToolCallReady[] = [];
      let presentPlanCall: ToolCallReady | null = null;

      for (const call of readyCalls) {
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
                : "present_plan solo está disponible en modo plan.";
            yield { type: 'tool_error', id: call.id, name: call.name, error: err, recoverable: true };
            this.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: formatToolError(call.name, err, fmt, undefined),
            });
          }
          continue;
        }

        // update_plan: actualización de estado de paso. Solo válido en execute.
        if (call.name === UPDATE_PLAN_TOOL) {
          if (mode === 'execute') {
            updatePlanCalls.push(call);
          } else {
            const err = 'update_plan solo está disponible durante la ejecución de un plan.';
            yield { type: 'tool_error', id: call.id, name: call.name, error: err, recoverable: true };
            this.messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: formatToolError(call.name, err, fmt, undefined),
            });
          }
          continue;
        }

        // Modo plan: cualquier tool mutante fuera del allowlist read-only se
        // rechaza con un tool_error recuperable inyectado (UI §5.4, Fase 1).
        if (mode === 'plan' && !PLAN_ALLOWLIST.has(call.name)) {
          const err = `Plan mode: tool '${call.name}' deshabilitada hasta aprobar el plan`;
          yield { type: 'tool_error', id: call.id, name: call.name, error: err, recoverable: true };
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: formatToolError(
              call.name,
              err,
              fmt,
              'Use only read-only tools, then call present_plan with your plan.',
            ),
          });
          continue;
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
          yield { type: 'tool_error', id: call.id, name: call.name, error: err, recoverable: true };
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: formatToolError(call.name, err, fmt, undefined),
          });
          continue;
        }
        step.status = status;
        yield { type: 'plan_step_update', stepId, status };
        persistPlan(plan ? isPlanComplete(plan) : false);
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: `Paso ${stepId} → ${status}.`,
        });
      }

      // Despachar tool calls con JSON válido (excluyendo las de control de plan)
      if (regularCalls.length > 0) {
        const ctx: ToolContext = {
          signal,
          cwd: process.cwd(),
          config: this.config,
          allowDestructive: opts?.allowDestructive,
          destructivePolicy:
            opts?.destructivePolicy ?? (opts?.allowDestructive === true ? 'allow' : 'ask'),
          confirmDestructive: opts?.onConfirmDestructive,
        };

        const results: DispatchResult[] = await this.dispatcher.dispatch(regularCalls, ctx);

        for (const res of results) {
          if (res.result.ok) {
            yield {
              type: 'tool_result',
              id: res.callId,
              name: res.toolName,
              result: res.result.output,
              durationMs: res.durationMs,
            };
            this.messages.push({
              role: 'tool',
              tool_call_id: res.callId,
              name: res.toolName,
              content: res.result.output,
            });
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
            yield {
              type: 'tool_error',
              id: res.callId,
              name: res.toolName,
              error: res.result.error,
              recoverable: res.result.recoverable,
            };
            this.messages.push({
              role: 'tool',
              tool_call_id: res.callId,
              name: res.toolName,
              content: formatToolError(res.toolName, res.result.error, fmt, undefined),
            });
          }
        }
      }

      // -----------------------------------------------------------------------
      // Hito 8 — Delegación (§12.16). delegate_task se ejecuta a término de forma
      // secuencial y bloqueante dentro del turno (8A: concurrencia = 1). El
      // SubagentResult, truncado, se inyecta como tool result (inject & recover).
      // -----------------------------------------------------------------------
      for (const call of delegateCalls) {
        const input = call.input as { task?: unknown; profile?: unknown; context?: unknown };
        const profileName =
          typeof input.profile === 'string' && input.profile
            ? input.profile
            : this.config.agents.defaultProfile;
        const profiles = this.extras?.profiles;
        const profile = profiles?.resolve(profileName);

        // Perfil inexistente → tool_error recuperable (no falla la validación).
        if (!profile) {
          const available = profiles?.availableNames().join(', ') ?? 'general';
          const err = `unknown profile '${profileName}'; available: ${available}`;
          yield { type: 'tool_error', id: call.id, name: call.name, error: err, recoverable: true };
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: formatToolError(call.name, err, fmt, 'Use one of the available profiles, or "general".'),
          });
          continue;
        }

        const subId = generateSubagentId();
        const taskText = String(input.task ?? '');
        const context = Array.isArray(input.context)
          ? input.context.filter((p): p is string => typeof p === 'string')
          : undefined;

        yield { type: 'subagent_started', subagentId: subId, profile: profile.name, task: taskText };

        const result = await runSubagent({
          task: {
            id: subId,
            task: taskText,
            profile: profile.name,
            context,
            budget: profile.budget,
          },
          profile,
          registry: this.registry,
          config: this.config,
          parentSignal: signal,
          parentDestructivePolicy:
            opts?.destructivePolicy ?? (opts?.allowDestructive === true ? 'allow' : 'ask'),
          onConfirmDestructive: opts?.onConfirmDestructive,
          makeRouter: opts?.makeSubagentRouter
            ? () => opts.makeSubagentRouter!(profile)
            : undefined,
        });

        yield { type: 'subagent_completed', subagentId: subId, result };
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: serializeSubagentResult(result, profile.name),
        });
      }

      // -----------------------------------------------------------------------
      // Hito 7 — Fase 2: gate de aprobación. Se procesa AL FINAL del turno, tras
      // cualquier tool read-only del mismo turno, para cerrar la planificación.
      // -----------------------------------------------------------------------
      if (presentPlanCall) {
        const proposed = makePlanFromProposal(
          presentPlanCall.input as { summary: string; steps: Array<{ title: string; detail?: string }> },
        );
        plan = proposed;
        yield { type: 'plan_proposed', plan: proposed };
        // No persistir antes del gate: si el usuario rechaza, el plan nunca
        // llega a ejecutarse y no debe quedar como in_progress en disco.

        // Resolver el gate. Sin callback (CI/piped sin TTY) → rechazo.
        let decision: PlanDecision;
        try {
          decision = opts?.onApprovePlan
            ? await opts.onApprovePlan(proposed)
            : { decision: 'reject' };
        } catch {
          decision = { decision: 'reject' };
        }

        if (decision.decision === 'approve') {
          plan = decision.plan;
          mode = 'execute';
          persistPlan(isPlanComplete(plan));
          loopLog.info('plan approved', { steps: plan.steps.length });
          this.messages.push({
            role: 'tool',
            tool_call_id: presentPlanCall.id,
            name: presentPlanCall.name,
            content: buildExecutionInjection(plan),
          });
          // Continúa el loop: la próxima iteración ya corre en modo execute.
          continue;
        }

        // Rechazo: el turno termina sin ejecutar (UI §5.4 Fase 2).
        loopLog.info('plan rejected');
        this.messages.push({
          role: 'tool',
          tool_call_id: presentPlanCall.id,
          name: presentPlanCall.name,
          content: 'El usuario rechazó el plan. Detente y espera nuevas instrucciones.',
        });
        yield { type: 'done', stopReason: 'stop' };
        return;
      }
    }

    loopLog.warn('max iterations reached', { maxIterations });
    yield { type: 'done', stopReason: 'max_iterations' };
  }

  getContextUsage(): { used: number; max: number; pct: number; estimated: boolean } {
    return this.contextManager.usage(this.messages);
  }
}
