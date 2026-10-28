/**
 * Indicador de trabajo del chat: el símbolo de Stratum (tres capas) que se
 * deposita capa a capa, como el `strata-loader` de Stratum Desktop, más una
 * frase de estratos con un brillo que la recorre. Lógica pura: los frames
 * dependen solo del reloj, para probarlos sin Ink.
 */
import type { ThinkingPhase } from './thinking-phrases.js';

/**
 * Cada capa es una línea de puntos braille a lo ancho de dos celdas: el
 * símbolo cabe en una sola fila y no le quita alto a la región viva.
 * Bits de una celda braille por fila de puntos (0 arriba, 3 abajo).
 */
const ROW_BITS = [0x09, 0x12, 0x24, 0xc0] as const;

function cell(rows: readonly number[]): string {
  let bits = 0;
  for (const r of rows) bits |= ROW_BITS[r]!;
  return String.fromCharCode(0x2800 + bits);
}

/**
 * Filas ocupadas en cada frame: cae una capa desde arriba y se posa sobre la
 * anterior (abajo la primera), las tres aguantan un momento y se vacía.
 */
const SEQUENCE: readonly (readonly number[])[] = [
  [],
  [0],
  [1],
  [2],
  [3],
  [3, 0],
  [3, 1],
  [3, 2],
  [3, 2, 0],
  [3, 2, 1],
  [3, 2, 1],
  [3, 2, 1],
  [3, 2, 1],
  [3, 2],
  [3],
];

export const STRATA_FRAMES: readonly string[] = SEQUENCE.map((rows) => cell(rows).repeat(2));

/** Cadencia por fase: con una tool en marcha el depósito va más deprisa. */
export function strataIntervalMs(phase: ThinkingPhase): number {
  return phase === 'tool' ? 70 : 120;
}

export function strataFrameAt(now: number, phase: ThinkingPhase): string {
  const step = Math.floor(now / strataIntervalMs(phase));
  return STRATA_FRAMES[step % STRATA_FRAMES.length]!;
}

/** Ancho del brillo que recorre la frase, en caracteres. */
const SHIMMER_WIDTH = 3;
/** Avance del brillo: un carácter cada tanto. */
const SHIMMER_STEP_MS = 90;

/**
 * La frase partida en tres tramos `[antes, brillo, después]`. El brillo da la
 * vuelta con una pausa fuera del texto, como el `shimmer` del Desktop.
 */
export function shimmerParts(text: string, now: number): [string, string, string] {
  const chars = [...text];
  const span = chars.length + SHIMMER_WIDTH * 4;
  const head = (Math.floor(now / SHIMMER_STEP_MS) % span) - SHIMMER_WIDTH;
  const from = Math.max(0, head);
  const to = Math.max(0, Math.min(chars.length, head + SHIMMER_WIDTH));
  if (to <= from) return [text, '', ''];
  return [chars.slice(0, from).join(''), chars.slice(from, to).join(''), chars.slice(to).join('')];
}

/** Lo mínimo del turno vivo que decide la fase y la acción en curso. */
export interface LiveTurnShape {
  toolCalls?: ReadonlyArray<{ status: string; name?: string; startedAt?: number }>;
  subagents?: ReadonlyArray<{
    status: string;
    profile?: string;
    n?: number;
    task?: string;
    startedAt?: number;
  }>;
  thinkingOpen?: boolean;
}

/** Icono de una tool según lo que hace: leer, buscar, escribir, ejecutar… */
export function toolIcon(name: string): string {
  if (/^web_|fetch/.test(name)) return '◍';
  if (/^(read_file|list_directory|read_skill|ssh_download)$/.test(name)) return '▤';
  if (/^(grep|glob|search|find|recall_)/.test(name) || /_search$/.test(name)) return '⌕';
  if (/^(write_file|edit_file|apply_patch|ssh_upload)$|write|edit/.test(name)) return '✎';
  if (/^(exec|ssh_exec|bash|shell)$/.test(name)) return '❯';
  if (name === 'delegate_task') return '⊳';
  if (name.startsWith('mcp_') || name.includes('__')) return '⬡';
  return '◆';
}

/**
 * La acción en curso del turno para la fila de encima del indicador: la tool
 * (o el subagente) que más tiempo lleva corriendo y cuántas más corren a la vez.
 */
export interface LiveAction {
  icon: string;
  name: string;
  /** Índice en `toolCalls`, para sacar el argumento; ausente en un subagente. */
  toolIndex?: number;
  detail?: string;
  startedAt?: number;
  others: number;
}

export function liveAction(item: LiveTurnShape | null | undefined): LiveAction | null {
  if (!item) return null;
  const tools = (item.toolCalls ?? [])
    .map((tc, i) => ({ tc, i }))
    .filter(({ tc }) => tc.status === 'running');
  const subs = (item.subagents ?? []).filter((s) => s.status === 'running');
  const others = tools.length + subs.length - 1;
  const first = tools[0];
  if (first) {
    return {
      icon: toolIcon(first.tc.name ?? ''),
      name: first.tc.name ?? '',
      toolIndex: first.i,
      startedAt: first.tc.startedAt,
      others,
    };
  }
  const sub = subs[0];
  if (sub) {
    return {
      icon: '⊳',
      name: `${sub.profile ?? 'subagente'}#${sub.n ?? 1}`,
      detail: sub.task?.replace(/\s+/g, ' '),
      startedAt: sub.startedAt,
      others,
    };
  }
  return null;
}

/** En qué está el turno según lo último que llegó. */
export function liveThinkingPhase(item: LiveTurnShape | null | undefined): ThinkingPhase {
  if (!item) return 'waiting';
  const running = (s: { status: string }) => s.status === 'running';
  if (item.toolCalls?.some(running) || item.subagents?.some(running)) return 'tool';
  if (item.thinkingOpen) return 'reasoning';
  return 'waiting';
}
