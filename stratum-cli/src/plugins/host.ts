/**
 * `PluginHost` (PL1): los plugins cargados en una sesión y sus hooks. Es lo
 * único que el runtime ve de ellos: el dispatcher le pide vetos y anotaciones,
 * el agente le pasa sus eventos y quien aloja la sesión le avisa del principio
 * y el final.
 *
 * Reglas (`CLI-DOC/Plugins-Implementacion.md` §2–§3):
 * - `tool.before` **falla cerrado**: si lanza, vence `hookTimeoutMs` o se agota
 *   el tope del lote (`batchTimeoutMs`), la llamada se veta. Corre en secuencia,
 *   en orden de carga, y serializado con un mutex entre subagentes.
 * - Los demás hooks **fallan abierto**: el error se registra y se sigue; tres
 *   seguidos dan de baja ese handler para la sesión.
 * - Ningún hook recibe un objeto que el runtime vaya a leer después: todo llega
 *   clonado (y los argumentos de `tool.before`, congelados).
 * - Un plazo vencido deja de **esperar**, no detiene el handler (no hay sandbox):
 *   su resultado tardío se descarta.
 */
import type { AgentEvent } from '../agent/events.js';
import { Mutex, untilAborted } from '../agent/concurrency.js';
import { getLogger } from '../logging/index.js';
import {
  PLUGIN_API_VERSION,
  type PluginAPI,
  type PluginAgentRef,
  type PluginHookName,
  type PluginHooks,
  type SessionEndInfo,
  type SessionStartInfo,
  type StratumPlugin,
  type ToolAfterInfo,
  type ToolCallInfo,
} from './api.js';
import type { PluginSkip, PluginSource } from './discover.js';

const log = getLogger('plugins');

/** Fallos seguidos de un handler de notificación antes de darlo de baja. */
export const NOTIFY_FAILURE_LIMIT = 3;
/** Notificaciones en cola por handler antes de descartar (un `text_delta` por token suma rápido). */
export const MAX_QUEUED_NOTIFICATIONS = 1_000;
/** Tope del motivo de un veto: va al modelo. */
const MAX_REASON_CHARS = 2_000;

export interface PluginLimits {
  hookTimeoutMs: number;
  setupTimeoutMs: number;
  batchTimeoutMs: number;
}

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = {
  hookTimeoutMs: 5_000,
  setupTimeoutMs: 10_000,
  batchTimeoutMs: 15_000,
};

export interface PluginHostContext {
  cwd: string;
  worktree: string;
  version: string;
}

interface Registration<K extends PluginHookName> {
  pluginId: string;
  handler: PluginHooks[K];
  failures: number;
  disabled: boolean;
  /** Entrega en orden de las notificaciones de este handler. */
  queue: Promise<void>;
  /** Notificaciones en cola (tope `MAX_QUEUED_NOTIFICATIONS`). */
  pending: number;
  /** Se está descartando por cola llena (para avisar una sola vez). */
  dropping: boolean;
}

type Registry = { [K in PluginHookName]: Registration<K>[] };

export interface LoadedPluginInfo {
  id: string;
  source: PluginSource;
  entry: string;
  hooks: Partial<Record<PluginHookName, number>>;
}

export interface DisabledHook {
  id: string;
  hook: PluginHookName;
  reason: string;
}

export interface PluginReport {
  /** `false` con `--no-plugins` o `plugins.enabled: false`. */
  enabled: boolean;
  loaded: LoadedPluginInfo[];
  skipped: PluginSkip[];
  disabledHooks: DisabledHook[];
}

/** Una llamada que el dispatcher somete a `tool.before`. */
export interface VetoRequest {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  agent: PluginAgentRef;
  sessionId?: string;
}

export interface PluginVeto {
  /** Plugin que vetó; `null` si fue el tope del lote. */
  pluginId: string | null;
  /** Texto para el modelo, sin redactar todavía (lo redacta el dispatcher). */
  reason: string;
}

type Outcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; err: unknown }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

/**
 * Corre `fn` con un plazo y la señal del turno. Le pasa una señal propia que se
 * aborta en cualquiera de los dos casos; el resultado tardío se descarta.
 */
async function bounded<T>(
  fn: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<Outcome<T>> {
  if (parent?.aborted) return { kind: 'aborted' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort(new Error('plugin hook timed out'));
        resolve({ kind: 'timeout' });
      },
      Math.max(0, timeoutMs),
    );
    if (parent) {
      onAbort = () => {
        controller.abort(parent.reason);
        resolve({ kind: 'aborted' });
      };
      parent.addEventListener('abort', onAbort, { once: true });
    }
  });
  const run = (async (): Promise<Outcome<T>> => {
    try {
      return { kind: 'ok', value: await fn(controller.signal) };
    } catch (err) {
      return { kind: 'error', err };
    }
  })();
  try {
    return await Promise.race([run, stop]);
  } finally {
    clearTimeout(timer);
    if (parent && onAbort) parent.removeEventListener('abort', onAbort);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Copia que el plugin puede tocar sin que el runtime lo note. `undefined` si no se puede clonar. */
function cloneForPlugin<T>(value: T): T | undefined {
  try {
    return structuredClone(value);
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text;
}

export class PluginHost {
  private readonly hooks: Registry = {
    'tool.before': [],
    'tool.after': [],
    event: [],
    'session.start': [],
    'session.end': [],
  };
  private readonly loaded: LoadedPluginInfo[] = [];
  private readonly skipped: PluginSkip[] = [];
  private readonly disabledHooks: DisabledHook[] = [];
  private readonly revoked = new Set<string>();
  private readonly vetoMutex = new Mutex();
  private sessionInfo: SessionStartInfo | null = null;
  private disposed = false;

  constructor(
    private readonly limits: PluginLimits,
    private readonly ctx: PluginHostContext,
    private readonly enabled = true,
  ) {}

  /** Sin plugins: el runtime se comporta exactamente como sin este módulo. */
  static empty(enabled = true): PluginHost {
    return new PluginHost(DEFAULT_PLUGIN_LIMITS, { cwd: '', worktree: '', version: '' }, enabled);
  }

  /** ¿Hay algún handler vivo de este hook? El dispatcher no hace nada si no. */
  hasHook(hook: PluginHookName): boolean {
    return this.hooks[hook].some((r) => !r.disabled);
  }

  get size(): number {
    return this.loaded.length;
  }

  /** Lo que no se cargó (descubrimiento o carga), para el informe. */
  noteSkipped(skip: PluginSkip): void {
    this.skipped.push(skip);
  }

  isLoaded(id: string): boolean {
    return this.loaded.some((p) => p.id === id);
  }

  /**
   * Ejecuta el `setup` de un plugin ya validado. Con un fallo o un plazo
   * vencido, todo lo que registró se retira y el plugin queda en `skipped`.
   */
  async add(
    plugin: StratumPlugin,
    meta: { source: PluginSource; entry: string; options: Record<string, unknown> },
  ): Promise<boolean> {
    const id = plugin.id;
    const counts: Partial<Record<PluginHookName, number>> = {};
    const api: PluginAPI = Object.freeze({
      id,
      on: <K extends PluginHookName>(hook: K, handler: PluginHooks[K]): (() => void) => {
        if (this.revoked.has(id) || this.disposed || !(hook in this.hooks)) return () => undefined;
        if (typeof handler !== 'function') return () => undefined;
        const reg: Registration<K> = {
          pluginId: id,
          handler,
          failures: 0,
          disabled: false,
          queue: Promise.resolve(),
          pending: 0,
          dropping: false,
        };
        (this.hooks[hook] as Registration<K>[]).push(reg);
        counts[hook] = (counts[hook] ?? 0) + 1;
        return () => {
          const list = this.hooks[hook] as Registration<K>[];
          const i = list.indexOf(reg);
          if (i >= 0) list.splice(i, 1);
        };
      },
      log: getLogger(`plugin.${id}`),
      project: Object.freeze({ cwd: this.ctx.cwd, worktree: this.ctx.worktree }),
      version: Object.freeze({ stratum: this.ctx.version, api: PLUGIN_API_VERSION }),
    });

    const options = cloneForPlugin(meta.options) ?? {};
    const outcome = await bounded(() => plugin.setup(api, options), this.limits.setupTimeoutMs);
    if (outcome.kind !== 'ok') {
      this.revoke(id);
      const reason =
        outcome.kind === 'timeout'
          ? `setup no terminó en ${this.limits.setupTimeoutMs} ms`
          : `setup falló: ${outcome.kind === 'error' ? errorText(outcome.err) : 'cancelado'}`;
      this.skipped.push({ source: meta.source, id, entry: meta.entry, reason });
      log.warn('plugin setup failed', { id, reason });
      return false;
    }
    this.loaded.push({ id, source: meta.source, entry: meta.entry, hooks: counts });
    log.info('plugin loaded', { id, source: meta.source, hooks: counts });
    return true;
  }

  /** Retira todo lo que registró un plugin; lo que registre después no tiene efecto. */
  private revoke(id: string): void {
    this.revoked.add(id);
    for (const hook of Object.keys(this.hooks) as PluginHookName[]) {
      const list = this.hooks[hook] as Registration<PluginHookName>[];
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.pluginId === id) list.splice(i, 1);
    }
  }

  /**
   * `tool.before` de un lote. Devuelve el veto de cada llamada vetada; las que
   * no están en el mapa pasan. Si el turno se cancela a mitad, devuelve lo
   * decidido hasta entonces: el dispatcher ya no ejecuta nada de un turno
   * cancelado.
   */
  async vetoBatch(requests: VetoRequest[], signal: AbortSignal): Promise<Map<string, PluginVeto>> {
    const vetoes = new Map<string, PluginVeto>();
    if (requests.length === 0 || !this.hasHook('tool.before')) return vetoes;
    // Un turno cancelado no espera al lote de otro (un subagente): sale ya, y
    // el dispatcher no ejecuta nada de un turno cancelado.
    return untilAborted(this.vetoBatchExclusive(requests, signal, vetoes), signal, vetoes);
  }

  private vetoBatchExclusive(
    requests: VetoRequest[],
    signal: AbortSignal,
    vetoes: Map<string, PluginVeto>,
  ): Promise<Map<string, PluginVeto>> {
    return this.vetoMutex.runExclusive(async () => {
      const deadline = Date.now() + this.limits.batchTimeoutMs;
      for (const [index, req] of requests.entries()) {
        const handlers = this.hooks['tool.before'].filter((r) => !r.disabled);
        for (const reg of handlers) {
          if (signal.aborted) return vetoes;
          const left = deadline - Date.now();
          if (left <= 0) {
            // Tope del lote agotado: esta llamada y las que quedan se vetan
            // (falla cerrado). Las anteriores ya pasaron todos sus handlers.
            for (const rest of requests.slice(index)) {
              if (!vetoes.has(rest.callId)) {
                vetoes.set(rest.callId, {
                  pluginId: null,
                  reason:
                    `Blocked: the plugin checks for this batch of calls ran out of time ` +
                    `(${this.limits.batchTimeoutMs} ms), so this call was not executed. Retry it on its own.`,
                });
              }
            }
            return vetoes;
          }
          const input = deepFreeze(cloneForPlugin(req.input) ?? {});
          const outcome = await bounded(
            (handlerSignal) => {
              const info: ToolCallInfo = Object.freeze({
                tool: req.tool,
                input,
                callId: req.callId,
                ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
                agent: Object.freeze({ ...req.agent }),
                signal: handlerSignal,
              });
              return reg.handler(info);
            },
            Math.min(this.limits.hookTimeoutMs, left),
            signal,
          );
          if (outcome.kind === 'aborted') return vetoes;
          const veto = this.vetoFrom(reg.pluginId, outcome);
          if (veto) {
            vetoes.set(req.callId, veto);
            break; // vetada: los demás plugins no la ven
          }
        }
      }
      return vetoes;
    });
  }

  private vetoFrom(pluginId: string, outcome: Outcome<unknown>): PluginVeto | null {
    if (outcome.kind === 'timeout') {
      log.warn('plugin tool.before timed out', { id: pluginId });
      return {
        pluginId,
        reason:
          `Blocked: plugin "${pluginId}" did not answer within its time limit, so this call ` +
          'was not executed. The user can disable the plugin (--no-plugins).',
      };
    }
    if (outcome.kind === 'error') {
      log.warn('plugin tool.before threw', { id: pluginId, err: outcome.err });
      return {
        pluginId,
        reason:
          `Blocked: plugin "${pluginId}" failed while checking this call, so it was not ` +
          'executed. The user can disable the plugin (--no-plugins).',
      };
    }
    if (outcome.kind !== 'ok') return null;
    const value = outcome.value as { block?: unknown; reason?: unknown } | null | undefined;
    if (!value || typeof value !== 'object' || value.block !== true) return null;
    const reason =
      typeof value.reason === 'string' && value.reason.trim()
        ? value.reason.trim()
        : 'no reason given';
    return { pluginId, reason: `Blocked by plugin ${pluginId}: ${clip(reason)}` };
  }

  /**
   * `tool.after`: cada handler, en orden, puede sustituir la salida que verá el
   * modelo (solo si la llamada fue bien). Devuelve la salida nueva, o
   * `undefined` si nadie la cambió. Falla abierto.
   */
  async afterTool(
    info: Omit<ToolAfterInfo, 'signal'>,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const handlers = this.hooks['tool.after'].filter((r) => !r.disabled);
    if (handlers.length === 0) return undefined;
    let output = info.output;
    let changed = false;
    const input = deepFreeze(cloneForPlugin(info.input) ?? {});
    for (const reg of handlers) {
      const outcome = await bounded(
        (handlerSignal) =>
          reg.handler(
            Object.freeze({
              ...info,
              input,
              agent: Object.freeze({ ...info.agent }),
              ...(output !== undefined ? { output } : {}),
              signal: handlerSignal,
            }),
          ),
        this.limits.hookTimeoutMs,
        signal,
      );
      // Turno cancelado: ni una anotación a medias.
      if (outcome.kind === 'aborted') return undefined;
      if (outcome.kind !== 'ok') {
        this.recordFailure('tool.after', reg, outcome);
        continue;
      }
      reg.failures = 0;
      const value = outcome.value as { output?: unknown } | null | undefined;
      if (info.ok && value && typeof value === 'object' && typeof value.output === 'string') {
        output = value.output;
        changed = true;
      }
    }
    return changed ? output : undefined;
  }

  /** Cada `AgentEvent`, clonado. No se espera: el stream no se retrasa. */
  notifyEvent(event: AgentEvent): void {
    if (!this.hasHook('event')) return;
    const copy = cloneForPlugin(event);
    if (copy === undefined) return;
    for (const reg of this.hooks.event) this.enqueue('event', reg, () => reg.handler(copy));
  }

  /** `session.start` una sola vez por host. */
  startSession(info: SessionStartInfo): void {
    if (this.sessionInfo || this.disposed) return;
    this.sessionInfo = info;
    const copy = Object.freeze({ ...info });
    for (const reg of this.hooks['session.start'])
      this.enqueue('session.start', reg, () => reg.handler(copy));
  }

  private enqueue<K extends PluginHookName>(
    hook: K,
    reg: Registration<K>,
    call: () => unknown,
  ): void {
    if (reg.disabled) return;
    // Un handler lento no acumula trabajo sin tope: con la cola llena, lo que
    // llega se descarta (es una notificación; fallar abierto).
    if (reg.pending >= MAX_QUEUED_NOTIFICATIONS) {
      if (!reg.dropping) log.warn('plugin hook queue full, dropping', { id: reg.pluginId, hook });
      reg.dropping = true;
      return;
    }
    reg.pending++;
    reg.queue = reg.queue.then(async () => {
      try {
        if (reg.disabled) return;
        const outcome = await bounded(() => call(), this.limits.hookTimeoutMs);
        if (outcome.kind === 'ok') reg.failures = 0;
        else this.recordFailure(hook, reg, outcome);
      } finally {
        reg.pending--;
        if (reg.pending === 0) reg.dropping = false;
      }
    });
  }

  private recordFailure<K extends PluginHookName>(
    hook: K,
    reg: Registration<K>,
    outcome: Outcome<unknown>,
  ): void {
    reg.failures++;
    const why =
      outcome.kind === 'timeout'
        ? 'timed out'
        : outcome.kind === 'error'
          ? errorText(outcome.err)
          : outcome.kind;
    log.warn('plugin hook failed', { id: reg.pluginId, hook, failures: reg.failures, why });
    if (reg.failures >= NOTIFY_FAILURE_LIMIT && !reg.disabled) {
      reg.disabled = true;
      const reason = `${reg.failures} fallos seguidos (último: ${why})`;
      this.disabledHooks.push({ id: reg.pluginId, hook, reason });
      log.warn(`plugin_hook_disabled:${reg.pluginId}`, { hook, reason });
    }
  }

  /**
   * Fin de la sesión: `session.end` (con plazo) y se retira todo. Idempotente.
   * Un plugin que no coopera no puede retener el cierre más allá del plazo.
   */
  async dispose(reason = 'closed'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const info: SessionEndInfo = Object.freeze({
      ...(this.sessionInfo?.sessionId !== undefined
        ? { sessionId: this.sessionInfo.sessionId }
        : {}),
      reason,
    });
    // Lo que quede en cola (eventos, `session.start`) se entrega antes que
    // `session.end`, y nada de ello retiene el cierre más que un plazo.
    const queued = [...this.hooks.event, ...this.hooks['session.start']].map((r) => r.queue);
    const ends = this.hooks['session.end']
      .filter((r) => !r.disabled)
      .map((reg) =>
        reg.queue.then(() => bounded(() => reg.handler(info), this.limits.hookTimeoutMs)),
      );
    await bounded(() => Promise.all([...queued, ...ends]), this.limits.hookTimeoutMs * 2);
    for (const id of this.loaded.map((p) => p.id)) this.revoke(id);
  }

  report(): PluginReport {
    return {
      enabled: this.enabled,
      loaded: this.loaded.map((p) => ({ ...p, hooks: { ...p.hooks } })),
      skipped: [...this.skipped],
      disabledHooks: [...this.disabledHooks],
    };
  }
}
