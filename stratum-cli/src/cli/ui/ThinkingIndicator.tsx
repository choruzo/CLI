import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import {
  SHOW_ELAPSED_AFTER_MS,
  formatElapsed,
  thinkingPhrase,
  type ThinkingPhase,
} from './thinking-phrases.js';
import {
  liveAction,
  liveThinkingPhase,
  shimmerParts,
  strataFrameAt,
  strataIntervalMs,
  type LiveTurnShape,
} from './strata-loader.js';
import { formatInput, type ToolCallState } from './ToolCallBlock.js';

/** Filas que ocupa el indicador: la de la acción en curso solo si la hay. */
export function thinkingIndicatorRows(item: LiveTurnShape | null | undefined): number {
  return liveAction(item) ? 2 : 1;
}

interface Props {
  /** Semilla del turno: cada turno empieza por una frase distinta. */
  seed: string;
  /** El turno en curso: de él salen la fase y la acción que corre. */
  item: (LiveTurnShape & { toolCalls?: ToolCallState[] }) | null;
  /** Cuándo empezó el turno, para la frase y los segundos. */
  startedAt: number;
}

/**
 * Sobre el input mientras el agente trabaja. Arriba, si hay una tool (o un
 * subagente) corriendo, su icono, nombre y argumento; debajo, siempre, el
 * símbolo de Stratum depositándose y la frase de estratos. Lleva su propio
 * reloj: el de la conversación (250 ms) es lento para la animación, y así solo
 * se repinta esto.
 */
export function ThinkingIndicator({ seed, item, startedAt }: Props) {
  const phase: ThinkingPhase = liveThinkingPhase(item);
  const interval = strataIntervalMs(phase);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(iv);
  }, [interval]);

  const elapsed = Math.max(0, now - startedAt);
  const phrase = thinkingPhrase(seed, phase, elapsed);
  const [before, glint, after] = shimmerParts(phrase, now);

  const action = liveAction(item);
  const tool = action?.toolIndex !== undefined ? item?.toolCalls?.[action.toolIndex] : undefined;
  const detail = tool ? (tool.input ? formatInput(tool) : '') : (action?.detail ?? '');
  const actionElapsed = action?.startedAt ? Math.max(0, now - action.startedAt) : 0;

  return (
    <Box flexDirection="column" paddingX={2} flexShrink={0}>
      {action && (
        <Text wrap="truncate-end">
          <Text color={theme.accent}>{action.icon}</Text>{' '}
          <Text color={theme.textPrimary} bold>
            {action.name}
          </Text>
          {detail ? <Text color={theme.textMuted}> {detail}</Text> : null}
          {actionElapsed >= 1000 && (
            <Text color={theme.textFaint}>{`  ${formatElapsed(actionElapsed)}`}</Text>
          )}
          {action.others > 0 && <Text color={theme.textFaint}>{`  +${action.others} más`}</Text>}
        </Text>
      )}
      <Text wrap="truncate-end">
        <Text color={phase === 'reasoning' ? theme.accentBright : theme.accent}>
          {strataFrameAt(now, phase)}
        </Text>{' '}
        <Text color={theme.textMuted}>{before}</Text>
        <Text color={theme.accentBright}>{glint}</Text>
        <Text color={theme.textMuted}>{after}</Text>
        {elapsed >= SHOW_ELAPSED_AFTER_MS && (
          <Text color={theme.textFaint}>{`  ${formatElapsed(elapsed)}`}</Text>
        )}
      </Text>
    </Box>
  );
}
