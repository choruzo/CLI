import React from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

/**
 * Código inline (§5.3): sin caja ni borde, solo cambio de color.
 * Compatible con el flow de <Text wrap="wrap"> del párrafo padre.
 */
export function InlineCode({ children }: { children: React.ReactNode }) {
  return <Text color={theme.code}>{children}</Text>;
}
