import { zodToJsonSchema } from 'zod-to-json-schema';
import { redact } from '../logging/redact.js';
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolCallReady,
  DestructiveDecision,
} from '../agent/types.js';
import type { ToolSchema } from '../providers/base.js';
import type { AgentMode } from '../agent/types.js';
import { truncateToolOutput } from './truncate.js';
import { PLAN_ALLOWLIST, PRESENT_PLAN_TOOL, UPDATE_PLAN_TOOL } from '../agent/plan.js';
import { DELEGATE_TASK_TOOL } from './agent/delegate.js';
import { QUESTION_TOOL } from './question.js';
import { TODO_TOOL } from './todo.js';
import { TEST_EVIDENCE_TOOL } from './tdd.js';
import { getLogger } from '../logging/index.js';
import { redactText } from '../security/redact-output.js';

const log = getLogger('tools');

/**
 * Hito 16 — red de seguridad de una tool con `structuredCancellation`: tras el
 * abort, se le da este margen para matar su trabajo y devolver su propio
 * resultado `cancelled` antes de rechazar la llamada.
 */
export const STRUCTURED_CANCEL_GRACE_MS = 5000;

/** Hito 16 — redacción de secretos (§11.3) sobre la salida o el error de una tool. */
function redactResult(result: ToolResult, ctx: ToolContext): ToolResult {
  return result.ok
    ? { ok: true, output: redactText(result.output, ctx.config) }
    : { ...result, error: redactText(result.error, ctx.config) };
}

/** `serialized` estático o `isSerialized` por llamada; un hook que lanza serializa. */
function wantsSerial(tool: ToolDefinition | undefined, input: unknown, ctx: ToolContext): boolean {
  if (!tool) return false;
  if (tool.serialized === true) return true;
  if (!tool.isSerialized) return false;
  try {
    return tool.isSerialized(input, ctx);
  } catch (err) {
    log.warn('isSerialized threw, serializing', { tool: tool.name, err });
    return true;
  }
}

/**
 * ¿Es la tool `name` visible para el modelo en el modo dado? (Hito 7)
 * - 'normal'  → todo salvo las tools de control de plan.
 * - 'plan'    → solo la allowlist read-only + present_plan (Fase 1).
 * - 'execute' → todo salvo present_plan; update_plan sí (Fase 3).
 */
export function isToolVisibleInMode(name: string, mode: AgentMode): boolean {
  if (mode === 'plan') {
    return name === PRESENT_PLAN_TOOL || PLAN_ALLOWLIST.has(name);
  }
  // Hito 11: durante un plan aprobado el checklist ES el plan. Ofrecer además
  // `todo` invita al modelo a llevar dos listas divergentes del mismo trabajo.
  if (mode === 'execute') {
    return name !== PRESENT_PLAN_TOOL && name !== TODO_TOOL;
  }
  // normal
  return name !== PRESENT_PLAN_TOOL && name !== UPDATE_PLAN_TOOL;
}

/**
 * Filtrado de toolset por perfil (Hito 8A). Generaliza el filtro de modo a la
 * dimensión "perfil de subagente":
 *  - `allowedTools` (cuando no es null) restringe a su intersección.
 *  - `isSubagent` fuerza profundidad = 1 ocultando delegate_task: el subagente
 *    nunca puede delegar de nuevo (§12.16). Oculta también `question`: la TTY
 *    es del padre y un hijo en paralelo no tiene con quién dialogar.
 */
export interface ToolsetFilter {
  allowedTools?: readonly string[] | null;
  isSubagent?: boolean;
  /**
   * Hito 15 — perfil activo como agente principal. `'keep'` deja pasar las
   * tools de control del loop (`CONTROL_TOOLS`) aunque `allowedTools` no las
   * liste: un perfil describe capacidades operativas, y sin `present_plan` un
   * `/plan` bajo `/agent code` no podría ni presentar el plan. El filtro de
   * modo sigue decidiendo cuáles aplican.
   */
  controlTools?: 'keep';
}

/**
 * Tools de control interceptadas por el loop (nunca tocan el sistema). No
 * incluye `delegate_task`: delegar en `general` devolvería todas las tools a un
 * perfil restringido, así que solo aparece si el perfil la lista.
 */
export const CONTROL_TOOLS: ReadonlySet<string> = new Set([
  PRESENT_PLAN_TOOL,
  UPDATE_PLAN_TOOL,
  QUESTION_TOOL,
  TODO_TOOL,
  TEST_EVIDENCE_TOOL,
]);

export function isToolVisibleForProfile(name: string, filter?: ToolsetFilter): boolean {
  if (!filter) return true;
  if (filter.controlTools === 'keep' && CONTROL_TOOLS.has(name)) return true;
  // Hito 11: `todo` también queda fuera. La lista es del padre y se reinyecta
  // en SU system prompt; un hijo con contexto aislado no comparte ese estado.
  if (
    filter.isSubagent &&
    (name === DELEGATE_TASK_TOOL || name === QUESTION_TOOL || name === TODO_TOOL)
  ) {
    return false;
  }
  if (filter.allowedTools && !filter.allowedTools.includes(name)) return false;
  return true;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private disabledTools = new Set<string>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Retira una tool del registro. La usa `/mcp reload` (Hito 10) para que las
   * tools de un server que ya no conecta no queden apuntando a un cliente
   * muerto. Devuelve true si la tool existía.
   */
  unregister(name: string): boolean {
    this.disabledTools.delete(name);
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Elimina la tool del schema enviado al LLM para el resto de la sesión (spec 12.3). */
  disableForSession(name: string): void {
    this.disabledTools.add(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  toToolSchemas(mode: AgentMode = 'normal', filter?: ToolsetFilter): ToolSchema[] {
    return this.list()
      .filter((tool) => !this.disabledTools.has(tool.name))
      .filter((tool) => isToolVisibleInMode(tool.name, mode))
      .filter((tool) => isToolVisibleForProfile(tool.name, filter))
      .map((tool) => {
        // Tools MCP traen su propio JSON Schema — usarlo directamente para
        // evitar una conversión lossy (JSON Schema → Zod → JSON Schema).
        const parameters: Record<string, unknown> = tool.rawParameters
          ? tool.rawParameters
          : (() => {
              const full = zodToJsonSchema(tool.schema, {
                $refStrategy: 'none',
                target: 'jsonSchema7',
              }) as Record<string, unknown>;
              const { $schema: _unused, ...rest } = full;
              return rest;
            })();
        return {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters,
          },
        } satisfies ToolSchema;
      });
  }
}

export interface DispatchResult {
  callId: string;
  toolName: string;
  result: ToolResult;
  durationMs: number;
}

export class ToolDispatcher {
  private readonly toolFailureCounts = new Map<string, number>();
  /** El usuario respondió `!` (allow-all): no volver a preguntar en esta sesión. */
  private allowAllDestructive = false;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly maxToolRetries: number = 3,
    private readonly cancelGraceMs: number = STRUCTURED_CANCEL_GRACE_MS,
  ) {}

  async dispatch(calls: ToolCallReady[], ctx: ToolContext): Promise<DispatchResult[]> {
    if (calls.length === 0) return [];

    // -------------------------------------------------------------------
    // Fase de confirmación destructiva (§12.5 / UI §12).
    // Se resuelve secuencialmente ANTES de ejecutar nada (§12.9: nunca dos
    // prompts a la vez), así las aprobadas pueden correr en paralelo después.
    // -------------------------------------------------------------------
    const denied = new Map<string, ToolResult>();

    // Capa de veto (Hito 11): se evalúa ANTES de confirmar nada. Al usuario no
    // se le pregunta por un `rm -rf /` que nunca se va a ejecutar, y ninguna
    // política de sesión puede levantar este rechazo.
    for (const call of calls) {
      const veto = this.preflight(call, ctx);
      if (veto !== null) denied.set(call.id, veto);
    }

    for (const call of calls) {
      if (denied.has(call.id)) continue;
      const verdict = await this.confirmIfDestructive(call, ctx);
      // Hito 16: el rechazo cita el comando, que puede llevar un secreto.
      if (verdict !== null) denied.set(call.id, redactResult(verdict, ctx));
    }

    const approved = calls.filter((c) => !denied.has(c.id));

    const deniedResults: DispatchResult[] = calls
      .filter((c) => denied.has(c.id))
      .map((c) => ({
        callId: c.id,
        toolName: c.name,
        result: denied.get(c.id)!,
        durationMs: 0,
      }));

    const executed = await this.dispatchApproved(approved, ctx);

    // Mantener el orden original de las calls
    const byId = new Map<string, DispatchResult>();
    for (const r of [...deniedResults, ...executed]) byId.set(r.callId, r);
    return calls.map((c) => byId.get(c.id)!);
  }

  /**
   * Veto de preflight (Hito 11). `null` si la tool no define el hook o lo pasa.
   * Un fallo del propio hook nunca bloquea: se registra y se deja pasar a la
   * fase de confirmación, que sí es capaz de detener la call.
   */
  private preflight(call: ToolCallReady, ctx: ToolContext): ToolResult | null {
    const tool = this.registry.get(call.name);
    if (!tool?.preflight) return null;
    let verdict: ToolResult | null;
    try {
      verdict = tool.preflight(call.input, ctx);
    } catch (err) {
      log.warn('preflight threw', { tool: call.name, err });
      return null;
    }
    if (verdict === null) return null;
    verdict = redactResult(verdict, ctx);
    log.warn('preflight blocked', {
      tool: call.name,
      reason: verdict.ok ? '' : verdict.error,
    });
    return verdict;
  }

  /**
   * Devuelve `null` si la call puede ejecutarse, o un ToolResult de error si
   * fue bloqueada (denegada por el usuario o por política).
   */
  private async confirmIfDestructive(
    call: ToolCallReady,
    ctx: ToolContext,
  ): Promise<ToolResult | null> {
    const tool = this.registry.get(call.name);
    if (!tool) return null; // dispatchOne reportará "not found"

    if (!ctx.config.tools.confirmDestructive) return null;

    const isDestructive =
      tool.destructive === true || (tool.isDestructive?.(call.input, ctx) ?? false);
    if (!isDestructive) return null;

    const policy = ctx.destructivePolicy ?? (ctx.allowDestructive === true ? 'allow' : 'ask');

    if (policy === 'allow' || this.allowAllDestructive) return null;

    // Hito 16: la descripción cita el comando (puede llevar un secreto) y va al
    // log y al prompt de confirmación: redactada con el núcleo y los extras.
    const description = redactText(describeCall(call), ctx.config);

    if (policy === 'deny' || !ctx.confirmDestructive) {
      // --deny-destructive explícito, o modo piped/CI sin TTY (§12.5)
      log.warn('destructive blocked', { tool: call.name, policy, description });
      return {
        ok: false,
        error:
          `Destructive operation blocked: ${description}. ` +
          'Destructive operations are not allowed in this session. Consider a non-destructive alternative.',
        recoverable: true,
      };
    }

    let decision: DestructiveDecision;
    try {
      decision = await ctx.confirmDestructive({
        callId: call.id,
        toolName: call.name,
        description,
      });
    } catch {
      decision = 'deny';
    }

    log.info('destructive decision', { tool: call.name, decision, description });

    if (decision === 'allow-all') {
      this.allowAllDestructive = true;
      return null;
    }
    if (decision === 'approve') return null;

    return {
      ok: false,
      error: `User denied execution of: ${description}. Ask the user how to proceed or try a non-destructive alternative.`,
      recoverable: true,
    };
  }

  private async dispatchApproved(
    calls: ToolCallReady[],
    ctx: ToolContext,
  ): Promise<DispatchResult[]> {
    if (calls.length === 0) return [];
    if (calls.length === 1) {
      return [await this.dispatchOne(calls[0]!, ctx)];
    }

    const hasSerializedCall = calls.some((c) =>
      wantsSerial(this.registry.get(c.name), c.input, ctx),
    );

    if (hasSerializedCall) {
      const results: DispatchResult[] = [];
      for (const call of calls) {
        results.push(await this.dispatchOne(call, ctx));
      }
      return results;
    }

    const settled = await Promise.allSettled(calls.map((call) => this.dispatchOne(call, ctx)));

    return settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const call = calls[i]!;
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: String((r as PromiseRejectedResult).reason),
          recoverable: true,
        },
        durationMs: 0,
      };
    });
  }

  private recordFailure(name: string): void {
    this.toolFailureCounts.set(name, (this.toolFailureCounts.get(name) ?? 0) + 1);
  }

  /**
   * Hito 16 — contabilidad CONSECUTIVA (§12.3, y lo que ya decía el mensaje de
   * deshabilitado): un éxito reinicia la racha; un error que la tool marca con
   * `countsAsFailure: false` (un comando que se ejecutó y salió ≠ 0) ni suma ni
   * la reinicia. Antes el contador era acumulado: tres `grep` sin coincidencias
   * a lo largo de la sesión bastaban para quedarse sin shell.
   */
  private recordOutcome(name: string, result: ToolResult): void {
    if (result.ok) {
      this.toolFailureCounts.delete(name);
      return;
    }
    if (result.countsAsFailure === false) return;
    this.recordFailure(name);
  }

  /**
   * §12.3 — al ALCANZAR el límite de fallos consecutivos la tool se deshabilita
   * en ese mismo resultado (que pasa a no recuperable y lo explica), no en la
   * llamada siguiente: si no, seguiría en el schema de la próxima iteración.
   */
  private applyRetryLimit(name: string, result: ToolResult): ToolResult {
    if (result.ok || result.countsAsFailure === false) return result;
    const failures = this.toolFailureCounts.get(name) ?? 0;
    if (failures < this.maxToolRetries) return result;
    this.registry.disableForSession(name);
    log.warn('tool disabled for session', { tool: name, failures });
    return {
      ...result,
      recoverable: false,
      error:
        `${result.error}\n\nTool "${name}" has been disabled for this session after ` +
        `${failures} consecutive failures.`,
    };
  }

  private async dispatchOne(call: ToolCallReady, ctx: ToolContext): Promise<DispatchResult> {
    const start = Date.now();
    const tool = this.registry.get(call.name);

    if (!tool) {
      log.warn('tool not found', { tool: call.name });
      return {
        callId: call.id,
        toolName: call.name,
        result: { ok: false, error: `Tool "${call.name}" not found`, recoverable: false },
        durationMs: Date.now() - start,
      };
    }

    const failCount = this.toolFailureCounts.get(call.name) ?? 0;
    if (failCount >= this.maxToolRetries) {
      log.warn('tool disabled for session', { tool: call.name, failures: failCount });
      this.registry.disableForSession(call.name);
      return {
        callId: call.id,
        toolName: call.name,
        result: {
          ok: false,
          error: `Tool "${call.name}" has been disabled for this session after ${failCount} consecutive failures.`,
          recoverable: false,
        },
        durationMs: Date.now() - start,
      };
    }

    log.debug('tool start', { tool: call.name });

    const parsed = tool.schema.safeParse(call.input);
    if (!parsed.success) {
      this.recordFailure(call.name);
      const error = redactText(`Invalid parameters: ${parsed.error.message}`, ctx.config);
      log.warn('tool invalid params', { tool: call.name, error });
      return {
        callId: call.id,
        toolName: call.name,
        result: this.applyRetryLimit(call.name, { ok: false, error, recoverable: true }),
        durationMs: Date.now() - start,
      };
    }

    // Timeout y cancelación: el signal derivado combina la cancelación del
    // usuario (Ctrl+C → ctx.signal) con el timeout de la tool, y se pasa a
    // execute() para que las tools bien portadas aborten su trabajo subyacente
    // (fetch, execa...). El Promise.race actúa de red de seguridad para tools
    // que ignoren el signal.
    const timeoutMs = tool.timeout ?? 30000;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () =>
        timeoutController.abort(new Error(`Tool "${call.name}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const combinedSignal = AbortSignal.any([ctx.signal, timeoutController.signal]);
    const execCtx: ToolContext = { ...ctx, signal: combinedSignal };
    // Hito 16: con `structuredCancellation` la tool mata su propio trabajo y
    // devuelve un resultado `cancelled`; si el race rechazase en el acto, ese
    // resultado (y su auditoría) se perdería. Solo queda una red de seguridad.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    // Un abort que llega cuando la tool ya terminó no debe armar nada: sin esto,
    // un Ctrl+C tras un `exec` dejaba un temporizador de gracia vivo.
    let raceSettled = false;
    let onRaceAbort: (() => void) | undefined;

    try {
      let raw = await Promise.race([
        tool.execute(parsed.data, execCtx),
        new Promise<never>((_, reject) => {
          onRaceAbort = () => {
            if (raceSettled) return;
            const reason: unknown = combinedSignal.reason;
            const err =
              reason instanceof Error ? reason : new Error(`Tool "${call.name}" was cancelled`);
            if (tool.structuredCancellation) {
              graceTimer = setTimeout(() => reject(err), this.cancelGraceMs);
            } else {
              reject(err);
            }
          };
          combinedSignal.addEventListener('abort', onRaceAbort, { once: true });
          // Una señal que ya llega abortada no vuelve a emitir `abort`: sin
          // esto, la red de seguridad no se armaría nunca.
          if (combinedSignal.aborted) onRaceAbort();
        }),
      ]).finally(() => {
        raceSettled = true;
        if (onRaceAbort) combinedSignal.removeEventListener('abort', onRaceAbort);
      });
      clearTimeout(timeoutId);
      clearTimeout(graceTimer);
      this.recordOutcome(call.name, raw);
      raw = this.applyRetryLimit(call.name, raw);
      // Redactar ANTES de loguear y de truncar: un bloque PEM cortado por el
      // truncado dejaría de casar con su patrón.
      const result = redactResult(raw, ctx);
      const durationMs = Date.now() - start;
      if (result.ok) {
        log.debug('tool ok', { tool: call.name, durationMs, outputChars: result.output.length });
      } else {
        log.warn('tool error', {
          tool: call.name,
          durationMs,
          recoverable: result.recoverable,
          error: result.error,
        });
      }
      // F4: truncar cualquier salida de tool antes de que entre al historial,
      // para proteger el contexto del modelo (cabeza 80% + cola 20%).
      const truncated: ToolResult = result.ok
        ? { ok: true, output: truncateToolOutput(result.output) }
        : { ...result, error: truncateToolOutput(result.error) };
      return {
        callId: call.id,
        toolName: call.name,
        result: truncated,
        durationMs,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      clearTimeout(graceTimer);
      this.recordFailure(call.name);
      const result = this.applyRetryLimit(
        call.name,
        redactResult(
          { ok: false, error: String(err instanceof Error ? err.message : err), recoverable: true },
          ctx,
        ),
      );
      log.warn('tool threw', {
        tool: call.name,
        durationMs: Date.now() - start,
        error: result.ok ? '' : result.error,
      });
      return {
        callId: call.id,
        toolName: call.name,
        result,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Descripción legible de una tool call para el prompt de confirmación. */
export function describeCall(call: ToolCallReady): string {
  // `exec` y tools SSH (§12.14): el dónde va primero — antes de saber *qué* se
  // ejecuta, el usuario necesita saber *dónde*.
  if (call.name === 'exec' && typeof call.input.command === 'string') {
    const target =
      typeof call.input.target === 'string' && call.input.target.trim()
        ? call.input.target.trim()
        : 'local';
    return `exec [${target}]: ${call.input.command}`;
  }
  if (call.name.startsWith('ssh_') && typeof call.input.host === 'string') {
    const detail = [call.input.localPath, call.input.remotePath].filter(Boolean).join(' → ');
    return `${call.name} [${call.input.host}]: ${detail}`;
  }
  // Redacción estructural antes de serializar: `redactText` (que el dispatcher
  // aplica después) solo reconoce formas de secreto, no un `{"password": "…"}`
  // cualquiera. La descripción viaja al usuario — a la terminal y, en Stratum
  // Desktop, al webview (`confirm_request`).
  const compact = JSON.stringify(redact(call.input));
  const summary = compact.length > 120 ? compact.slice(0, 117) + '...' : compact;
  return `${call.name}: ${summary}`;
}
