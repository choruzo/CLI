/**
 * `ContextBuilder` (M11): la única pieza que decide **qué** recibe el modelo en
 * cada llamada de una sesión con memoria de sesión, y con qué presupuesto.
 *
 *   system prompt  (instrucciones + <env> + memoria global + memoria de proyecto)
 * + memoria de sesión                         ← bloque <session_memory> del system
 * + conversación reciente                     ← historial activo del agente
 * + mensaje actual
 *
 * La conversación completa **no** es el contexto: vive en el
 * `ConversationStore`. El historial activo del agente es solo lo reciente, y
 * lo antiguo se compacta a la memoria de sesión (`ContextManager`).
 *
 * Presupuesto en tokens, a partir de la ventana **real** del modelo
 * (`router.contextWindow`), no de números fijos:
 *
 *   ventana − reserva de salida = presupuesto de entrada
 *
 * y de él, topes por capa (configurables en `context.*`). Las cifras de tokens
 * de este módulo son **estimaciones** (chars/3.5, calibradas con el último
 * `usage` cuando lo hay) y se publican marcadas como tales.
 */
import type { StratumConfig } from '../config/schema.js';
import type { Message } from './types.js';

/** Caracteres por token del proxy sin calibrar (el mismo que `ContextManager`). */
export const CHARS_PER_TOKEN = 3.5;

export interface ContextBudget {
  /** Ventana usada: la del modelo, con el tope de `context.maxTokens`. */
  window: number;
  reserveOutput: number;
  /** `window − reserveOutput`. */
  usableInput: number;
  recent: number;
  sessionMemory: number;
  projectMemory: number;
  globalMemory: number;
  /** Fracción de `usableInput` a partir de la que se compacta. */
  compactAt: number;
  /** Fracción de `usableInput` que se busca tras compactar. */
  target: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Presupuesto de la sesión para el modelo activo. Por defecto: reserva de
 * salida = 15 % de la ventana (1 024–8 192); memoria de sesión = 10 % de la
 * entrada (≤ 12 000), de proyecto = 8 % (≤ 8 000), global = 4 % (≤ 4 000); lo
 * reciente, el resto.
 */
export function resolveContextBudget(config: StratumConfig, contextWindow: number): ContextBudget {
  const ctx = config.context;
  const model = Math.max(1, Math.floor(contextWindow));
  const window = ctx.maxTokens === 'auto' ? model : Math.min(model, ctx.maxTokens);
  const reserveOutput = Math.min(
    Math.floor(window / 2),
    ctx.reserveOutput ?? clamp(window * 0.15, 1_024, 8_192),
  );
  const usableInput = Math.max(1, window - reserveOutput);
  const sessionMemory = ctx.sessionMemory.maxTokens ?? clamp(usableInput * 0.1, 128, 12_000);
  const projectMemory = ctx.projectMemory.maxTokens ?? clamp(usableInput * 0.08, 128, 8_000);
  const globalMemory = ctx.globalMemory.maxTokens ?? clamp(usableInput * 0.04, 64, 4_000);
  const recent =
    ctx.recent.maxTokens ?? Math.max(1, usableInput - sessionMemory - projectMemory - globalMemory);
  const { compactAt, targetContext } = config.memory.session;
  return {
    window,
    reserveOutput,
    usableInput,
    recent,
    sessionMemory,
    projectMemory,
    globalMemory,
    compactAt,
    target: Math.min(targetContext, compactAt - 0.05),
  };
}

export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

export function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Recorta una capa de memoria a su presupuesto, diciéndolo. */
export function clipMemoryLayer(text: string, maxTokens: number, label: string): string {
  const max = tokensToChars(maxTokens);
  if (text.length <= max) return text;
  const note = `\n\n[${label} truncated to fit its context budget (${maxTokens} tokens)]`;
  let end = Math.max(0, max - note.length);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}${note}`;
}

export const SESSION_MEMORY_START = '<session_memory>';
export const SESSION_MEMORY_END = '</session_memory>';

/**
 * Pone (o quita, con `block` vacío) la memoria de sesión en el system prompt,
 * entre marcadores, igual que la lista de tareas: idempotente, no acumula y no
 * crea mensajes. Devuelve si cambió algo.
 */
export function applySessionMemoryBlock(messages: Message[], block: string): boolean {
  const system = messages[0];
  if (!system || system.role !== 'system' || typeof system.content !== 'string') return false;
  const section = block ? `${SESSION_MEMORY_START}\n${block}\n${SESSION_MEMORY_END}` : '';
  const start = system.content.indexOf(SESSION_MEMORY_START);
  const end = system.content.indexOf(SESSION_MEMORY_END);
  let next: string;
  if (start !== -1 && end !== -1 && end > start) {
    const before = system.content.slice(0, start).replace(/\n+$/, '');
    const after = system.content.slice(end + SESSION_MEMORY_END.length).replace(/^\n+/, '');
    next = [before, section, after].filter((p) => p.length > 0).join('\n\n');
  } else {
    if (!section) return false;
    next = `${system.content}\n\n${section}`;
  }
  if (next === system.content) return false;
  messages[0] = { ...system, content: next };
  return true;
}

/** Caracteres del bloque de memoria de sesión que hay ahora en el system prompt. */
export function sessionMemoryChars(messages: Message[]): number {
  const content = messages[0]?.role === 'system' ? (messages[0].content ?? '') : '';
  const start = content.indexOf(SESSION_MEMORY_START);
  const end = content.indexOf(SESSION_MEMORY_END);
  return start !== -1 && end > start ? end + SESSION_MEMORY_END.length - start : 0;
}

export function messageChars(message: Message): number {
  let chars = message.content?.length ?? 0;
  for (const call of message.tool_calls ?? []) {
    chars += call.function.name.length + call.function.arguments.length;
  }
  return chars;
}

/** Desglose del contexto que se enviaría ahora. Tokens **estimados**. */
export interface ContextBreakdown {
  window: number;
  reserveOutput: number;
  usableInput: number;
  /** Entrada completa: system + tools + memorias + reciente. */
  input: number;
  /** System prompt sin las capas de memoria. */
  system: number;
  /** Definiciones de tools. */
  tools: number;
  globalMemory: number;
  projectMemory: number;
  sessionMemory: number;
  recent: number;
  /** Mensajes de la conversación en el contexto (sin el system). */
  activeMessages: number;
  estimated: true;
}

export function contextBreakdown(
  messages: Message[],
  parts: {
    budget: ContextBudget;
    globalMemoryChars: number;
    projectMemoryChars: number;
    toolsChars: number;
    /**
     * Tokens reales por token del proxy chars/3.5, calibrado sobre la entrada
     * entera (mensajes + tools; `StratumAgent.getContextReport`), o 1.
     */
    ratio: number;
  },
): ContextBreakdown {
  const t = (chars: number): number => Math.ceil(charsToTokens(chars) * parts.ratio);
  const systemChars = messages[0]?.role === 'system' ? messageChars(messages[0]) : 0;
  const sessionChars = sessionMemoryChars(messages);
  const ownSystem = Math.max(
    0,
    systemChars - sessionChars - parts.globalMemoryChars - parts.projectMemoryChars,
  );
  let recentChars = 0;
  let active = 0;
  for (const m of messages) {
    if (m.role === 'system') continue;
    recentChars += messageChars(m);
    active++;
  }
  const out = {
    window: parts.budget.window,
    reserveOutput: parts.budget.reserveOutput,
    usableInput: parts.budget.usableInput,
    system: t(ownSystem),
    tools: t(parts.toolsChars),
    globalMemory: t(parts.globalMemoryChars),
    projectMemory: t(parts.projectMemoryChars),
    sessionMemory: t(sessionChars),
    recent: t(recentChars),
    activeMessages: active,
    estimated: true as const,
  };
  return {
    ...out,
    input:
      out.system +
      out.tools +
      out.globalMemory +
      out.projectMemory +
      out.sessionMemory +
      out.recent,
  };
}
