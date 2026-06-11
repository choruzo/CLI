import React from 'react';
import { Box, Text } from 'ink';
import { highlight } from 'cli-highlight';
import { theme } from '../theme.js';

interface Props {
  lang?: string;
  text: string;
}

function maxWidth(): number {
  return Math.min((process.stdout.columns ?? 80) - 4, 100);
}

/**
 * Bloque de código (§5.3): box bordeado con header de lenguaje opcional y
 * syntax highlighting via cli-highlight. Si el lenguaje no es reconocido,
 * texto plano. Las líneas no hacen word-wrap: se truncan con `…`.
 */
export function CodeBlock({ lang, text }: Props) {
  let rendered = text;
  if (lang) {
    try {
      rendered = highlight(text, { language: lang, ignoreIllegals: true });
    } catch {
      rendered = text;
    }
  }

  const lines = rendered.replace(/\n$/, '').split('\n');
  const width = maxWidth();

  return (
    <Box flexDirection="column" marginBottom={1} width={width}>
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.borderSubtle}
        paddingX={1}
      >
        {lang ? (
          <Text color={theme.textFaint} dimColor>
            {lang}
          </Text>
        ) : null}
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line || ' '}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
