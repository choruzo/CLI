import React from 'react';
import { Text } from 'ink';
import { theme } from './theme.js';

interface Props {
  text: string;
  streaming: boolean;
  now?: number;
  maxVisibleLines?: number;
  columns?: number;
}

export function limitLiveText(text: string, columns: number, maxLines: number): string {
  if (maxLines <= 0 || columns <= 0) return '';
  const rowsFor = (line: string) => Math.max(1, Math.ceil(line.length / columns));
  const lines = text.split('\n');
  const totalRows = lines.reduce((sum, line) => sum + rowsFor(line), 0);
  if (totalRows <= maxLines) return text;

  const budget = Math.max(1, maxLines - 1); // una fila para el aviso
  const tail: string[] = [];
  let usedRows = 0;
  for (let i = lines.length - 1; i >= 0 && usedRows < budget; i--) {
    const line = lines[i]!;
    const available = budget - usedRows;
    const lineRows = rowsFor(line);
    if (lineRows <= available) {
      tail.unshift(line);
      usedRows += lineRows;
    } else {
      tail.unshift(line.slice(-(available * columns)));
      usedRows = budget;
    }
  }
  return `… salida anterior ocultada durante el stream …\n${tail.join('\n')}`;
}

export function StreamingText({
  text,
  streaming,
  now = Date.now(),
  maxVisibleLines = 12,
  columns = 80,
}: Props) {
  const cursorVisible = !streaming || Math.floor(now / 500) % 2 === 0;
  const visibleText = streaming ? limitLiveText(text, columns, maxVisibleLines) : text;

  return (
    <Text color={theme.textResponse} wrap="wrap">
      {visibleText}
      {streaming && <Text color={cursorVisible ? theme.accent : 'black'}>█</Text>}
    </Text>
  );
}
