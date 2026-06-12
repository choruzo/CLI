import React from 'react';
import TextInput from 'ink-text-input';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
}

/**
 * Input enmascarado para API keys (wizard de providers, Hito 3.5).
 * Envoltorio fino sobre ink-text-input con `mask="*"`.
 */
export function MaskedInput({ value, onChange, onSubmit, placeholder }: Props) {
  return (
    <TextInput
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      placeholder={placeholder}
      mask="*"
      showCursor
    />
  );
}
