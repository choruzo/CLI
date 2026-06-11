import React from 'react';
import { Box, Static } from 'ink';
import { UserMessage } from './UserMessage.js';
import { AgentMessage } from './AgentMessage.js';
import type { ConvItem } from './App.js';

interface Props {
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  focusedBlockId?: string | null;
  expandedBlockIds?: ReadonlySet<string>;
}

function renderItem(
  item: ConvItem,
  key: string | number,
  focusedBlockId?: string | null,
  expandedBlockIds?: ReadonlySet<string>,
) {
  if (item.kind === 'user') {
    return <UserMessage key={key} text={item.text} />;
  }
  return (
    <AgentMessage
      key={key}
      text={item.text}
      toolCalls={item.toolCalls}
      streaming={item.streaming}
      focusedBlockId={focusedBlockId}
      expandedBlockIds={expandedBlockIds}
    />
  );
}

/**
 * Los items completados van a <Static> (render una sola vez, scrollback nativo)
 * EXCEPTO el último: se mantiene dinámico para que el usuario pueda navegar
 * sus tool call blocks con Tab y expandirlos con Space tras el `done` (§5.1).
 * Cuando llega un item nuevo, el anterior pasa a Static de forma natural.
 */
export function MessageList({
  completedItems,
  currentItem,
  focusedBlockId,
  expandedBlockIds,
}: Props) {
  const staticItems = completedItems.slice(0, -1);
  const lastCompleted = completedItems.length > 0 ? completedItems[completedItems.length - 1] : null;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Static items={staticItems}>{(item, i) => renderItem(item, i)}</Static>
      {lastCompleted &&
        renderItem(lastCompleted, 'last-completed', focusedBlockId, expandedBlockIds)}
      {currentItem && renderItem(currentItem, 'current', focusedBlockId, expandedBlockIds)}
    </Box>
  );
}
