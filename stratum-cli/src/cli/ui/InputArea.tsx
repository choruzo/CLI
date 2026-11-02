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
  /**
   * Cambia cuando el valor se reescribe por debajo del input (una ruta pegada
   * que se convierte en chip): `ink-text-input` guarda su cursor y, con el
   * mismo valor, no lo reajusta; remontarlo lo deja a cero.
   */
  resetKey?: number;
}

export function InputArea({ value, onChange, onSubmit, disabled, steering, resetKey }: Props) {
  return (
    <Box borderStyle="single" borderColor={theme.borderMedium} paddingX={1}>
      <Text color={disabled ? theme.textDisabled : theme.accent} bold>
        ❯❯{' '}
      </Text>
      {/* Trabajando, el input va vacío: el estado lo cuenta <ThinkingIndicator>
          encima y qué hace Enter, el pie del prompt. */}
      {disabled ? (
        <Text> </Text>
      ) : (
        <TextInput
          key={resetKey}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={steering ? '' : 'Escribe un mensaje o / para comandos…'}
          focus={!disabled}
          showCursor
        />
      )}
    </Box>
  );
}
