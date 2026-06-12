import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';

export interface SelectItem<T = string> {
  label: string;
  value: T;
  /** Texto secundario opcional (ej. "(actual)" en /model). */
  hint?: string;
}

interface Props<T> {
  items: SelectItem<T>[];
  /** Índice seleccionado inicialmente. Default 0. */
  initialIndex?: number;
  /** Máximo de ítems visibles antes de hacer scroll. Default 8 (UI §5.2). */
  maxVisible?: number;
  onSelect: (item: SelectItem<T>) => void;
  onCancel?: () => void;
}

/**
 * Selector por teclado propio (sin ink-select-input), consistente con el theme.
 * ↑↓ navega con wrap · Enter selecciona · Esc cancela.
 */
export function SelectList<T = string>({
  items,
  initialIndex = 0,
  maxVisible = 8,
  onSelect,
  onCancel,
}: Props<T>) {
  const [index, setIndex] = useState(Math.min(Math.max(initialIndex, 0), items.length - 1));

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i - 1 + items.length) % items.length);
    } else if (key.downArrow) {
      setIndex((i) => (i + 1) % items.length);
    } else if (key.return) {
      const item = items[index];
      if (item) onSelect(item);
    } else if (key.escape) {
      onCancel?.();
    }
  });

  if (items.length === 0) return null;

  // Ventana de scroll centrada en el ítem activo
  let start = 0;
  if (items.length > maxVisible) {
    start = Math.min(Math.max(index - Math.floor(maxVisible / 2), 0), items.length - maxVisible);
  }
  const visible = items.slice(start, start + maxVisible);

  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const absolute = start + i;
        const active = absolute === index;
        return (
          <Text key={absolute}>
            <Text color={active ? theme.accent : theme.textDisabled} bold={active}>
              {active ? '▶ ' : '  '}
            </Text>
            <Text color={active ? theme.accent : theme.textMuted} bold={active}>
              {item.label}
            </Text>
            {item.hint ? <Text color={theme.textFaint}> {item.hint}</Text> : null}
          </Text>
        );
      })}
      {items.length > maxVisible && (
        <Text color={theme.textDisabled}>
          {'  '}↑↓ para navegar ({index + 1}/{items.length})
        </Text>
      )}
    </Box>
  );
}
