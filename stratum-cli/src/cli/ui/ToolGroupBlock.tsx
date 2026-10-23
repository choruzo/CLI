import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { ToolCallState } from './ToolCallBlock.js';
import { describeGroup, groupTargets } from './tool-groups.js';

interface Props {
  calls: ToolCallState[];
  /** `compact`: solo el recuento; `standard`: también qué tocó. */
  detail: boolean;
  /** Ancho disponible para la lista de objetivos. */
  columns?: number;
}

/**
 * Racha de lecturas y búsquedas de un turno cerrado, en una línea (UX-3):
 * `✓ explorado │ 4 lecturas · 2 búsquedas │ App.tsx, theme.ts, +3`. El check es
 * el de una tool terminada; el verbo va apagado porque no es la acción
 * principal del turno, solo su contexto.
 */
export function ToolGroupBlock({ calls, detail, columns = 80 }: Props) {
  const summary = describeGroup(calls);
  // `✓ explorado │ ` + resumen + ` │ ` y un margen para no rozar el borde.
  const room = Math.max(12, columns - summary.length - 22);
  const targets = detail ? groupTargets(calls, room) : '';
  return (
    <Box>
      <Text color={theme.success}>✓ </Text>
      <Text color={theme.textMuted}>explorado</Text>
      <Text color={theme.textFaint}> │ {summary}</Text>
      {targets && (
        <Text color={theme.textDisabled} wrap="truncate-end">
          {' '}
          │ {targets}
        </Text>
      )}
    </Box>
  );
}
