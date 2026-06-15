import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.js';

interface Props {
  toolName: string;
  description: string;
  onApprove: () => void;
  onDeny: () => void;
  onAllowAll: () => void;
}

/**
 * Bloque de confirmación para operaciones destructivas (UI spec §12).
 * Se renderiza entre el área de conversación y el input; el input queda
 * bloqueado hasta que el usuario responda.
 *
 * S / Y / Enter → aprobar · N / Esc → cancelar · ! → permitir todo en la sesión
 */
export function DestructiveConfirm({ description, onApprove, onDeny, onAllowAll }: Props) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 's' || ch === 'y' || key.return) {
      onApprove();
    } else if (ch === 'n' || key.escape) {
      onDeny();
    } else if (input === '!') {
      onAllowAll();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.accent}
      paddingX={1}
      marginTop={0}
    >
      <Text color={theme.accent} bold>
        ⚠ Operación destructiva
      </Text>
      <Text> </Text>
      <Text color={theme.textPrimary} wrap="truncate-end">
        {'  '}
        {description}
      </Text>
      <Text> </Text>
      <Text>
        {'  '}
        <Text color={theme.textMuted}>¿Continuar? </Text>
        <Text color={theme.accent} bold>
          [ S ]
        </Text>
        <Text color={theme.textMuted}> continuar </Text>
        <Text color={theme.error} bold>
          [ N ]
        </Text>
        <Text color={theme.textMuted}> cancelar </Text>
        <Text color={theme.warning} bold>
          [ ! ]
        </Text>
        <Text color={theme.textMuted}> permitir todo</Text>
      </Text>
    </Box>
  );
}
