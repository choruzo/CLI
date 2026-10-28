import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';

/**
 * Qué hará Enter con lo que hay en el input (UX-3, idea de deepseek-harness):
 * `send` abre un turno; `steer` lo deja en la inbox del turno en curso, que lo
 * recoge en su siguiente punto seguro sin cancelar nada. Sin input posible (un
 * gate abierto, un error fatal) no hay modo.
 */
export type PromptMode = 'send' | 'steer' | null;

interface Props {
  mode: PromptMode;
  /** La primera Esc del doble Esc ya se pulsó: la siguiente para el turno. */
  escArmed?: boolean;
  /** Hay un `exec` en primer plano que Ctrl+B puede pasar a segundo plano (UX-4). */
  canBackground?: boolean;
  /** Lectura de telemetría a la derecha (ya formateada); se omite si está vacía. */
  telemetry?: React.ReactNode;
}

/**
 * Pie del prompt: a la izquierda, el modo de Enter y cómo parar; a la derecha,
 * la telemetría. Una sola línea apagada: es contexto, no contenido.
 */
export function PromptFooter({ mode, escArmed = false, canBackground = false, telemetry }: Props) {
  if (!mode && !telemetry) return null;
  return (
    <Box justifyContent="space-between" paddingX={2} width="100%">
      {/* El aviso cede antes que la telemetría: recortada no se leía (`…so 2`). */}
      <Box flexShrink={1}>
        {mode === 'send' && (
          <Text color={theme.textDisabled} wrap="truncate-end">
            <Text color={theme.textFaint}>↵ enviar</Text> · / comandos · @ perfiles
          </Text>
        )}
        {mode === 'steer' &&
          (escArmed ? (
            <Text color={theme.warning} wrap="truncate-end">
              esc otra vez para parar el turno
            </Text>
          ) : (
            <Text color={theme.textDisabled} wrap="truncate-end">
              <Text color={theme.accent}>↵ redirigir</Text>
              {/* Con Ctrl+B disponible no cabe todo: se cae la explicación. */}
              {canBackground ? '' : ' · lo recibe en su próximo punto seguro'} ·{' '}
              <Text color={theme.textFaint}>esc esc</Text> parar
              {canBackground && (
                <>
                  {' · '}
                  <Text color={theme.textFaint}>ctrl+b</Text> a segundo plano
                </>
              )}
            </Text>
          ))}
      </Box>
      {telemetry ? (
        <Box flexShrink={0} marginLeft={2}>
          {telemetry}
        </Box>
      ) : null}
    </Box>
  );
}
