import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

/**
 * Estado de un bloque de subagente (Hito 8A, §12.16). Render colapsable estilo
 * `ToolCallBlock`: running mientras el hijo trabaja; al terminar muestra el
 * estado final + resumen, y expande (Space) los ficheros tocados.
 */
export type SubagentBlockStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded';

export interface SubagentBlockState {
  id: string;
  profile: string;
  task: string;
  status: SubagentBlockStatus;
  summary?: string;
  filesChanged?: { path: string; action: string }[];
  iterations?: number;
  durationMs?: number;
  error?: string;
}

const SPINNER_FRAMES = ['◍', '◌', '◎', '●', '◉'];
const MAX_SUMMARY_LINES = 8;
const MAX_FILES = 12;

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

interface Props {
  state: SubagentBlockState;
  /** Bloque seleccionado con Tab (§5.1 focused). */
  focused?: boolean;
  /** Detalle expandido con Space. */
  expanded?: boolean;
}

function ExpandedDetail({ state }: { state: SubagentBlockState }) {
  const summaryLines = (state.summary ?? '').split('\n').slice(0, MAX_SUMMARY_LINES);
  const hiddenSummary = (state.summary ?? '').split('\n').length - summaryLines.length;
  const files = state.filesChanged ?? [];
  const visibleFiles = files.slice(0, MAX_FILES);
  const hiddenFiles = files.length - visibleFiles.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderSubtle}
      paddingX={1}
      marginLeft={2}
    >
      {state.summary && (
        <>
          <Text color={theme.textMuted}>resumen:</Text>
          {summaryLines.map((line, i) => (
            <Text key={i} color={theme.textFaint} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
          {hiddenSummary > 0 && (
            <Text color={theme.textDisabled} dimColor>
              [+{hiddenSummary} más líneas]
            </Text>
          )}
        </>
      )}
      {state.error && <Text color={theme.errorMuted}>error: {state.error}</Text>}
      {visibleFiles.length > 0 && (
        <>
          <Text color={theme.textMuted}>ficheros:</Text>
          {visibleFiles.map((f, i) => (
            <Text key={i} color={theme.textFaint} wrap="truncate-end">
              {' '}
              · {f.action} {f.path}
            </Text>
          ))}
          {hiddenFiles > 0 && (
            <Text color={theme.textDisabled} dimColor>
              [+{hiddenFiles} más ficheros]
            </Text>
          )}
        </>
      )}
    </Box>
  );
}

export function SubagentBlock({ state, focused = false, expanded = false }: Props) {
  const [frame, setFrame] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (state.status !== 'running') return;
    const spinIv = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 150);
    const timerIv = setInterval(() => setElapsedMs((e) => e + 100), 100);
    return () => {
      clearInterval(spinIv);
      clearInterval(timerIv);
    };
  }, [state.status]);

  const focusPrefix = focused ? <Text color={theme.accent}>▶ </Text> : null;
  const label = (
    <Text color={theme.accent} bold>
      ⊳ subagent
    </Text>
  );
  const profileTag = <Text color={theme.textFaint}> ({state.profile})</Text>;

  if (state.status === 'running') {
    return (
      <Box marginBottom={0}>
        {focusPrefix}
        <Text color={theme.accent}>{SPINNER_FRAMES[frame]} </Text>
        {label}
        {profileTag}
        <Text color={theme.textFaint}> │ {formatDuration(elapsedMs)} │ </Text>
        <Text color={theme.textFaint} dimColor>
          {truncate(state.task, 50)}
        </Text>
      </Box>
    );
  }

  const expandable = !!state.summary || !!state.error || (state.filesChanged?.length ?? 0) > 0;
  const chevron = expandable ? (
    <Text color={theme.textFaint}> {expanded ? '▾' : '▸'}</Text>
  ) : null;
  const dur = state.durationMs !== undefined ? formatDuration(state.durationMs) : '';
  const iters = state.iterations !== undefined ? `${state.iterations} it` : '';
  const meta = [dur, iters].filter(Boolean).join(' · ');

  if (state.status === 'completed') {
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Box>
          {focusPrefix}
          <Text color={theme.success}>✓ </Text>
          {label}
          {profileTag}
          {meta && <Text color={theme.textFaint}> │ {meta}</Text>}
          {state.summary && (
            <Text color={theme.textFaint}> │ {truncate(state.summary, 50)}</Text>
          )}
          {chevron}
        </Box>
        {expanded && <ExpandedDetail state={state} />}
      </Box>
    );
  }

  // failed | cancelled | budget_exceeded
  const icon = state.status === 'cancelled' ? '⊘' : state.status === 'budget_exceeded' ? '⏱' : '✗';
  const statusLabel =
    state.status === 'cancelled'
      ? 'cancelado'
      : state.status === 'budget_exceeded'
        ? 'presupuesto agotado'
        : 'fallido';

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        {focusPrefix}
        <Text color={theme.error}>{icon} </Text>
        <Text color={theme.errorMuted} bold>
          ⊳ subagent
        </Text>
        {profileTag}
        <Text color={theme.errorMuted} dimColor>
          {' '}
          │ {statusLabel}
          {meta ? ` · ${meta}` : ''}
        </Text>
        {chevron}
      </Box>
      {expanded && <ExpandedDetail state={state} />}
    </Box>
  );
}
