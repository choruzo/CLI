import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';
import type { McpStatusSummary } from '../../tools/mcp/manager.js';
import type { AgentMode, TokenAccounting } from '../../agent/types.js';

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
  /**
   * Cambios del working tree ya formateados (`+N/-M`, Hito 13). Cadena vacía
   * cuando el árbol está limpio o el cwd no es un repo: el segmento desaparece.
   */
  changes?: string;
  /**
   * Contabilidad de tokens de la sesión (Hito 13). Solo se pinta un número
   * cuando el backend lo reportó; con `unsupported` se pinta `Σ n/d` atenuado
   * (el backend no va a darlo nunca) y con `unavailable` no se pinta nada,
   * porque todavía puede haber dato.
   */
  tokens?: TokenAccounting;
  /** Perfil activo como agente principal (Hito 15): segmento `◆ perfil` a la derecha. */
  activeAgent?: string | null;
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

/** Texto del medidor de tokens de sesión, o '' cuando no procede pintarlo. */
export function formatTokenMeter(tokens: TokenAccounting | undefined): string {
  if (!tokens) return '';
  if (tokens.status === 'reported') return `Σ ${formatTokens(tokens.tokens ?? 0)}`;
  if (tokens.status === 'unsupported') return 'Σ n/d';
  return '';
}

/**
 * Ancho a partir del cual caben los segmentos opcionales (Hito 13). Por debajo
 * se sacrifican en orden: primero el medidor de tokens, luego los cambios. El
 * contexto y el modelo nunca se recortan — son los que el usuario mira.
 */
const WIDE_ENOUGH_FOR_TOKENS = 100;
const WIDE_ENOUGH_FOR_CHANGES = 80;

export function StatusBar({
  providerName,
  model,
  contextUsed,
  contextMax,
  estimated,
  mcpStatus,
  providerStatus,
  mode,
  changes,
  tokens,
  activeAgent,
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

  const changesText = changes && cols >= WIDE_ENOUGH_FOR_CHANGES ? changes : '';
  const tokenText = cols >= WIDE_ENOUGH_FOR_TOKENS ? formatTokenMeter(tokens) : '';

  // Badge de modo (Hito 7): solo visible mientras mode !== 'normal'.
  const planBadge = mode === 'plan' ? '◑ PLAN' : mode === 'execute' ? '▸ EXEC' : '';
  const planBadgeColor = mode === 'plan' ? '#F59E0B' : '#34D399';
  // Perfil principal activo (Hito 15). Va antes del badge de plan: el perfil
  // dura la sesión, el modo plan dura una tarea.
  const agentBadge = activeAgent ? `◆ ${activeAgent}` : '';

  const ctxSuffix =
    `${tokenText ? `${tokenText} · ` : ''}` +
    ` ctx ${estimated ? '~' : ''}${formatTokens(contextUsed)} / ${formatTokens(contextMax)} │ ${pct}%${agentBadge ? `  ${agentBadge}` : ''}${planBadge ? `  ${planBadge}` : ''}`;
  const leftLen =
    ` ● ${providerName} │ ${model}${mcpSegmentText}${changesText ? ` │ ${changesText}` : ''}`
      .length;
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
      {changesText && (
        <>
          <Text color={theme.textInvisible}> │</Text>
          <Text color={theme.accent}> {changesText}</Text>
        </>
      )}
      <Text>{gap}</Text>
      {tokenText && (
        <>
          <Text color={theme.textMuted} dimColor>
            {tokenText}
          </Text>
          <Text color={theme.textInvisible}> · </Text>
        </>
      )}
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
      {agentBadge && (
        <Text color={theme.accent} bold>
          {'  '}
          {agentBadge}
        </Text>
      )}
      {planBadge && (
        <Text color={planBadgeColor} bold>
          {'  '}
          {planBadge}
        </Text>
      )}
    </Box>
  );
}
