import React from 'react';
import { Box, Static, useStdout } from 'ink';
import { UserMessage } from './UserMessage.js';
import { AgentMessage } from './AgentMessage.js';
import { resolveLayout } from './layout.js';
import type { ConvItem } from './App.js';
import { ToolCallBlock, type ToolCallState } from './ToolCallBlock.js';
import { SubagentBlock, type SubagentBlockState } from './SubagentBlock.js';

interface Props {
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  focusedBlockId?: string | null;
  expandedBlockIds?: ReadonlySet<string>;
  /** `/debug`: pinta los bloques `⊙ thinking` del agente (§11). */
  debug?: boolean;
  /** Reloj único compartido por todas las acciones vivas. */
  now?: number;
  /** Filas disponibles tras descontar paneles pinned. */
  availableRows?: number;
}

function renderItem(
  item: ConvItem,
  key: string | number,
  focusedBlockId?: string | null,
  expandedBlockIds?: ReadonlySet<string>,
  debug?: boolean,
  now?: number,
  liveTextLines?: number,
  liveColumns?: number,
  liveActionLimit?: number,
) {
  if (item.kind === 'user') {
    return <UserMessage key={key} text={item.text} />;
  }
  return (
    <AgentMessage
      key={key}
      text={item.text}
      toolCalls={item.toolCalls}
      subagents={item.subagents}
      speakingSubagentId={item.speakingSubagentId}
      maxConcurrency={item.maxConcurrency}
      streaming={item.streaming}
      focusedBlockId={focusedBlockId}
      expandedBlockIds={expandedBlockIds}
      initSteps={item.initSteps}
      initSummary={item.initSummary}
      thinkingBlocks={item.thinkingBlocks}
      thinkingOpen={item.thinkingOpen}
      debug={debug}
      now={now}
      liveTextLines={liveTextLines}
      liveColumns={liveColumns}
      liveActionLimit={liveActionLimit}
    />
  );
}

function findInspectableBlock(
  completedItems: ConvItem[],
  focusedBlockId?: string | null,
  expandedBlockIds?: ReadonlySet<string>,
): ToolCallState | SubagentBlockState | null {
  const wantedId = focusedBlockId ?? [...(expandedBlockIds ?? [])].at(-1);
  if (!wantedId) return null;
  for (let i = completedItems.length - 1; i >= 0; i--) {
    const item = completedItems[i];
    if (item?.kind !== 'agent') continue;
    const block = [...item.toolCalls, ...(item.subagents ?? [])].find((b) => b.id === wantedId);
    if (block) return block;
  }
  return null;
}

/**
 * Estrategia de scroll (§4.2): los items completados van a <Static> (render una
 * sola vez, scrollback nativo del terminal). La navegación del último turno se
 * conserva con un inspector dinámico que solo monta el bloque enfocado; nunca
 * vuelve a montar el cuerpo completo del mensaje terminado.
 *
 * El scroll del historial lo hace el terminal, no la aplicación: por eso no hay
 * ventana virtual ni manejo de PgUp/PgDn aquí.
 */
export function MessageList({
  completedItems,
  currentItem,
  focusedBlockId,
  expandedBlockIds,
  debug,
  now = Date.now(),
  availableRows,
}: Props) {
  const { stdout } = useStdout();
  // §9: en terminales anchas el contenido se limita para no leer líneas de 200 chars.
  const { contentWidth } = resolveLayout(stdout.columns ?? 80, stdout.rows ?? 24);

  const terminalRows = availableRows ?? stdout.rows ?? 24;
  const liveActionLimit = Math.max(1, Math.min(6, Math.floor((terminalRows - 8) / 2)));
  const liveActions =
    currentItem?.kind === 'agent'
      ? Math.min(
          currentItem.toolCalls.length + (currentItem.subagents?.length ?? 0),
          liveActionLimit,
        )
      : 0;
  const liveTextLines = Math.max(2, terminalRows - 8 - liveActions);
  const inspectable = findInspectableBlock(completedItems, focusedBlockId, expandedBlockIds);
  const inspectExpanded = inspectable ? (expandedBlockIds?.has(inspectable.id) ?? false) : false;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} width={contentWidth}>
      <Static items={completedItems}>{(item, i) => renderItem(item, i)}</Static>
      {inspectable && 'name' in inspectable ? (
        <ToolCallBlock
          state={inspectable}
          focused={focusedBlockId === inspectable.id}
          expanded={inspectExpanded}
          now={now}
        />
      ) : inspectable ? (
        <SubagentBlock
          state={inspectable}
          focused={focusedBlockId === inspectable.id}
          expanded={inspectExpanded}
          now={now}
        />
      ) : null}
      {currentItem &&
        renderItem(
          currentItem,
          'current',
          focusedBlockId,
          expandedBlockIds,
          debug,
          now,
          liveTextLines,
          contentWidth,
          liveActionLimit,
        )}
    </Box>
  );
}
