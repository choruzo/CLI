import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { spinnerFrameAt } from './spinner.js';

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolCallState {
  id: string;
  name: string;
  status: ToolCallStatus;
  inputSoFar?: string;
  input?: Record<string, unknown>;
  output?: string;
  errorMsg?: string;
  durationMs?: number;
  /** Instante de transición a running; el reloj compartido calcula el elapsed. */
  startedAt?: number;
}

const MAX_EXPANDED_LINES = 10;

/** Umbral de latencia SSH que se resalta en el bloque (UI §5.8). */
const SLOW_MS = 1000;

/**
 * Alias del host remoto en las tools SSH (UI §5.8). Devuelve null mientras la
 * tool call se está parseando y `input` aún no existe: el bloque se renderiza
 * entonces sin prefijo, sin reservar hueco.
 */
function sshHostOf(state: ToolCallState): string | null {
  // Hito 16: `exec` sobre un target `ssh:<alias>` lleva el mismo prefijo.
  if (state.name === 'exec') {
    const target = state.input?.target;
    return typeof target === 'string' && target.startsWith('ssh:') && target.length > 4
      ? target.slice(4)
      : null;
  }
  if (!state.name.startsWith('ssh_')) return null;
  const host = state.input?.host;
  return typeof host === 'string' && host ? host : null;
}

function truncateLabel(value: string): string {
  return value.length > 50 ? value.slice(0, 47) + '...' : value;
}

function formatInput(state: ToolCallState): string {
  const src = state.input ?? {};
  const keys = Object.keys(src);
  if (keys.length === 0) return '';

  // `exec`: el target ya va en el prefijo; lo que identifica la llamada es el comando.
  if (state.name === 'exec' && typeof src.command === 'string') {
    return truncateLabel(src.command);
  }

  // Tools SSH (UI §5.8): la primera clave es siempre `host`, que ya va en el
  // prefijo. Mostrar en su lugar lo que de verdad identifica la operación.
  if (state.name.startsWith('ssh_')) {
    if (typeof src.command === 'string') return truncateLabel(src.command);
    const from = state.name === 'ssh_upload' ? src.localPath : src.remotePath;
    const to = state.name === 'ssh_upload' ? src.remotePath : src.localPath;
    if (typeof from === 'string' && typeof to === 'string') {
      return truncateLabel(`${from} → ${to}`);
    }
  }

  return truncateLabel(String(src[keys[0]!] ?? ''));
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Prefijo `⌗ alias` para las tools SSH. */
function HostTag({ alias }: { alias: string | null }) {
  if (!alias) return null;
  return <Text color={theme.accent}> ⌗ {alias}</Text>;
}

interface Props {
  state: ToolCallState;
  /** Bloque seleccionado con Tab (§5.1 focused): indicador ▶ ámbar. */
  focused?: boolean;
  /** Output expandido con Space (§5.1 expandido). */
  expanded?: boolean;
  /** Reloj compartido de la conversación. */
  now?: number;
}

function ExpandedOutput({ text }: { text: string }) {
  const lines = text.split('\n');
  const visible = lines.slice(0, MAX_EXPANDED_LINES);
  const hidden = lines.length - visible.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderSubtle}
      paddingX={1}
      marginLeft={2}
    >
      {visible.map((line, i) => (
        <Text key={i} color={theme.textFaint} dimColor wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
      {hidden > 0 && (
        <Text color={theme.textDisabled} dimColor>
          [+{hidden} more lines]
        </Text>
      )}
    </Box>
  );
}

export function ToolCallBlock({ state, focused = false, expanded = false, now = Date.now() }: Props) {
  const elapsedMs = state.startedAt ? Math.max(0, now - state.startedAt) : 0;

  const focusPrefix = focused ? <Text color={theme.accent}>▶ </Text> : null;
  const sshHost = sshHostOf(state);
  const expandable =
    (state.status === 'completed' && !!state.output) ||
    (state.status === 'error' && !!state.errorMsg);
  const chevron = expandable ? <Text color={theme.textFaint}> {expanded ? '▾' : '▸'}</Text> : null;

  if (state.status === 'pending') {
    return (
      <Box marginBottom={0}>
        {focusPrefix}
        <Text color={theme.textDisabled}>○ </Text>
        <Text color={theme.textFaint}>{state.name}</Text>
        <HostTag alias={sshHost} />
        <Text color={theme.textFaint}> │ en cola...</Text>
      </Box>
    );
  }

  if (state.status === 'running') {
    return (
      <Box marginBottom={0}>
        {focusPrefix}
        <Text color={theme.accent}>{spinnerFrameAt(now)} </Text>
        <Text color={theme.accent} bold>
          {state.name}
        </Text>
        <HostTag alias={sshHost} />
        <Text color={theme.textFaint}> │ {formatDuration(elapsedMs)} │ </Text>
        <Text color={theme.textFaint} dimColor>
          {(state.input ? formatInput(state) : state.inputSoFar?.slice(0, 60)) ?? ''}
        </Text>
      </Box>
    );
  }

  if (state.status === 'completed') {
    const dur = state.durationMs !== undefined ? formatDuration(state.durationMs) : '';
    const label = formatInput(state);
    // Indicador de latencia (UI §5.8): una operación remota lenta es
    // información operativa, no ruido.
    const slow = (state.durationMs ?? 0) > SLOW_MS;
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Box>
          {focusPrefix}
          <Text color={theme.success}>✓ </Text>
          <Text color={theme.accent} bold>
            {state.name}
          </Text>
          <HostTag alias={sshHost} />
          {dur && <Text color={slow ? theme.warning : theme.textFaint}> │ {dur}</Text>}
          {label && <Text color={theme.textFaint}> │ {label}</Text>}
          {chevron}
        </Box>
        {expanded && state.output && <ExpandedOutput text={state.output} />}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        {focusPrefix}
        <Text color={theme.error}>✗ </Text>
        <Text color={theme.errorMuted} bold>
          {state.name}
        </Text>
        <HostTag alias={sshHost} />
        <Text color={theme.errorMuted} dimColor>
          {' '}
          │ {(state.errorMsg ?? 'error').split('\n')[0]?.slice(0, 80)}
        </Text>
        {chevron}
      </Box>
      {expanded && state.errorMsg && <ExpandedOutput text={state.errorMsg} />}
    </Box>
  );
}
