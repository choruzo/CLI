import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';

interface Props {
  providerName: string;
  model: string;
  contextUsed: number;
  contextMax: number;
  /** true cuando el conteo es estimado (proxy chars/3.5) — muestra prefijo `~` */
  estimated?: boolean;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function contextColor(pct: number): string {
  if (pct < 60) return theme.success;
  if (pct < 85) return theme.accent;
  return theme.error;
}

export function StatusBar({ providerName, model, contextUsed, contextMax, estimated }: Props) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const pct = contextMax > 0 ? Math.round((contextUsed / contextMax) * 100) : 0;
  const ctxColor = contextColor(pct);
  const prefix = estimated ? '~' : '';

  const right = ` ctx ${prefix}${formatTokens(contextUsed)} / ${formatTokens(contextMax)} │ ${pct}%`;
  const left = ` ● ${providerName} │ ${model}`;
  const spacer = cols - left.length - right.length;
  const gap = spacer > 0 ? ' '.repeat(spacer) : ' ';

  return (
    <Box>
      <Text color={theme.success}>●</Text>
      <Text color={theme.textMuted}> {providerName} </Text>
      <Text color={theme.textInvisible}>│</Text>
      <Text color={theme.textPrimary}> {model}</Text>
      <Text>{gap}</Text>
      <Text color={theme.textMuted} dimColor>
        ctx{' '}
      </Text>
      {estimated && (
        <Text color={theme.textMuted} dimColor>
          ~
        </Text>
      )}
      <Text color={ctxColor}>{formatTokens(contextUsed)}</Text>
      <Text color={theme.textMuted} dimColor>
        {' '}
        / {formatTokens(contextMax)}
      </Text>
      <Text color={theme.textInvisible}> │</Text>
      <Text color={ctxColor}> {pct}%</Text>
    </Box>
  );
}
