import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import { spinnerFrameAt } from './spinner.js';
import { formatInput } from './tool-arg-label.js';
import {
  cardLabel,
  cardSummary,
  diffLines,
  diffStats,
  diffTrailer,
  execSummary,
  toolIntent,
  type DiffLine,
} from './tool-card.js';

// Los importadores existentes (ThinkingIndicator…) siguen tomándolo de aquí.
export { formatInput } from './tool-arg-label.js';

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
const MAX_DIFF_LINES = 20;

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

/**
 * Primera línea de un error. Un `exec` que salió con código ≠ 0 trae su sobre
 * `<exec_result …>` entero: de él solo interesa cómo acabó, y lo que identifica
 * la llamada es el comando, como en una terminada bien.
 */
export function errorHeadline(state: ToolCallState): string {
  const msg = state.errorMsg ?? 'error';
  const envelope = /^<exec_result\b[^>]*\bstatus="([^"]*)"[^>]*\bexitCode="([^"]*)"/.exec(msg);
  if (envelope) {
    const [, status, code] = envelope;
    const outcome =
      status === 'timeout' ? 'timeout' : status === 'cancelled' ? 'cancelado' : `exit ${code}`;
    const label = formatInput(state);
    return label ? `${outcome} │ ${label}` : outcome;
  }
  return msg.split('\n')[0]?.slice(0, 80) ?? '';
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

function ExpandedOutput({ text, tail = false }: { text: string; tail?: boolean }) {
  const lines = text.split('\n');
  const visible = tail ? lines.slice(-MAX_EXPANDED_LINES) : lines.slice(0, MAX_EXPANDED_LINES);
  const hidden = lines.length - visible.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderSubtle}
      paddingX={1}
      marginLeft={2}
    >
      {tail && hidden > 0 && (
        <Text color={theme.textDisabled} dimColor>
          [+{hidden} líneas antes]
        </Text>
      )}
      {visible.map((line, i) => (
        <Text key={i} color={theme.textFaint} dimColor wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
      {!tail && hidden > 0 && (
        <Text color={theme.textDisabled} dimColor>
          [+{hidden} líneas más]
        </Text>
      )}
    </Box>
  );
}

/** Diff de `edit_file` coloreado: verde lo añadido, rojo lo quitado, tope MAX_DIFF_LINES. */
function DiffBody({ lines, trailer }: { lines: DiffLine[]; trailer: string }) {
  const visible = lines.slice(0, MAX_DIFF_LINES);
  const hidden = lines.length - visible.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.borderSubtle}
      paddingX={1}
      marginLeft={2}
    >
      {visible.map((line, i) => {
        const text =
          line.kind === 'add'
            ? `+${line.text}`
            : line.kind === 'del'
              ? `-${line.text}`
              : line.kind === 'ctx'
                ? ` ${line.text}`
                : line.text;
        const color =
          line.kind === 'add'
            ? theme.success
            : line.kind === 'del'
              ? theme.error
              : line.kind === 'hunk'
                ? theme.textDisabled
                : theme.textFaint;
        return (
          <Text key={i} color={color} wrap="truncate-end">
            {text || ' '}
          </Text>
        );
      })}
      {hidden > 0 && (
        <Text color={theme.textDisabled} dimColor>
          [+{hidden} líneas más]
        </Text>
      )}
      {trailer !== '' &&
        trailer
          .split('\n')
          .slice(0, 10)
          .map((line, i) => (
            <Text key={`t${i}`} color={theme.textFaint} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
    </Box>
  );
}

/** Cuerpo expandido según la intención: diff coloreado, terminal en cola, resto tal cual. */
function ExpandedBody({ state, text }: { state: ToolCallState; text: string }) {
  const intent = toolIntent(state.name);
  if (intent === 'diff') {
    const lines = diffLines(text);
    if (lines.length === 0) return <ExpandedOutput text={text} />;
    return <DiffBody lines={lines} trailer={diffTrailer(text)} />;
  }
  if (intent === 'terminal') {
    // Un exec a segundo plano no produce cuerpo: el sobre `<exec_job>` es lo que hay.
    if (text.trimStart().startsWith('<exec_job')) return <ExpandedOutput text={text} />;
    const body = execSummary(text).body;
    return body !== '' ? <ExpandedOutput text={body} tail /> : <ExpandedOutput text={text} />;
  }
  return <ExpandedOutput text={text} />;
}

export function ToolCallBlock({
  state,
  focused = false,
  expanded = false,
  now = Date.now(),
}: Props) {
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
        <Text color={theme.textFaint}> │ en cola…</Text>
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
          {(state.input ? cardLabel(state) : state.inputSoFar?.slice(0, 60)) ?? ''}
        </Text>
      </Box>
    );
  }

  if (state.status === 'completed') {
    const dur = state.durationMs !== undefined ? formatDuration(state.durationMs) : '';
    const label = cardLabel(state);
    const summary = cardSummary(state);
    const stats =
      summary !== null && state.output && toolIntent(state.name) === 'diff'
        ? diffStats(state.output)
        : null;
    // El diff se pinta partido (verde/rojo); el resto del resumen, de una pieza.
    const summaryNode = stats ? (
      <>
        <Text color={theme.success}>+{stats.added}</Text>
        <Text color={theme.error}> −{stats.removed}</Text>
        {stats.partial && <Text color={theme.textFaint}>…</Text>}
      </>
    ) : (
      summary
    );
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
          {summary !== null && (
            <Text color={theme.textFaint}> │ {summaryNode}</Text>
          )}
          {chevron}
        </Box>
        {expanded && state.output && <ExpandedBody state={state} text={state.output} />}
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
          │ {errorHeadline(state)}
        </Text>
        {chevron}
      </Box>
      {expanded && state.errorMsg && <ExpandedBody state={state} text={state.errorMsg} />}
    </Box>
  );
}
