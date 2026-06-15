import React from 'react';
import { Box, Text } from 'ink';
import type { Token, Tokens } from 'marked';
import { theme } from '../theme.js';
import { CodeBlock } from './CodeBlock.js';
import { InlineCode } from './InlineCode.js';

function ruleWidth(): number {
  return Math.min((process.stdout.columns ?? 80) - 4, 100);
}

/**
 * Renderiza tokens inline (contenido de párrafos, headings, list items...)
 * como hijos anidados de un <Text>, para que participen del word-wrap del padre.
 */
export function renderInline(tokens: Token[] | undefined, keyPrefix = 'i'): React.ReactNode[] {
  if (!tokens) return [];
  return tokens.map((token, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'strong':
        return (
          <Text key={k} bold>
            {renderInline((token as Tokens.Strong).tokens, k)}
          </Text>
        );
      case 'em':
        return (
          <Text key={k} italic>
            {renderInline((token as Tokens.Em).tokens, k)}
          </Text>
        );
      case 'del':
        return (
          <Text key={k} strikethrough>
            {renderInline((token as Tokens.Del).tokens, k)}
          </Text>
        );
      case 'codespan':
        return <InlineCode key={k}>{(token as Tokens.Codespan).text}</InlineCode>;
      case 'link': {
        const link = token as Tokens.Link;
        const label = link.tokens ? renderInline(link.tokens, k) : link.text;
        return (
          <Text key={k}>
            <Text color={theme.accentBright}>{label}</Text>
            <Text color={theme.textFaint} dimColor>
              {' '}
              ({link.href})
            </Text>
          </Text>
        );
      }
      case 'br':
        return <Text key={k}>{'\n'}</Text>;
      case 'escape':
        return <Text key={k}>{(token as Tokens.Escape).text}</Text>;
      case 'text': {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          return <Text key={k}>{renderInline(t.tokens, k)}</Text>;
        }
        return <Text key={k}>{t.text}</Text>;
      }
      default:
        // Fallback plano: ningún elemento no soportado rompe el render
        return <Text key={k}>{(token as { raw?: string }).raw ?? ''}</Text>;
    }
  });
}

function HeadingBlock({ token, k }: { token: Tokens.Heading; k: string }) {
  const color = token.depth <= 2 ? theme.accent : theme.textMuted;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>
        {renderInline(token.tokens, k)}
      </Text>
      {token.depth === 1 && <Text color={theme.textDisabled}>{'─'.repeat(ruleWidth())}</Text>}
    </Box>
  );
}

function ListBlock({ token, k }: { token: Tokens.List; k: string }) {
  const start = typeof token.start === 'number' && token.start > 0 ? token.start : 1;
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      {token.items.map((item, i) => (
        <Box key={`${k}-li-${i}`}>
          <Text color={theme.textResponse}>{token.ordered ? `${start + i}. ` : '• '}</Text>
          <Box flexDirection="column">
            <Text wrap="wrap" color={theme.textResponse}>
              {renderInline(
                item.tokens.flatMap((t) =>
                  t.type === 'text' && (t as Tokens.Text).tokens
                    ? ((t as Tokens.Text).tokens as Token[])
                    : [t],
                ),
                `${k}-li-${i}`,
              )}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function QuoteBlock({ token, k }: { token: Tokens.Blockquote; k: string }) {
  return (
    <Box
      borderStyle="single"
      borderColor={theme.textDisabled}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      paddingLeft={1}
      marginBottom={1}
      flexDirection="column"
    >
      {renderTokens(token.tokens, `${k}-q`, true)}
    </Box>
  );
}

/**
 * Función recursiva principal: Token[] (block-level) → JSX.Element[].
 * `inline=true` aplana párrafos a texto (para blockquotes).
 */
export function renderTokens(tokens: Token[], keyPrefix = 't', inline = false): React.ReactNode[] {
  return tokens.map((token, i) => {
    const k = `${keyPrefix}-${i}`;
    switch (token.type) {
      case 'heading':
        return <HeadingBlock key={k} token={token as Tokens.Heading} k={k} />;
      case 'paragraph': {
        const p = token as Tokens.Paragraph;
        if (inline) {
          return (
            <Text key={k} wrap="wrap" color={theme.textFaint}>
              {renderInline(p.tokens, k)}
            </Text>
          );
        }
        return (
          <Box key={k} marginBottom={1}>
            <Text wrap="wrap" color={theme.textResponse}>
              {renderInline(p.tokens, k)}
            </Text>
          </Box>
        );
      }
      case 'code': {
        const c = token as Tokens.Code;
        return <CodeBlock key={k} lang={c.lang || undefined} text={c.text} />;
      }
      case 'list':
        return <ListBlock key={k} token={token as Tokens.List} k={k} />;
      case 'blockquote':
        return <QuoteBlock key={k} token={token as Tokens.Blockquote} k={k} />;
      case 'hr':
        return (
          <Box key={k} marginBottom={1}>
            <Text color={theme.textDisabled}>{'─'.repeat(ruleWidth())}</Text>
          </Box>
        );
      case 'space':
        return <React.Fragment key={k} />;
      case 'text': {
        const t = token as Tokens.Text;
        return (
          <Text key={k} wrap="wrap" color={theme.textResponse}>
            {t.tokens && t.tokens.length > 0 ? renderInline(t.tokens, k) : t.text}
          </Text>
        );
      }
      default:
        // Tablas, HTML inline, footnotes... → texto plano sin parsear (v1)
        return (
          <Text key={k} wrap="wrap" color={theme.textResponse}>
            {(token as { raw?: string }).raw ?? ''}
          </Text>
        );
    }
  });
}
