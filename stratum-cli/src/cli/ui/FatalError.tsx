import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

/**
 * Sugerencia accionable para los errores fatales más frecuentes (UI §11).
 * Función pura y exportada para poder testearla sin renderizar Ink.
 */
export function suggestForError(message: string): string | undefined {
  const m = message.toLowerCase();

  if (m.includes('econnrefused') || m.includes('fetch failed')) {
    return 'Verifica que el provider esté en ejecución y que baseUrl apunte al puerto correcto.';
  }
  if (m.includes('enotfound') || m.includes('eai_again')) {
    return 'No se resuelve el host del provider. Revisa baseUrl y tu conexión de red.';
  }
  if (m.includes('etimedout') || m.includes('timeout')) {
    return 'El provider no respondió a tiempo. Prueba con un modelo más pequeño o sube el timeout.';
  }
  if (m.includes('401') || m.includes('unauthorized') || m.includes('invalid api key')) {
    return 'Credenciales rechazadas. Revisa apiKey con: stratum config get providers.';
  }
  if (m.includes('404') || m.includes('model not found')) {
    return 'El modelo no existe en este provider. Usa /model para ver los disponibles.';
  }
  if (m.includes('context length') || m.includes('context_length_exceeded')) {
    return 'El contexto desbordó la ventana del modelo. Usa /compact o /clear y reintenta.';
  }
  if (m.includes('429') || m.includes('rate limit')) {
    return 'Límite de peticiones alcanzado. Espera unos segundos antes de reintentar.';
  }
  return undefined;
}

interface Props {
  message: string;
  /** Sugerencia explícita; si se omite, se deriva del mensaje. */
  hint?: string;
}

/**
 * Error fatal del agente (UI §11). El loop no puede continuar: se pinta un
 * bloque con borde rojo y el input queda bloqueado de forma permanente
 * (lo aplica `<ConversationView>` con `disabled`).
 */
export function FatalError({ message, hint }: Props) {
  const suggestion = hint ?? suggestForError(message);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.error} paddingX={1}>
      <Text color={theme.error} bold>
        ✗ Error fatal — el agente no puede continuar
      </Text>
      <Text> </Text>
      <Text color={theme.errorMuted}>
        {'  '}
        {message}
      </Text>
      {suggestion && (
        <Text color={theme.textFaint} dimColor>
          {'  '}
          {suggestion}
        </Text>
      )}
    </Box>
  );
}
