/**
 * Reconstrucción de la trayectoria a partir de los `TraceRecord`: pasos con
 * inicio y fin, turnos, posición en el timeline y totales. Puro y sin imports
 * de Node — lo usa el panel de Stratum Desktop desde el webview. El visor web
 * de la CLI (`viewer-page.ts`) hace lo mismo en JS plano dentro de la página:
 * un cambio de formato hay que llevarlo a los dos.
 */
import { withCacheDerived, type CacheUsage } from '../providers/cache.js';
import type { TraceData, TraceKind, TraceRecord, TraceStatus } from './records.js';

export interface TraceStep {
  id: string;
  kind: TraceKind;
  name: string;
  parent: string | null;
  start: number;
  /** null mientras el paso sigue abierto. */
  end: number | null;
  status: TraceStatus | null;
  /** Primer token de una llamada al modelo. */
  firstToken: number | null;
  data: TraceData;
  /** Índice del turno al que pertenece. */
  turn: number;
  /** Número de paso (1-based), por orden de aparición. */
  n: number;
}

export interface TraceTurn {
  at: number;
  end: number | null;
  stop: string | null;
  /** Abierto por un paso que llegó antes del primer `turn` (el prompt del sistema). */
  implicit: boolean;
}

export interface TraceModel {
  steps: TraceStep[];
  index: Record<string, number>;
  turns: TraceTurn[];
}

export type TimelineMode = 'duration' | 'turns' | 'calls';

/** Carril del timeline: 0 entrada, 1 modelo, 2 herramientas. */
export const LANE: Record<TraceKind, 0 | 1 | 2> = {
  system: 0,
  user: 0,
  context: 0,
  notice: 0,
  model: 1,
  tool: 2,
  subagent: 2,
};

export const LANE_NAMES = ['Entrada', 'Modelo', 'Herramientas'] as const;

export const KIND_LABEL: Record<TraceKind, string> = {
  system: 'SISTEMA',
  user: 'USUARIO',
  context: 'CONTEXTO',
  notice: 'AVISO',
  model: 'MODELO',
  tool: 'HERRAMIENTA',
  subagent: 'SUBAGENTE',
};

const KINDS = new Set<string>(Object.keys(LANE));

export function emptyTrace(): TraceModel {
  return { steps: [], index: {}, turns: [] };
}

/**
 * Aplica una tanda de registros. No muta `model`: devuelve otro, con los pasos
 * tocados copiados (los demás se comparten), para que React pueda comparar.
 */
export function applyRecords(model: TraceModel, records: readonly TraceRecord[]): TraceModel {
  if (records.length === 0) return model;
  const steps = model.steps.slice();
  const index = { ...model.index };
  const turns = model.turns.slice();

  const add = (
    r: { id: string; at: number; kind: TraceKind; name: string; parent?: string; data?: TraceData },
    closed: boolean,
    status?: TraceStatus,
  ): void => {
    if (index[r.id] !== undefined) return;
    const parent = r.parent !== undefined ? steps[index[r.parent]] : undefined;
    if (!parent && turns.length === 0) {
      turns.push({ at: r.at, end: null, stop: null, implicit: true });
    }
    index[r.id] = steps.length;
    steps.push({
      id: r.id,
      kind: KINDS.has(r.kind) ? r.kind : 'notice',
      name: r.name,
      parent: r.parent ?? null,
      start: r.at,
      end: closed ? r.at : null,
      status: closed ? (status ?? 'ok') : null,
      firstToken: null,
      data: r.data ?? {},
      turn: parent ? parent.turn : turns.length - 1,
      n: steps.length + 1,
    });
  };

  for (const r of records) {
    switch (r.t) {
      case 'turn': {
        const first = turns[0];
        if (turns.length === 1 && first.implicit) turns[0] = { ...first, implicit: false };
        else turns.push({ at: r.at, end: null, stop: null, implicit: false });
        add(
          {
            id: `turn-${turns.length}`,
            at: r.at,
            kind: 'user',
            name: r.input,
            data: { content: r.input },
          },
          true,
        );
        break;
      }
      case 'turn_end': {
        const last = turns.length - 1;
        if (last >= 0) turns[last] = { ...turns[last], end: r.at, stop: r.stopReason };
        break;
      }
      case 'begin':
        add(r, false);
        break;
      case 'point':
        add(r, true, r.status);
        break;
      case 'mark': {
        const i = index[r.id];
        if (i !== undefined && r.name === 'first_token')
          steps[i] = { ...steps[i], firstToken: r.at };
        break;
      }
      case 'end': {
        const i = index[r.id];
        if (i === undefined) break;
        steps[i] = {
          ...steps[i],
          end: r.at,
          status: r.status,
          data: r.data ? { ...steps[i].data, ...r.data } : steps[i].data,
        };
        break;
      }
      default:
        break; // `meta` y tipos de un formato más nuevo
    }
  }
  return { steps, index, turns };
}

// ---------------------------------------------------------------------------
// Texto de un paso
// ---------------------------------------------------------------------------

export function firstLine(value: unknown, max: number): string {
  const s = String(value ?? '').replace(/^\s+/, '');
  const nl = s.indexOf('\n');
  const line = nl >= 0 ? s.slice(0, nl) : s;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function compactJson(value: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? '';
  } catch {
    s = String(value);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

interface ToolCallData {
  name: string;
  arguments: string;
}

export function toolCallsOf(step: TraceStep): ToolCallData[] {
  const calls = step.data.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.filter(
    (c): c is ToolCallData =>
      typeof c === 'object' && c !== null && typeof (c as ToolCallData).name === 'string',
  );
}

/** Título del paso en la lista. */
export function stepLabel(s: TraceStep): string {
  const d = s.data;
  if (s.kind === 'model') {
    if (d.text) return firstLine(d.text, 200);
    if (d.reasoning) return firstLine(d.reasoning, 200);
    const calls = toolCallsOf(s);
    if (calls.length > 0) return `Llama a ${calls.map((c) => c.name).join(', ')}`;
    if (d.error) return firstLine(d.error, 200);
    return s.end === null ? 'Generando…' : '(sin salida)';
  }
  if (s.kind === 'tool') {
    return d.input !== undefined ? `${s.name} ${compactJson(d.input, 80)}` : s.name;
  }
  if (s.kind === 'subagent') return `@${s.name} ${firstLine(d.task, 160)}`;
  return firstLine(s.name, 200) || KIND_LABEL[s.kind];
}

/** Resultado en una línea (lo que va tras la flecha). */
export function stepResult(s: TraceStep): string {
  const d = s.data;
  if (s.kind === 'tool') {
    if (d.error) return `→ ${firstLine(d.error, 160)}`;
    if (d.output !== undefined) return `→ ${firstLine(d.output, 160)}`;
    return s.end === null ? '→ en curso…' : '';
  }
  if (s.kind === 'subagent' && d.summary) return `→ ${firstLine(d.summary, 160)}`;
  return '';
}

/** Contenido principal del paso, para la vista previa. */
export function stepText(s: TraceStep): string {
  const d = s.data;
  const pick = (...values: unknown[]): string => {
    for (const v of values) if (v !== undefined && v !== null && v !== '') return prettyValue(v);
    return '';
  };
  if (s.kind === 'model') return pick(d.text, d.reasoning);
  if (s.kind === 'tool') return pick(d.output, d.error);
  if (s.kind === 'subagent') return pick(d.summary, d.task);
  return pick(d.content, d.message);
}

export function stepMatches(s: TraceStep, query: string): boolean {
  if (!query) return true;
  return `${s.name} ${compactJson(s.data, 1e7)}`.toLowerCase().includes(query);
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1e6).toFixed(2)}M`;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineBlock {
  id: string;
  lane: 0 | 1 | 2;
  /** Posición y ancho, en fracción [0, 1] del ancho del timeline. */
  x: number;
  w: number;
  /** Fracción del bloque que es generación (tras el primer token). Solo `model`. */
  gen: number;
}

const endOf = (s: TraceStep, now: number): number => s.end ?? now;

function turnBounds(model: TraceModel, now: number): Array<{ start: number; end: number }> {
  const bounds = model.turns.map((t) => ({ start: t.at, end: t.end ?? t.at }));
  for (const s of model.steps) {
    const b = bounds[s.turn];
    if (!b) continue;
    b.end = Math.max(b.end, endOf(s, now));
    b.start = Math.min(b.start, s.start);
  }
  return bounds;
}

/**
 * Posición de cada paso. `calls`: todos el mismo ancho, en orden. `duration`:
 * proporcional al tiempo, sin los huecos entre turnos (la espera al usuario).
 * `turns`: cada turno ocupa lo mismo; dentro, proporcional al tiempo.
 */
export function layoutTimeline(
  model: TraceModel,
  mode: TimelineMode,
  now: number,
): TimelineBlock[] {
  const n = model.steps.length;
  const bounds = turnBounds(model, now);
  const offsets: number[] = [];
  let total = 0;
  for (const b of bounds) {
    offsets.push(total);
    total += Math.max(b.end - b.start, 1);
  }
  const at = (t: number, turn: number): number => {
    const b = bounds[turn];
    if (!b) return 0;
    const span = Math.max(b.end - b.start, 1);
    const rel = Math.min(Math.max(t - b.start, 0), span);
    return mode === 'turns' ? (turn + rel / span) / bounds.length : (offsets[turn] + rel) / total;
  };
  return model.steps.map((s, i) => {
    const end = endOf(s, now);
    const x = mode === 'calls' ? i / n : at(s.start, s.turn);
    const x1 = mode === 'calls' ? (i + 1) / n : at(end, s.turn);
    const dur = Math.max(end - s.start, 1);
    const gen = s.kind === 'model' && s.firstToken !== null ? (end - s.firstToken) / dur : 0;
    return {
      id: s.id,
      lane: LANE[s.kind],
      x,
      w: Math.max(x1 - x, 0),
      gen: Math.min(Math.max(gen, 0), 1),
    };
  });
}

// ---------------------------------------------------------------------------
// Totales
// ---------------------------------------------------------------------------

/**
 * Uso de una llamada al modelo, normalizado. Los campos de caché solo están si
 * el backend los reportó: una traza sin ellos (anterior, o de un backend que no
 * los da) los deja `undefined`, nunca en 0.
 */
export type ModelUsage = CacheUsage;

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

export function usageOf(s: TraceStep): ModelUsage | null {
  const u = s.data.usage;
  if (s.kind !== 'model' || typeof u !== 'object' || u === null) return null;
  const raw = u as Record<string, unknown>;
  const out: ModelUsage = {};
  const set = (key: keyof ModelUsage, value: number | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set('promptTokens', count(raw.promptTokens));
  set('completionTokens', count(raw.completionTokens));
  set('totalTokens', count(raw.totalTokens));
  // `cachedTokens` es el nombre que usaban las trazas anteriores.
  set('cachedReadTokens', count(raw.cachedReadTokens) ?? count(raw.cachedTokens));
  set('cacheWriteTokens', count(raw.cacheWriteTokens));
  return withCacheDerived(out);
}

// ---------------------------------------------------------------------------
// Caché de prompt
// ---------------------------------------------------------------------------

/** Tiempo hasta el primer token de una llamada; null si no llegó ninguno. */
export function ttftOf(s: TraceStep): number | null {
  return s.kind === 'model' && s.firstToken !== null ? Math.max(s.firstToken - s.start, 0) : null;
}

/**
 * `cold`: el backend no reutilizó nada del prompt. `warm`: reutilizó algo.
 * null: no lo reportó — no se deduce de la posición de la llamada.
 */
export type CacheTemperature = 'cold' | 'warm';

export function cacheTemperature(s: TraceStep): CacheTemperature | null {
  const read = usageOf(s)?.cachedReadTokens;
  if (read === undefined) return null;
  return read > 0 ? 'warm' : 'cold';
}

/**
 * Cuánto del prompt de una llamada repite el de la anterior del mismo agente,
 * medido en el cliente (caracteres, en el orden tools, system, conversación).
 * Es lo que una caché de prefijo podría reutilizar; lo que reutilizó de verdad
 * es `usageOf(s).cachedReadTokens`.
 */
export interface PromptPrefix {
  chars: number;
  /** Ausente en la primera llamada de un agente en este proceso: no hay con qué comparar. */
  sharedChars?: number;
  /** Huella de los schemas de tools y del prompt del sistema. */
  tools?: string;
  system?: string;
  /** Dónde deja de coincidir con la llamada anterior; ausente si solo se añadió al final. */
  diverged?: 'tools' | 'system' | 'history';
  divergedAt?: number;
  prevMessages?: number;
}

export function prefixOf(s: TraceStep): PromptPrefix | null {
  const p = s.data.prefix;
  if (s.kind !== 'model' || typeof p !== 'object' || p === null) return null;
  const raw = p as Record<string, unknown>;
  const chars = count(raw.chars);
  if (chars === undefined) return null;
  const out: PromptPrefix = { chars };
  const shared = count(raw.sharedChars);
  if (shared !== undefined) out.sharedChars = shared;
  if (typeof raw.tools === 'string') out.tools = raw.tools;
  if (typeof raw.system === 'string') out.system = raw.system;
  const d = raw.diverged;
  if (d === 'tools' || d === 'system' || d === 'history') out.diverged = d;
  const at = count(raw.divergedAt);
  if (at !== undefined) out.divergedAt = at;
  const prev = count(raw.prevMessages);
  if (prev !== undefined) out.prevMessages = prev;
  return out;
}

/**
 * Por qué una llamada reutilizó menos que la anterior:
 *  - `tools` / `system` / `history`: Stratum cambió esa parte del prompt;
 *  - `compression`: el cambio en el historial fue una compresión de contexto;
 *  - `model`: otra combinación de provider y modelo, que es otra caché;
 *  - `backend`: el prompt solo creció por el final y aun así el backend
 *    reutilizó menos (caducó, u otra petición ocupó la caché);
 *  - `unknown`: traza anterior a `prefix`, no hay con qué atribuirlo.
 */
export type CacheBreakCause =
  | 'tools'
  | 'system'
  | 'history'
  | 'compression'
  | 'model'
  | 'backend'
  | 'unknown';

export const CACHE_BREAK_LABEL: Record<CacheBreakCause, string> = {
  tools: 'cambió la lista de tools',
  system: 'cambió el prompt del sistema',
  history: 'se reescribió el historial',
  compression: 'compresión de contexto',
  model: 'cambio de provider o modelo',
  backend: 'el backend perdió la caché',
  unknown: 'causa no registrada',
};

export interface CacheBreak {
  /** Paso de la llamada que reutilizó menos. */
  id: string;
  n: number;
  turn: number;
  cause: CacheBreakCause;
  cachedBefore: number;
  cachedAfter: number;
}

export const COMPRESSION_STEP = 'Contexto comprimido';

/**
 * Roturas de caché. En una conversación que solo crece, cada llamada debería
 * reutilizar al menos el prompt entero de la anterior. Es una rotura cuando:
 *  - el backend reutilizó MENOS tokens que en la llamada anterior del mismo
 *    agente (lo que ya estaba en caché dejó de servir), o
 *  - Stratum reescribió parte del prompt anterior (`prefix.diverged`) y el
 *    backend, en efecto, no llegó a reutilizarlo entero.
 * Solo con datos del backend (una llamada que no reporta caché ni rompe ni deja
 * de romper) y sin contar la primera llamada de un proceso: reanudar una sesión
 * horas después no es una rotura, es otra caché.
 */
export function cacheBreaks(model: TraceModel): CacheBreak[] {
  const out: CacheBreak[] = [];
  const last = new Map<string, { step: TraceStep; read: number; prompt: number | undefined }>();
  const compressed = new Set<string>();
  for (const s of model.steps) {
    const scope = s.parent ?? '';
    if (s.kind === 'context' && s.name === COMPRESSION_STEP) compressed.add(scope);
    if (s.kind !== 'model') continue;
    const usage = usageOf(s);
    const read = usage?.cachedReadTokens;
    if (read === undefined) continue;
    const prev = last.get(scope);
    const prefix = prefixOf(s);
    const wasCompressed = compressed.delete(scope);
    last.set(scope, { step: s, read, prompt: usage?.promptTokens });
    if (!prev) continue;
    // Con `prefix` pero sin `sharedChars`: primera llamada de otro proceso.
    if (prefix && prefix.sharedChars === undefined) continue;
    const shrank = read < prev.read;
    const rewritten =
      prefix?.diverged !== undefined && prev.prompt !== undefined && read < prev.prompt;
    if (!shrank && !rewritten) continue;
    let cause: CacheBreakCause;
    if (prev.step.name !== s.name || prev.step.data.provider !== s.data.provider) cause = 'model';
    else if (!prefix) cause = wasCompressed ? 'compression' : 'unknown';
    else if (prefix.diverged === 'tools') cause = 'tools';
    else if (prefix.diverged === 'system') cause = 'system';
    else if (prefix.diverged === 'history') cause = wasCompressed ? 'compression' : 'history';
    else cause = 'backend';
    out.push({ id: s.id, n: s.n, turn: s.turn, cause, cachedBefore: prev.read, cachedAfter: read });
  }
  return out;
}

export interface CacheSummary {
  /** Llamadas que reportaron caché (las demás no entran en ninguna cifra). */
  reportedCalls: number;
  /** Tokens de entrada de esas llamadas. */
  promptTokens: number;
  cachedReadTokens: number;
  /** null si ninguna llamada reportó escrituras (solo Anthropic las da). */
  cacheWriteTokens: number | null;
  uncachedPromptTokens: number;
  hitRate: number | null;
  coldCalls: number;
  warmCalls: number;
  /** TTFT medio de las llamadas frías / templadas; null sin ninguna con primer token. */
  ttftColdMs: number | null;
  ttftWarmMs: number | null;
  breaks: number;
}

const mean = (values: readonly number[]): number | null =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** Resumen de caché de una trayectoria; null si ninguna llamada la reportó. */
export function cacheSummary(model: TraceModel): CacheSummary | null {
  let reportedCalls = 0;
  let prompt = 0;
  let read = 0;
  let write = 0;
  let writeSeen = false;
  let cold = 0;
  let warm = 0;
  const ttftCold: number[] = [];
  const ttftWarm: number[] = [];
  for (const s of model.steps) {
    if (s.kind !== 'model') continue;
    const u = usageOf(s);
    if (u?.cachedReadTokens === undefined || u.promptTokens === undefined) continue;
    reportedCalls++;
    prompt += u.promptTokens;
    read += Math.min(u.cachedReadTokens, u.promptTokens);
    if (u.cacheWriteTokens !== undefined) {
      writeSeen = true;
      write += u.cacheWriteTokens;
    }
    const isWarm = u.cachedReadTokens > 0;
    if (isWarm) warm++;
    else cold++;
    const ttft = ttftOf(s);
    if (ttft !== null) (isWarm ? ttftWarm : ttftCold).push(ttft);
  }
  if (reportedCalls === 0) return null;
  return {
    reportedCalls,
    promptTokens: prompt,
    cachedReadTokens: read,
    cacheWriteTokens: writeSeen ? write : null,
    uncachedPromptTokens: prompt - read,
    hitRate: prompt > 0 ? read / prompt : null,
    coldCalls: cold,
    warmCalls: warm,
    ttftColdMs: mean(ttftCold),
    ttftWarmMs: mean(ttftWarm),
    breaks: cacheBreaks(model).length,
  };
}

/**
 * Fracción del prompt que repite el de la llamada anterior, sobre las llamadas
 * que tienen con qué compararse. Mide lo que hace Stratum con el prompt, con
 * cualquier backend; null en una traza que no lo registraba.
 */
export function prefixStability(model: TraceModel): number | null {
  let chars = 0;
  let shared = 0;
  for (const s of model.steps) {
    const p = prefixOf(s);
    if (p?.sharedChars === undefined) continue;
    chars += p.chars;
    shared += Math.min(p.sharedChars, p.chars);
  }
  return chars > 0 ? shared / chars : null;
}

/** TTFT medio de las llamadas al modelo; null si ninguna llegó al primer token. */
export function meanTtft(model: TraceModel): number | null {
  return mean(model.steps.flatMap((s) => ttftOf(s) ?? []));
}

/** Tokens por segundo de una llamada: salida entre el tiempo de generación. */
export function tokensPerSecond(s: TraceStep): number | null {
  const u = usageOf(s);
  if (!u?.completionTokens || s.end === null) return null;
  const ms = s.end - (s.firstToken ?? s.start);
  return ms > 0 ? u.completionTokens / (ms / 1000) : null;
}

export interface TraceStats {
  turns: number;
  steps: number;
  modelCalls: number;
  toolCalls: number;
  totalTokens: number;
  tokensPerSecond: number | null;
  /** Fracción del prompt servida de caché; null si el backend no la reporta. */
  cacheHit: number | null;
  /** Desglose de caché; null si ninguna llamada la reportó. */
  cache: CacheSummary | null;
  /** Ver `prefixStability`. */
  prefixStability: number | null;
  ttftMs: number | null;
  activeMs: number;
}

export function traceStats(model: TraceModel, now: number): TraceStats {
  let total = 0;
  let genMs = 0;
  let genTokens = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  for (const s of model.steps) {
    if (s.kind === 'tool') toolCalls++;
    if (s.kind !== 'model') continue;
    modelCalls++;
    const u = usageOf(s);
    if (!u) continue;
    total += u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    if (u.completionTokens && s.end !== null) {
      const ms = s.end - (s.firstToken ?? s.start);
      if (ms > 0) {
        genMs += ms;
        genTokens += u.completionTokens;
      }
    }
  }
  const cache = cacheSummary(model);
  return {
    turns: model.turns.filter((t) => !t.implicit).length,
    steps: model.steps.length,
    modelCalls,
    toolCalls,
    totalTokens: total,
    tokensPerSecond: genMs > 0 ? genTokens / (genMs / 1000) : null,
    cacheHit: cache?.hitRate ?? null,
    cache,
    prefixStability: prefixStability(model),
    ttftMs: meanTtft(model),
    activeMs: turnBounds(model, now).reduce((sum, b) => sum + (b.end - b.start), 0),
  };
}
