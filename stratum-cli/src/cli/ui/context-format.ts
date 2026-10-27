/**
 * Texto de `/context` con el desglose de la entrada (sistema / tools /
 * memorias / conversación). Puro. Las cifras del desglose son **estimadas**
 * (chars/3.5 calibrado con el último `usage` real, `ContextBreakdown`) y se
 * pintan con `~`; nunca se presentan como dato del provider.
 */
import type { ContextBreakdown } from '../../agent/context-builder.js';
import { formatCount } from './telemetry-format.js';

export interface ContextView {
  /** Lo que pinta la barra de estado (`StratumAgent.getContextUsage`). */
  usage: { used: number; max: number; pct: number; estimated: boolean };
  breakdown: ContextBreakdown;
  /**
   * Cuándo se reduce el contexto: en `chat`, fracción de la ventana a la que
   * comprime el `ContextManager`; con memoria de sesión (M11), fracción de la
   * entrada útil a la que compacta.
   */
  reduceAt: { kind: 'compress' | 'compact'; fraction: number };
  messages: number;
  toolCalls: number;
  /** Texto ya resuelto del gasto de sesión (nunca inventa un número). */
  spend: string;
  provider: string;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '';
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

export function formatContextReport(v: ContextView): string {
  const b = v.breakdown;
  const source = v.usage.estimated ? 'estimado (chars/3.5)' : 'reportado por el provider';
  const rows: Array<[string, number, string?]> = [
    ['sistema', b.system],
    ['tools', b.tools],
  ];
  // Una capa vacía en este preset (la global en `coding`, la de sesión sin M11)
  // no es «0 tokens de memoria»: es que no existe aquí. Se omite.
  if (b.globalMemory > 0) rows.push(['memoria global', b.globalMemory]);
  if (b.projectMemory > 0) rows.push(['memoria proyecto', b.projectMemory]);
  if (b.sessionMemory > 0) rows.push(['memoria sesión', b.sessionMemory]);
  rows.push([
    'conversación',
    b.recent,
    `${b.activeMessages} ${b.activeMessages === 1 ? 'mensaje' : 'mensajes'}`,
  ]);

  const width = Math.max(...rows.map(([label]) => label.length), 'total entrada'.length);
  const amount = (n: number) => `~${formatCount(n)}`.padStart(7);
  const line = (label: string, n: number, extra?: string) =>
    `  ${label.padEnd(width)}  ${amount(n)}  ${pct(n, b.input).padStart(4)}${extra ? `  ${extra}` : ''}`;

  const reduce =
    v.reduceAt.kind === 'compress'
      ? `comprime al ${Math.round(v.reduceAt.fraction * 100)}% de la ventana`
      : `compacta a la memoria de sesión al ${Math.round(v.reduceAt.fraction * 100)}% de la entrada útil`;

  return [
    'Uso del contexto:',
    '',
    `  contexto       ${v.usage.estimated ? '~' : ''}${v.usage.used} / ${v.usage.max} (${v.usage.pct}%) — ${reduce}`,
    `  origen         ${source}`,
    `  mensajes       ${v.messages}`,
    `  tool calls     ${v.toolCalls}`,
    `  gasto sesión   ${v.spend}`,
    `  provider       ${v.provider}`,
    '',
    'Desglose de la entrada (estimado: chars/3.5 calibrado con el último usage):',
    '',
    ...rows.map(([label, n, extra]) => line(label, n, extra)),
    `  ${'─'.repeat(width + 15)}`,
    `  ${'total entrada'.padEnd(width)}  ${amount(b.input)}  de ${formatCount(b.usableInput)} útiles (reserva de salida ${formatCount(b.reserveOutput)})`,
    '',
    'El contexto de arriba es el de la barra de estado, el que decide cuándo se',
    'comprime; el desglose reparte por capas una estimación de la entrada entera',
    '(tools incluidas), así que no tiene por qué coincidir con él.',
    'El gasto de sesión es lo consumido en total, y solo crece.',
  ].join('\n');
}
