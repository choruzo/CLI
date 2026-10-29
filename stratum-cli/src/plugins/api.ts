/**
 * Contrato público de un plugin de Stratum (PL1). Es superficie pública, así
 * que sigue la regla de `agent/events.ts`: nada de imports de Node ni del core
 * más allá de tipos. Un plugin no importa nada del host en runtime: toda la
 * API le llega por el parámetro de `setup`.
 *
 * Diseño: `CLI-DOC/Plugins-Implementacion.md` (§3). Lo esencial:
 * - Un plugin solo puede **restringir**: vetar una llamada, nunca aprobarla.
 * - `tool.before` recibe los argumentos congelados: no los cambia.
 * - Falla cerrado donde protege (un `tool.before` que lanza o vence su plazo
 *   veta la llamada) y abierto donde observa (los demás hooks).
 */
import type { AgentEvent } from '../agent/events.js';

/** Versión de esta API. Un plugin que declare una mayor no se carga. */
export const PLUGIN_API_VERSION = 1;

/** Quién hace la llamada: el agente principal o un subagente delegado. */
export type PluginAgentRef = { kind: 'main' } | { kind: 'subagent'; profile: string; id: string };

export interface ToolCallInfo {
  tool: string;
  /** Argumentos tal como los emitió el modelo: un clon congelado. */
  input: Readonly<Record<string, unknown>>;
  callId: string;
  sessionId?: string;
  agent: PluginAgentRef;
  /** Se aborta si el turno se cancela o vence el plazo del hook. */
  signal: AbortSignal;
}

/** Devolver `{ block: true, reason }` veta la llamada; cualquier otra cosa la deja seguir. */
export type ToolBeforeResult = { block: true; reason: string } | void | undefined;

export interface ToolAfterInfo extends ToolCallInfo {
  ok: boolean;
  /** Salida (ya redactada), si `ok`. */
  output?: string;
  /** Error (ya redactado), si no `ok`. */
  error?: string;
  durationMs: number;
}

/** Solo con `ok`: sustituye lo que ve el modelo. No convierte un error en éxito. */
export type ToolAfterResult = { output: string } | void | undefined;

export interface SessionStartInfo {
  sessionId?: string;
  cwd: string;
  worktree: string;
  /** La sesión continúa una guardada (`chat --resume`). */
  resumed: boolean;
}

export interface SessionEndInfo {
  sessionId?: string;
  reason: string;
}

type Awaitable<T> = T | Promise<T>;

export interface PluginHooks {
  /** Veto, antes de las confirmaciones. Secuencial y serializado entre subagentes. */
  'tool.before': (call: ToolCallInfo) => Awaitable<ToolBeforeResult>;
  /** Anota lo que ve el modelo. Puede reentrar (lecturas en paralelo, subagentes). */
  'tool.after': (result: ToolAfterInfo) => Awaitable<ToolAfterResult>;
  /** Notificación de cada `AgentEvent` (un clon). No retrasa el turno. */
  event: (event: AgentEvent) => Awaitable<void>;
  'session.start': (info: SessionStartInfo) => Awaitable<void>;
  'session.end': (info: SessionEndInfo) => Awaitable<void>;
}

export type PluginHookName = keyof PluginHooks;

export interface PluginLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface PluginAPI {
  readonly id: string;
  /** Registra un handler; devuelve la función que lo da de baja. */
  on<K extends PluginHookName>(hook: K, handler: PluginHooks[K]): () => void;
  /** Log propio (`plugin.<id>`). Nunca `console.log`: la TUI es dueña de stdout. */
  readonly log: PluginLogger;
  readonly project: { readonly cwd: string; readonly worktree: string };
  readonly version: { readonly stratum: string; readonly api: number };
}

export interface StratumPlugin {
  /** Minúsculas, dígitos y `-`, hasta 32 caracteres. Único entre los cargados. */
  id: string;
  apiVersion: number;
  /**
   * Registra hooks. Puede ser async; el arranque la espera con plazo. No debe
   * lanzar procesos, sockets ni temporizadores: eso va en `session.start`.
   */
  setup(api: PluginAPI, options: Record<string, unknown>): void | Promise<void>;
}

/** Identidad: solo da tipos a quien escribe el plugin. */
export function definePlugin(plugin: StratumPlugin): StratumPlugin {
  return plugin;
}
