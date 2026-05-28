import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

export type ToolCallStatus = 'running' | 'completed' | 'error';

export interface ToolCallState {
  id: string;
  name: string;
  status: ToolCallStatus;
  inputSoFar?: string;
  input?: Record<string, unknown>;
  output?: string;
  errorMsg?: string;
  durationMs?: number;
}

const SPINNER_FRAMES = ['◌', '◎', '●', '◉', '○'];

function formatInput(state: ToolCallState): string {
  const src = state.input ?? {};
  const keys = Object.keys(src);
  if (keys.length === 0) return '';
  const first = String(src[keys[0]!] ?? '');
  return first.length > 50 ? first.slice(0, 47) + '...' : first;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Props {
  state: ToolCallState;
}

export function ToolCallBlock({ state }: Props) {
  const [frame, setFrame] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (state.status !== 'running') return;
    const spinIv = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 150);
    const timerIv = setInterval(() => setElapsedMs(e => e + 100), 100);
    return () => { clearInterval(spinIv); clearInterval(timerIv); };
  }, [state.status]);

  if (state.status === 'running') {
    return (
      <Box marginBottom={0}>
        <Text color={theme.accent}>{SPINNER_FRAMES[frame]} </Text>
        <Text color={theme.accent} bold>{state.name}</Text>
        <Text color={theme.textFaint}>  │  {formatDuration(elapsedMs)}  │  </Text>
        <Text color={theme.textFaint} dimColor>{state.inputSoFar?.slice(0, 60) ?? ''}</Text>
      </Box>
    );
  }

  if (state.status === 'completed') {
    const dur = state.durationMs !== undefined ? formatDuration(state.durationMs) : '';
    const label = formatInput(state);
    return (
      <Box marginBottom={0}>
        <Text color={theme.success}>✓ </Text>
        <Text color={theme.accent} bold>{state.name}</Text>
        {dur && <Text color={theme.textFaint}>  │  {dur}</Text>}
        {label && <Text color={theme.textFaint}>  │  {label}</Text>}
      </Box>
    );
  }

  return (
    <Box marginBottom={0}>
      <Text color={theme.error}>✗ </Text>
      <Text color={theme.errorMuted} bold>{state.name}</Text>
      <Text color={theme.errorMuted} dimColor>  │  {state.errorMsg ?? 'error'}</Text>
    </Box>
  );
}
