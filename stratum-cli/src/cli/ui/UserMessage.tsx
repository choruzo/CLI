import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

interface Props {
  text: string;
  /** Etiqueta junto al mensaje: `queued as steering`. */
  note?: string;
}

export function UserMessage({ text, note }: Props) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.textFaint} dimColor>
        You
      </Text>
      <Box>
        <Text color={theme.textInvisible}>▏ </Text>
        <Text color={theme.textPrimary}>{text}</Text>
      </Box>
      {note && (
        <Text color={theme.textMuted} dimColor>
          {'  '}[{note}]
        </Text>
      )}
    </Box>
  );
}
