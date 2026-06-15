import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { SessionCommand } from './session-commands.js';

interface Props {
  items: SessionCommand[];
  selectedIndex: number;
  maxVisible?: number;
}

/**
 * Panel de autocompletado de /comandos (UI §5.2). Se renderiza encima del
 * input. Render puro: la navegación (↑↓/Enter/Tab/Esc) la gestiona App.
 */
export function CommandPalette({ items, selectedIndex, maxVisible = 8 }: Props) {
  if (items.length === 0) return null;

  let start = 0;
  if (items.length > maxVisible) {
    start = Math.min(
      Math.max(selectedIndex - Math.floor(maxVisible / 2), 0),
      items.length - maxVisible,
    );
  }
  const visible = items.slice(start, start + maxVisible);
  const nameWidth = Math.max(...items.map((c) => c.name.length)) + 2;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
      {visible.map((cmd, i) => {
        const absolute = start + i;
        const active = absolute === selectedIndex;
        return (
          <Text key={cmd.name} wrap="truncate-end">
            <Text color={active ? theme.accent : theme.textDisabled} bold={active}>
              {active ? '▶ ' : '  '}
            </Text>
            <Text color={active ? theme.accent : theme.textMuted} bold={active}>
              {cmd.name.padEnd(nameWidth)}
            </Text>
            <Text color={active ? theme.textResponse : theme.textDisabled}>{cmd.description}</Text>
          </Text>
        );
      })}
      {items.length > maxVisible && <Text color={theme.textDisabled}> ↑↓ para navegar</Text>}
    </Box>
  );
}
