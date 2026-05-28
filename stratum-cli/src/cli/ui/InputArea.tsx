import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputArea({ value, onChange, onSubmit, disabled }: Props) {
  return (
    <Box borderStyle="single" borderColor={theme.borderMedium} paddingX={1}>
      <Text color={disabled ? theme.textDisabled : theme.accent} bold>❯❯ </Text>
      {disabled ? (
        <Text color={theme.textDisabled} dimColor>Stratum is thinking...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="Type a message or / for commands..."
          focus={!disabled}
          showCursor
        />
      )}
    </Box>
  );
}
