import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { StreamingText } from './StreamingText.js';

interface Props {
  text: string;
  toolCalls: ToolCallState[];
  streaming: boolean;
}

export function AgentMessage({ text, toolCalls, streaming }: Props) {
  const hasContent = toolCalls.length > 0 || text;
  if (!hasContent) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.accent} bold>
        Stratum
      </Text>
      {toolCalls.map((tc) => (
        <ToolCallBlock key={tc.id} state={tc} />
      ))}
      {text && <StreamingText text={text} streaming={streaming} />}
    </Box>
  );
}
