import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';
import { renderTokens } from './markdown/renderTokens.js';
import { theme } from './theme.js';

interface Props {
  text: string;
}

/**
 * Renderizado de markdown con `marked` + componentes Ink manuales (§5.3).
 *
 * Se monta al recibir el evento `done` (dual-mode): durante el streaming se usa
 * <StreamingText> (texto plano + cursor) porque el LLM puede emitir markdown
 * incompleto que rompería el parser. El swap es transparente para el usuario.
 *
 * No se usa marked-terminal (ANSI raw que colisiona con el layout de Ink) ni
 * ink-markdown (abandonado). Ver STRATUM_UI_SPECIFICATION.md §5.3.
 */
export function MarkdownText({ text }: Props) {
  const rendered = useMemo(() => {
    try {
      const tokens = marked.lexer(text);
      return renderTokens(tokens);
    } catch {
      return null;
    }
  }, [text]);

  if (rendered === null) {
    // Fallback: si el parser falla, mostrar el texto plano
    return (
      <Text wrap="wrap" color={theme.textResponse}>
        {text}
      </Text>
    );
  }

  return <Box flexDirection="column">{rendered}</Box>;
}
