import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  /**
   * El agente está trabajando y admite mensajes: lo que se envíe no cancela
   * nada, se encola y entra en su siguiente punto seguro.
   */
  steering?: boolean;
}

export function InputArea({ value, onChange, onSubmit, disabled, steering }: Props) {
  return (
    <Box borderStyle="single" borderColor={theme.borderMedium} paddingX={1}>
      <Text color={disabled ? theme.textDisabled : theme.accent} bold>
        ❯❯{' '}
      </Text>
      {disabled ? (
        <Text color={theme.textDisabled} dimColor>
          Stratum is thinking...
        </Text>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={
            steering
              ? 'Agent is working — type to steer it (Enter queues, Ctrl+C cancels)...'
              : 'Type a message or / for commands...'
          }
          focus={!disabled}
          showCursor
        />
      )}
    </Box>
  );
}
