import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { AgentEvent } from '../../agent/types.js';
import type { SubagentBlockState } from './SubagentBlock.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { MarkdownText } from './MarkdownText.js';
import { applyToolEvent } from './tool-call-reducer.js';

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
  /** Cada AgentEvent del loop hijo, en orden (desanidado de subagent_event). */
  events: AgentEvent[];
}

function fmtDur(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_LABEL: Record<SubagentBlockState['status'], string> = {
  queued: 'en cola',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
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

interface Props {
  transcript: SubagentTranscript;
  expandedBlockIds?: ReadonlySet<string>;
  focusedBlockId?: string | null;
}

/**
 * Vista de Subagente read-only (§5.7). Sustituye a `<MessageList>` mientras está
 * activa: cabecera con metadatos, la task inyectada como mensaje de usuario, y la
 * salida del hijo (tool calls + markdown) con el mismo pipeline de la conversación
 * principal. La restricción de input (solo `/quit`) la gobierna `<App>`.
 */
export function SubagentView({ transcript, expandedBlockIds, focusedBlockId }: Props) {
  const { text, toolCalls } = reduceTranscript(transcript.events);
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
        <Text>
          <Text color={theme.accent} bold>
            👁 Subagente · {transcript.profile}#{transcript.n}
          </Text>
          <Text color={STATUS_COLOR[transcript.status]}> · {STATUS_LABEL[transcript.status]}</Text>
          {metaParts.length > 0 && <Text color={theme.textMuted}> · {metaParts.join(' · ')}</Text>}
        </Text>
      </Box>

      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {/* Task inyectada al hijo (equivalente al UserMessage de la conversación). */}
        <Text color={theme.textMuted}>
          <Text color={theme.accent}>❯❯ </Text>
          <Text color={theme.textFaint}>[task] </Text>
          {transcript.task}
        </Text>

        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.accent} bold>
            Stratum ({transcript.profile}#{transcript.n})
          </Text>
          {toolCalls.map((tc) => (
            <ToolCallBlock
              key={tc.id}
              state={tc}
              focused={focusedBlockId === tc.id}
              expanded={expandedBlockIds?.has(tc.id) ?? false}
            />
          ))}
          {text ? (
            <MarkdownText text={text} />
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
          Solo lectura · <Text color={theme.textMuted}>/quit</Text> (o Esc) para volver al agente
          principal
        </Text>
      </Box>
    </Box>
  );
}
