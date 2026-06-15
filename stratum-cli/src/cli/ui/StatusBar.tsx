import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';
import type { McpStatusSummary } from '../../tools/mcp/manager.js';

interface Props {
  providerName: string;
  model: string;
  contextUsed: number;
  contextMax: number;
  /** true cuando el conteo es estimado (proxy chars/3.5) — muestra prefijo `~` */
  estimated?: boolean;
  /** Estado de conectividad MCP. Undefined si no hay servers configurados. */
  mcpStatus?: McpStatusSummary;
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

function mcpDotColor(status: McpStatusSummary): string {
  if (status.total === 0) return theme.success;
  if (status.disconnected === status.total) return theme.error;
  if (status.reconnecting > 0 || status.disconnected > 0) return theme.accent;
  return theme.success;
}

export function StatusBar({
  providerName,
  model,
  contextUsed,
  contextMax,
  estimated,
  mcpStatus,
}: Props) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const pct = contextMax > 0 ? Math.round((contextUsed / contextMax) * 100) : 0;
  const ctxColor = contextColor(pct);
  const dotColor = mcpStatus ? mcpDotColor(mcpStatus) : theme.success;

  const ctxSuffix = ` ctx ${estimated ? '~' : ''}${formatTokens(contextUsed)} / ${formatTokens(contextMax)} │ ${pct}%`;
  const leftLen = ` ● ${providerName} │ ${model}`.length;
  const spacer = cols - leftLen - ctxSuffix.length;
  const gap = spacer > 0 ? ' '.repeat(spacer) : ' ';

  return (
    <Box>
      <Text color={dotColor}>●</Text>
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
