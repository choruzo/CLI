import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';
import type { McpStatusSummary } from '../../tools/mcp/manager.js';
import type { AgentMode } from '../../agent/types.js';

/** Estado de salud del provider activo para el indicador `●` (Hito 6). */
export type ProviderStatus = 'connected' | 'disconnected' | 'checking' | 'unknown';

interface Props {
  providerName: string;
  model: string;
  contextUsed: number;
  contextMax: number;
  /** true cuando el conteo es estimado (proxy chars/3.5) — muestra prefijo `~` */
  estimated?: boolean;
  /** Estado de conectividad MCP. Undefined si no hay servers configurados. */
  mcpStatus?: McpStatusSummary;
  /**
   * Salud del provider activo (Hito 6). Driva el color del `●` izquierdo:
   * verde = conectado, rojo = no responde, gris = comprobando/desconocido.
   * Si se omite, el indicador queda en verde (compatibilidad pre-Hito 6).
   */
  providerStatus?: ProviderStatus;
  /**
   * Modo del agente (Hito 7). Cuando es 'plan'/'execute' se pinta un badge a la
   * derecha del status bar: `◑ PLAN` (ámbar) o `▸ EXEC` (verde).
   */
  mode?: AgentMode;
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

/** Color del indicador `●` del provider según su health check (Hito 6). */
function providerDotColor(status: ProviderStatus | undefined): string {
  switch (status) {
    case 'disconnected':
      return theme.error;
    case 'checking':
    case 'unknown':
      return theme.textMuted;
    case 'connected':
    default:
      return theme.success;
  }
}

export function StatusBar({
  providerName,
  model,
  contextUsed,
  contextMax,
  estimated,
  mcpStatus,
  providerStatus,
  mode,
}: Props) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const pct = contextMax > 0 ? Math.round((contextUsed / contextMax) * 100) : 0;
  const ctxColor = contextColor(pct);
  const provColor = providerDotColor(providerStatus);

  // Indicador MCP separado (Hito 6): el `●` izquierdo pasa a reflejar la salud
  // del provider, así que MCP tiene su propio segmento `mcp ●` cuando hay servers.
  const showMcp = !!mcpStatus && mcpStatus.total > 0;
  const mcpSegmentText = showMcp ? ` │ mcp ●` : '';

  // Badge de modo (Hito 7): solo visible mientras mode !== 'normal'.
  const planBadge = mode === 'plan' ? '◑ PLAN' : mode === 'execute' ? '▸ EXEC' : '';
  const planBadgeColor = mode === 'plan' ? '#F59E0B' : '#34D399';

  const ctxSuffix = ` ctx ${estimated ? '~' : ''}${formatTokens(contextUsed)} / ${formatTokens(contextMax)} │ ${pct}%${planBadge ? `  ${planBadge}` : ''}`;
  const leftLen = ` ● ${providerName} │ ${model}${mcpSegmentText}`.length;
  const spacer = cols - leftLen - ctxSuffix.length;
  const gap = spacer > 0 ? ' '.repeat(spacer) : ' ';

  return (
    <Box>
      <Text color={provColor}>●</Text>
      <Text color={theme.textMuted}> {providerName} </Text>
      <Text color={theme.textInvisible}>│</Text>
      <Text color={theme.textPrimary}> {model}</Text>
      {showMcp && (
        <>
          <Text color={theme.textInvisible}> │</Text>
          <Text color={theme.textMuted} dimColor>
            {' '}
            mcp{' '}
          </Text>
          <Text color={mcpDotColor(mcpStatus)}>●</Text>
        </>
      )}
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
      {planBadge && (
        <Text color={planBadgeColor} bold>
          {'  '}
          {planBadge}
        </Text>
      )}
    </Box>
  );
}
