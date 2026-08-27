import React, { useState, useEffect, useCallback } from 'react';
import { Box, Static, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';
import { getAsciiArt } from './ascii-art.js';
import { resolveLayout } from './layout.js';
import { MCPStartup } from './MCPStartup.js';
import type { McpManager } from '../../tools/mcp/manager.js';

type Phase = 'appearing' | 'ready';

const TIPS = [
  ['❯ ', 'stratum chat', '            iniciar conversación interactiva'],
  ['❯ ', 'stratum run "tarea"', '  ejecutar tarea one-shot'],
  ['/ ', '/help', '                  ver todos los comandos disponibles'],
  ['/ ', '/memory list', '          gestionar memoria persistente'],
] as const;

interface Props {
  version: string;
  onSend: (text: string) => void;
  logoPreRendered: boolean;
  /**
   * Panel de arranque MCP (§14). Solo se pasa con `mcp.startup: 'eager'`;
   * mientras no haya conectado todo, los tips y el prompt no aparecen.
   */
  mcpStartup?: { manager: McpManager; timeouts: Record<string, number> };
}

export function Banner({ version, onSend, logoPreRendered, mcpStartup }: Props) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const art = getAsciiArt(cols);
  // §9: por debajo de 24 filas el banner se reduce a ASCII art + prompt.
  const { showTips } = resolveLayout(cols, rows);

  const [phase, setPhase] = useState<Phase>('appearing');
  const [subtitleColor, setSubtitleColor] = useState<string>(theme.textInvisible);
  const [inputValue, setInputValue] = useState('');
  const [mcpSettled, setMcpSettled] = useState(!mcpStartup);

  const handleMcpSettled = useCallback(() => setMcpSettled(true), []);

  useEffect(() => {
    if (phase !== 'appearing') return;
    const steps = ['#374151', '#4B5563', '#6B7280'] as const;
    let step = 0;
    const iv = setInterval(() => {
      setSubtitleColor(steps[step]!);
      if (++step >= steps.length) {
        clearInterval(iv);
        setPhase('ready');
      }
    }, 50);
    return () => clearInterval(iv);
  }, [phase]);

  const handleSubmit = (value: string) => {
    if (!value.trim()) return;
    onSend(value.trim());
  };

  const tagline = `v${version}  ·  extensible · local-first · provider-agnostic`;
  const sepWidth = Math.max(0, Math.min(cols - 4, 72));
  const sep = '─'.repeat(sepWidth);

  const ready = phase === 'ready' && mcpSettled;

  return (
    <>
      {!logoPreRendered && (
        <Static items={[art]}>
          {(item) => (
            <Box key="startup-logo" paddingX={2} paddingTop={1}>
              <Text color={theme.accent}>{item}</Text>
            </Box>
          )}
        </Static>
      )}

      {mcpStartup && !mcpSettled && (
        <MCPStartup
          manager={mcpStartup.manager}
          timeouts={mcpStartup.timeouts}
          onAllSettled={handleMcpSettled}
        />
      )}

      <Box flexDirection="column" paddingX={2} paddingY={showTips ? 1 : 0}>
        {showTips && (
          <>
            <Text> </Text>
            <Text color={subtitleColor}>{tagline}</Text>
            <Text> </Text>
            <Text color={theme.textInvisible}>── quick start {sep.slice(14)}</Text>
          </>
        )}

        {ready && (
          <>
            {showTips && (
              <>
                {TIPS.map(([prefix, cmd, desc], i) => (
                  <Box key={i}>
                    <Text color={theme.textFaint}>{prefix}</Text>
                    <Text color={theme.textPrimary}>{cmd}</Text>
                    <Text color={theme.textMuted}>{desc}</Text>
                  </Box>
                ))}
                <Text color={theme.textInvisible}>{sep}</Text>
                <Text> </Text>
              </>
            )}
            <Box>
              <Text color={theme.accent} bold>
                ❯❯{' '}
              </Text>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleSubmit}
                placeholder="Type your first message..."
                showCursor
                focus
              />
            </Box>
          </>
        )}
      </Box>
    </>
  );
}
