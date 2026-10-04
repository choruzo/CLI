/**
 * Reconstrucción de la trayectoria a partir de los `TraceRecord`: pasos con
 * inicio y fin, turnos, posición en el timeline y totales. Puro y sin imports
 * de Node — lo usa el panel de Stratum Desktop desde el webview. El visor web
 * de la CLI (`viewer-page.ts`) hace lo mismo en JS plano dentro de la página:
 * un cambio de formato hay que llevarlo a los dos.
 */
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

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
}

export function usageOf(s: TraceStep): ModelUsage | null {
  const u = s.data.usage;
  return s.kind === 'model' && typeof u === 'object' && u !== null ? (u as ModelUsage) : null;
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
  activeMs: number;
}

export function traceStats(model: TraceModel, now: number): TraceStats {
  let prompt = 0;
  let cached = 0;
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
    prompt += u.promptTokens ?? 0;
    cached += u.cachedTokens ?? 0;
    total += u.totalTokens ?? (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
    if (u.completionTokens && s.end !== null) {
      const ms = s.end - (s.firstToken ?? s.start);
      if (ms > 0) {
        genMs += ms;
        genTokens += u.completionTokens;
      }
    }
  }
  return {
    turns: model.turns.filter((t) => !t.implicit).length,
    steps: model.steps.length,
    modelCalls,
    toolCalls,
    totalTokens: total,
    tokensPerSecond: genMs > 0 ? genTokens / (genMs / 1000) : null,
    cacheHit: cached > 0 && prompt > 0 ? cached / prompt : null,
    activeMs: turnBounds(model, now).reduce((sum, b) => sum + (b.end - b.start), 0),
  };
}
