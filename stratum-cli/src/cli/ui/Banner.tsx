import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Static, Text, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';
import { getAsciiArt } from './ascii-art.js';
import { resolveLayout } from './layout.js';
import { MCPStartup } from './MCPStartup.js';
import { CommandPalette } from './CommandPalette.js';
import { SESSION_COMMANDS, filterCommands, filterProfiles } from './session-commands.js';
import type { McpManager } from '../../tools/mcp/manager.js';
import { shortPath, type RecentSessionRow } from './banner-info.js';

type Phase = 'appearing' | 'ready';

interface Props {
  version: string;
  onSend: (text: string) => void;
  logoPreRendered: boolean;
  /**
   * Panel de arranque MCP (§14). Solo se pasa con `mcp.startup: 'eager'`;
   * mientras no haya conectado todo, los tips y el prompt no aparecen.
   */
  mcpStartup?: { manager: McpManager; timeouts: Record<string, number> };
  /** Perfiles invocables con `@perfil`, para la paleta (Hito 15). */
  profiles?: Array<{ name: string; description: string }>;
  /** Con qué se empieza: provider y modelo, carpeta y sesiones para reanudar. */
  info?: BannerInfo;
}

export interface BannerInfo {
  provider: string;
  model: string;
  cwd: string;
  recent: RecentSessionRow[];
}

export function Banner({
  version,
  onSend,
  logoPreRendered,
  mcpStartup,
  profiles = [],
  info,
}: Props) {
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

  // ----- Paleta de /comandos y @perfiles (§5.2), igual que en la conversación -----
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const paletteItems = paletteDismissed
    ? []
    : inputValue.trimStart().startsWith('@')
      ? filterProfiles(inputValue, profiles)
      : filterCommands(inputValue, SESSION_COMMANDS);
  const effPaletteIndex = Math.min(paletteIndex, Math.max(paletteItems.length - 1, 0));

  // Ctrl+U llega también al TextInput, que lo inserta como una «u»: el cambio
  // que provoca esa misma pulsación se descarta, llegue antes o después.
  const swallowChangeRef = useRef(false);

  const handleChange = (value: string) => {
    if (swallowChangeRef.current) return;
    setPaletteDismissed(false);
    setPaletteIndex(0);
    setInputValue(value);
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'u') {
      handleChange('');
      swallowChangeRef.current = true;
      queueMicrotask(() => {
        swallowChangeRef.current = false;
      });
      return;
    }
    const len = paletteItems.length;
    if (len === 0) return;
    if (key.upArrow) setPaletteIndex((effPaletteIndex - 1 + len) % len);
    else if (key.downArrow) setPaletteIndex((effPaletteIndex + 1) % len);
    else if (key.escape) setPaletteDismissed(true);
    else if (key.tab) {
      const sel = paletteItems[effPaletteIndex];
      if (sel) handleChange(sel.hasArgs ? `${sel.name} ` : sel.name);
    }
  });

  const handleSubmit = (value: string) => {
    if (!value.trim()) return;
    // Enter con la paleta abierta: ejecutar (o completar) el comando seleccionado
    const sel = paletteItems[effPaletteIndex];
    if (sel && sel.name !== value.trim()) {
      if (sel.hasArgs) handleChange(`${sel.name} `);
      else onSend(sel.name);
      return;
    }
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
          </>
        )}

        {ready && (
          <>
            {showTips && (
              <>
                <Text color={theme.textInvisible}>── sesión {sep.slice(10)}</Text>
                {info && (
                  <>
                    <Box>
                      <Text color={theme.textFaint}>{'  modelo    '}</Text>
                      {info.model ? (
                        <Text color={theme.textPrimary}>
                          {info.provider}
                          <Text color={theme.textFaint}> · </Text>
                          {info.model}
                        </Text>
                      ) : (
                        <Text color={theme.warning}>
                          {info.provider} · sin modelo
                          <Text color={theme.textMuted}> — /model para elegir uno</Text>
                        </Text>
                      )}
                    </Box>
                    <Box>
                      <Text color={theme.textFaint}>{'  carpeta   '}</Text>
                      <Text color={theme.textPrimary}>
                        {shortPath(info.cwd, Math.max(20, sepWidth - 12))}
                      </Text>
                    </Box>
                    {info.recent.length > 0 && (
                      <>
                        <Text color={theme.textInvisible}>── recientes {sep.slice(13)}</Text>
                        {info.recent.map((r) => (
                          <Box key={r.id}>
                            <Text color={theme.textFaint}>{`  ${r.when.padEnd(12)}`}</Text>
                            <Box flexGrow={1} flexShrink={1}>
                              <Text color={theme.textMuted} wrap="truncate-end">
                                {r.title}
                              </Text>
                            </Box>
                            <Text color={theme.textDisabled}>{`  ${r.id}`}</Text>
                          </Box>
                        ))}
                        <Text color={theme.textFaint}>
                          {'  '}
                          <Text color={theme.textMuted}>/sessions resume {'<id>'}</Text> para
                          continuar una
                        </Text>
                      </>
                    )}
                  </>
                )}
                <Text color={theme.textInvisible}>{sep}</Text>
                <Text color={theme.textFaint}>
                  {'  '}
                  <Text color={theme.textMuted}>/</Text> comandos ·{' '}
                  <Text color={theme.textMuted}>@</Text> perfiles ·{' '}
                  <Text color={theme.textMuted}>/help</Text> ayuda
                </Text>
                <Text> </Text>
              </>
            )}
            {paletteItems.length > 0 && (
              <CommandPalette items={paletteItems} selectedIndex={effPaletteIndex} />
            )}
            <Box>
              <Text color={theme.accent} bold>
                ❯❯{' '}
              </Text>
              <TextInput
                value={inputValue}
                onChange={handleChange}
                onSubmit={handleSubmit}
                placeholder="Escribe tu primer mensaje…"
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
