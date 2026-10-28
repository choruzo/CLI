import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';
import type { AgentEvent } from '../../agent/types.js';
import type { SubagentBlockState } from './SubagentBlock.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { MarkdownText } from './MarkdownText.js';
import { applyToolEvent } from './tool-call-reducer.js';
import { tailWindow } from './tool-arg-label.js';
import { useLiveClock } from './spinner.js';

/**
 * Transcript en memoria de un subagente de la sesión (Hito 8C, §5.7). Alimentado
 * por `subagent_started`/`subagent_event`/`subagent_completed` en el reducer de
 * `<App>`. No se persiste en disco: cubre los subagentes de la sesión viva.
 */
export interface SubagentTranscript {
  id: string;
  profile: string;
  /** Índice de admisión 1-based dentro de su grupo. */
  n: number;
  task: string;
  status: SubagentBlockState['status'];
  iterations?: number;
  tokens?: number;
  durationMs?: number;
  /** Log persistente O(1) por append; se materializa solo al abrir el inspector. */
  events: TranscriptEventLog;
}

export interface TranscriptEventNode {
  event: AgentEvent;
  previous: TranscriptEventNode | null;
}

export interface TranscriptEventLog {
  tail: TranscriptEventNode | null;
  length: number;
}

export function createTranscriptEventLog(): TranscriptEventLog {
  return { tail: null, length: 0 };
}

/** Buffer deliberadamente mutable y ajeno al ciclo de render de React. */
export function appendTranscriptEvent(log: TranscriptEventLog, event: AgentEvent): void {
  log.tail = { event, previous: log.tail };
  log.length++;
}

export function transcriptEventsInOrder(log: TranscriptEventLog): AgentEvent[] {
  const events = new Array<AgentEvent>(log.length);
  let node = log.tail;
  for (let i = log.length - 1; i >= 0 && node; i--) {
    events[i] = node.event;
    node = node.previous;
  }
  return events;
}

function fmtDur(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_LABEL: Record<SubagentBlockState['status'], string> = {
  queued: 'en cola',
  running: 'trabajando',
  completed: 'completado',
  failed: 'fallido',
  cancelled: 'cancelado',
  budget_exceeded: 'presupuesto agotado',
  interrupted: 'interrumpido',
};

const STATUS_COLOR: Record<SubagentBlockState['status'], string> = {
  queued: theme.textDisabled,
  running: theme.accent,
  completed: theme.success,
  failed: theme.error,
  cancelled: theme.textDisabled,
  budget_exceeded: theme.warning,
  interrupted: theme.warning,
};

/**
 * El subagente al que se refiere `/subagents <consulta>`: `explorer#2`, `2`
 * (el n-ésimo de la sesión) o `explorer` (el más reciente con ese perfil).
 */
export function findSubagent(
  list: readonly SubagentTranscript[],
  query: string,
): SubagentTranscript | undefined {
  const q = query.trim().toLowerCase();
  const exact = list.find((t) => `${t.profile}#${t.n}`.toLowerCase() === q);
  if (exact) return exact;
  if (/^#?\d+$/.test(q)) return list[Number(q.replace('#', '')) - 1];
  return [...list].reverse().find((t) => t.profile.toLowerCase() === q);
}

/** Reduce los eventos del transcript a texto acumulado + lista de tool calls. */
function reduceTranscript(events: AgentEvent[]): { text: string; toolCalls: ToolCallState[] } {
  let text = '';
  let toolCalls: ToolCallState[] = [];
  for (const ev of events) {
    if (ev.type === 'text_delta') {
      text += ev.delta;
    } else {
      toolCalls = applyToolEvent(toolCalls, ev);
    }
  }
  return { text, toolCalls };
}

/**
 * Filas fijas de la vista: cabecera con borde (3), tarea (2), título (2), pie
 * (2) y holgura (2). Lo demás se reparte entre acciones y texto.
 */
const VIEW_CHROME_ROWS = 11;

/**
 * Cuánto de la salida del subagente cabe: las últimas acciones (una fila cada
 * una) y la cola del texto. Pura para probarla; la vista entera tiene que caber
 * en la pantalla o Ink la repinta entera en cada fotograma.
 */
export function subagentViewWindow(
  rows: number,
  actions: number,
  textLines: number,
): { actions: number; textLines: number } {
  const free = Math.max(4, rows - VIEW_CHROME_ROWS);
  // Se reservan dos filas: «… N acciones anteriores» y el «…» del texto cortado.
  const forText = Math.min(textLines, Math.max(2, Math.floor(free / 2)));
  const forActions = Math.min(actions, Math.max(1, free - forText - 2));
  return { actions: forActions, textLines: Math.min(textLines, free - forActions - 2) };
}

interface Props {
  transcript: SubagentTranscript;
  /** Posición entre los subagentes de la sesión, para el pie (`2/3`). */
  position?: { index: number; total: number };
  expandedBlockIds?: ReadonlySet<string>;
  focusedBlockId?: string | null;
}

/**
 * Ventana de un subagente (§5.7), de **solo lectura**: no hay entrada de texto.
 * Sustituye a la conversación mientras está abierta: cabecera con metadatos, la
 * tarea que recibió y su salida (acciones + texto) en vivo, recortada a lo que
 * cabe en la pantalla. Esc vuelve y ←/→ cambia de subagente (lo gobierna `<App>`).
 */
export function SubagentView({ transcript, position, expandedBlockIds, focusedBlockId }: Props) {
  // El texto del hijo llega a un buffer mutable sin despertar a React: mientras
  // trabaja, la vista se rehace con su propio reloj.
  const now = useLiveClock(transcript.status === 'running', 300);
  const { stdout } = useStdout();
  const rows = stdout.rows ?? 24;
  const width = Math.max(20, (stdout.columns ?? 80) - 4);

  const { text, toolCalls } = reduceTranscript(transcriptEventsInOrder(transcript.events));
  const lines = text.trimEnd().split('\n');
  // Filas de texto contando las que envuelven.
  const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / width)), 0);
  const win = subagentViewWindow(rows, toolCalls.length, text ? wrapped : 0);
  const { hidden: hiddenActions, visible: actions } = tailWindow(toolCalls, win.actions);
  const tailText = text ? tailLines(lines, win.textLines, width) : '';
  const textCut = text !== '' && tailText.length < text.trimEnd().length;

  const metaParts = [
    `${transcript.iterations ?? 0} it`,
    transcript.tokens !== undefined ? `${transcript.tokens} tok` : '',
    transcript.durationMs !== undefined ? fmtDur(transcript.durationMs) : '',
  ].filter(Boolean);

  return (
    <Box flexDirection="column" width="100%">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.borderAccent}
        paddingX={1}
      >
        <Text wrap="truncate-end">
          <Text color={theme.accent} bold>
            ⊳ {transcript.profile}#{transcript.n}
          </Text>
          <Text color={STATUS_COLOR[transcript.status]}> · {STATUS_LABEL[transcript.status]}</Text>
          {metaParts.length > 0 && <Text color={theme.textMuted}> · {metaParts.join(' · ')}</Text>}
          <Text color={theme.textFaint}> · solo lectura</Text>
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <Text color={theme.textMuted} wrap="truncate-end">
          <Text color={theme.textFaint}>tarea </Text>
          {transcript.task.replace(/\s+/g, ' ')}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          {hiddenActions > 0 && (
            <Text color={theme.textDisabled}>
              … {hiddenActions} {hiddenActions === 1 ? 'acción anterior' : 'acciones anteriores'}
            </Text>
          )}
          {actions.map((tc) => (
            <ToolCallBlock
              key={tc.id}
              state={tc}
              now={now}
              focused={focusedBlockId === tc.id}
              expanded={expandedBlockIds?.has(tc.id) ?? false}
            />
          ))}
          {tailText ? (
            <>
              {textCut && <Text color={theme.textDisabled}>…</Text>}
              <MarkdownText text={tailText} />
            </>
          ) : (
            <Text color={theme.textDisabled} dimColor>
              {transcript.status === 'running'
                ? '(el subagente sigue trabajando…)'
                : '(sin salida textual)'}
            </Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1} paddingX={1}>
        <Text color={theme.textDisabled}>
          <Text color={theme.textFaint}>esc</Text> volver al agente principal
          {position && position.total > 1 && (
            <>
              {' · '}
              <Text color={theme.textFaint}>← →</Text> otro subagente ({position.index + 1}/
              {position.total})
            </>
          )}
        </Text>
      </Box>
    </Box>
  );
}

/** Las últimas líneas del texto que caben en `rows` filas de `width` columnas. */
function tailLines(lines: readonly string[], rows: number, width: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = Math.max(1, Math.ceil(lines[i]!.length / width));
    if (used + h > rows && out.length > 0) break;
    out.unshift(lines[i]!);
    used += h;
  }
  return out.join('\n');
}
