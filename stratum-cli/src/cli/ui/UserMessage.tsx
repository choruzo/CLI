import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

interface Props {
  text: string;
}

export function UserMessage({ text }: Props) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.textFaint} dimColor>
        You
      </Text>
      <Box>
        <Text color={theme.textInvisible}>▏ </Text>
        <Text color={theme.textPrimary}>{text}</Text>
      </Box>
    </Box>
  );
}
