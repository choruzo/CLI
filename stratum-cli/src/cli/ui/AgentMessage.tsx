import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { StreamingText } from './StreamingText.js';
import { MarkdownText } from './MarkdownText.js';

interface Props {
  text: string;
  toolCalls: ToolCallState[];
  streaming: boolean;
  /** id del tool call block enfocado con Tab (si pertenece a este mensaje). */
  focusedBlockId?: string | null;
  /** ids de bloques con output expandido (Space). */
  expandedBlockIds?: ReadonlySet<string>;
}

/**
 * Turno del agente. Dual-mode (§5.3): <StreamingText> mientras streaming=true,
 * <MarkdownText> (marked + Ink) al recibir `done`. Ambos reciben el mismo
 * `text`, el swap ocurre en el mismo tick que la desaparición del cursor.
 */
export function AgentMessage({
  text,
  toolCalls,
  streaming,
  focusedBlockId,
  expandedBlockIds,
}: Props) {
  const hasContent = toolCalls.length > 0 || text;
  if (!hasContent) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent} bold>
        Stratum
      </Text>
      {toolCalls.map((tc) => (
        <ToolCallBlock
          key={tc.id}
          state={tc}
          focused={focusedBlockId === tc.id}
          expanded={expandedBlockIds?.has(tc.id) ?? false}
        />
      ))}
      {text &&
        (streaming ? <StreamingText text={text} streaming={true} /> : <MarkdownText text={text} />)}
    </Box>
  );
}
