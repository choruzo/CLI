import React, { useState, useEffect } from 'react';
import { Box, Static, Text, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';
import { getAsciiArt } from './ascii-art.js';

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
}

export function Banner({ version, onSend, logoPreRendered }: Props) {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const art = getAsciiArt(cols);

  const [phase, setPhase] = useState<Phase>('appearing');
  const [subtitleColor, setSubtitleColor] = useState(theme.textInvisible);
  const [inputValue, setInputValue] = useState('');

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

      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <>
          <Text> </Text>
          <Text color={subtitleColor}>{tagline}</Text>
          <Text> </Text>
          <Text color={theme.textInvisible}>── quick start {sep.slice(14)}</Text>
        </>

        {phase === 'ready' && (
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
