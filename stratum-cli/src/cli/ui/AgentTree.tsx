import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.js';
import type { SubagentBlockState } from './SubagentBlock.js';
import type { ToolCallState } from './ToolCallBlock.js';
import { spinnerFrameAt } from './spinner.js';

/**
 * Árbol vivo de subagentes en paralelo (Hito 8C, §5.6). Sustituye al grupo de
 * `<SubagentBlock>` cuando en un mismo turno se delega más de una subtarea: los
 * hijos corren acotados por el semáforo (`maxConcurrency`) y emiten eventos
 * entrelazados que el reducer desanida por `subagentId`. Con un solo subagente
 * NO se monta este árbol (se usa `<SubagentBlock>`, §5.5).
 */

const TERMINAL: ReadonlySet<SubagentBlockState['status']> = new Set([
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'interrupted',
]);

function fmtDur(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function firstArg(tc: ToolCallState): string {
  const src = tc.input ?? {};
  const keys = Object.keys(src);
  if (keys.length === 0) return '';
  return truncate(String(src[keys[0]!] ?? ''), 40);
}

/** Línea compacta de un tool call interno del hijo (icono + name: primer arg). */
function ToolLine({ tc }: { tc: ToolCallState }) {
  const icon = tc.status === 'completed' ? '✓' : tc.status === 'error' ? '✗' : '⟳';
  const color =
    tc.status === 'completed'
      ? theme.success
      : tc.status === 'error'
        ? theme.error
        : theme.textFaint;
  const arg = firstArg(tc);
  return (
    <Text color={theme.textFaint} wrap="truncate-end">
      {'      '}
      <Text color={color}>{icon}</Text> {tc.name}
      {arg ? <Text color={theme.textDisabled}>: {arg}</Text> : null}
    </Text>
  );
}

interface NodeProps {
  node: SubagentBlockState;
  speaking: boolean;
  focused: boolean;
  expanded: boolean;
  isLast: boolean;
  now: number;
}

function nodeIcon(status: SubagentBlockState['status']): { icon: string; color: string } {
  switch (status) {
    case 'queued':
      return { icon: '⋯', color: theme.textDisabled };
    case 'completed':
      return { icon: '✓', color: theme.success };
    case 'failed':
      return { icon: '✗', color: theme.error };
    case 'budget_exceeded':
      return { icon: '⏱', color: theme.warning };
    case 'cancelled':
      return { icon: '⊘', color: theme.textDisabled };
    case 'interrupted':
      return { icon: '⚠', color: theme.warning };
    default:
      return { icon: '⊳', color: theme.accent };
  }
}

function SubagentNode({ node, speaking, focused, expanded, isLast, now }: NodeProps) {
  const running = node.status === 'running';
  const elapsedMs = node.startedAt ? Math.max(0, now - node.startedAt) : 0;

  const { icon, color } = nodeIcon(node.status);
  const branch = isLast ? '└─' : '├─';
  const marker = speaking ? '▶' : ' ';
  const spinner = running ? spinnerFrameAt(now) : icon;

  const meta =
    node.status === 'queued'
      ? 'en cola'
      : running
        ? `${fmtDur(elapsedMs)}${node.iterations ? ` · ${node.iterations} it` : ''}`
        : [
            node.durationMs !== undefined ? fmtDur(node.durationMs) : '',
            node.iterations !== undefined ? `${node.iterations} it` : '',
          ]
            .filter(Boolean)
            .join(' · ');

  const tail =
    node.status === 'failed' && node.error
      ? truncate(node.error, 44)
      : node.status === 'completed' && node.summary
        ? truncate(node.summary, 44)
        : truncate(node.task, 44);

  const tcs = node.toolCalls ?? [];
  const files = node.filesChanged ?? [];

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color={theme.textFaint}>{branch}</Text>
        <Text color={theme.accentBright ?? theme.accent}>{marker}</Text>
        <Text color={color}> {spinner} </Text>
        <Text color={theme.accent} bold>
          ⊳ {node.profile}#{node.n ?? '?'}
        </Text>
        <Text color={theme.textFaint}>
          {meta ? ` │ ${meta}` : ''} │ {tail}
        </Text>
        {focused ? <Text color={theme.accent}> ◀</Text> : null}
      </Text>
      {/* Tool calls internos indentados bajo el nodo (no se muestra text_delta). */}
      {tcs.map((tc) => (
        <ToolLine key={tc.id} tc={tc} />
      ))}
      {expanded && node.summary && (
        <Text color={theme.textFaint} wrap="truncate-end">
          {'      '}
          {truncate(node.summary, 80)}
        </Text>
      )}
      {expanded &&
        files.map((f, i) => (
          <Text key={i} color={theme.textFaint} wrap="truncate-end">
            {'      · '}
            {f.action} {f.path}
          </Text>
        ))}
      {expanded && node.error && (
        <Text color={theme.errorMuted}>
          {'      error: '}
          {truncate(node.error, 80)}
        </Text>
      )}
    </Box>
  );
}

interface Props {
  nodes: SubagentBlockState[];
  speakingId?: string | null;
  maxConcurrency: number;
  focusedBlockId?: string | null;
  expandedBlockIds?: ReadonlySet<string>;
  now?: number;
}

export function AgentTree({
  nodes,
  speakingId,
  maxConcurrency,
  focusedBlockId,
  expandedBlockIds,
  now = Date.now(),
}: Props) {
  const allTerminal = nodes.every((n) => TERMINAL.has(n.status));

  if (allTerminal) {
    // Resumen agregado colapsado (patrón <PlanView>/<InitProgressBlock>, §5.6).
    const completed = nodes.filter((n) => n.status === 'completed').length;
    const failed = nodes.filter((n) => n.status === 'failed').length;
    const filesTouched = new Set<string>();
    for (const n of nodes) for (const f of n.filesChanged ?? []) filesTouched.add(f.path);
    const parts = [
      `${nodes.length} subagentes`,
      `${completed} completado${completed === 1 ? '' : 's'}`,
    ];
    if (failed > 0) parts.push(`${failed} fallido${failed === 1 ? '' : 's'}`);
    if (filesTouched.size > 0)
      parts.push(
        `${filesTouched.size} fichero${filesTouched.size === 1 ? '' : 's'} tocado${filesTouched.size === 1 ? '' : 's'}`,
      );
    return (
      <Box>
        <Text color={failed > 0 ? theme.warning : theme.success}>
          {failed > 0 ? '⚠' : '✓'} {parts.join(' · ')}
        </Text>
      </Box>
    );
  }

  const active = nodes.filter((n) => n.status === 'running').length;
  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold>
        ◮ delegando {nodes.length} subagentes
        <Text color={theme.textFaint} bold={false}>
          {' · '}
          {active}/{nodes.length} activos (maxConcurrency {maxConcurrency})
        </Text>
      </Text>
      {nodes.map((n, i) => (
        <SubagentNode
          key={n.id}
          node={n}
          speaking={n.id === speakingId}
          focused={focusedBlockId === n.id}
          expanded={expandedBlockIds?.has(n.id) ?? false}
          isLast={i === nodes.length - 1}
          now={now}
        />
      ))}
    </Box>
  );
}
