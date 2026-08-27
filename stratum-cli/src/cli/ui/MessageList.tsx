import React from 'react';
import { Box, Static, useStdout } from 'ink';
import { UserMessage } from './UserMessage.js';
import { AgentMessage } from './AgentMessage.js';
import { resolveLayout } from './layout.js';
import type { ConvItem } from './App.js';

interface Props {
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  focusedBlockId?: string | null;
  expandedBlockIds?: ReadonlySet<string>;
  /** `/debug`: pinta los bloques `⊙ thinking` del agente (§11). */
  debug?: boolean;
}

function renderItem(
  item: ConvItem,
  key: string | number,
  focusedBlockId?: string | null,
  expandedBlockIds?: ReadonlySet<string>,
  debug?: boolean,
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
      thinkingBlocks={debug ? item.thinkingBlocks : undefined}
    />
  );
}

/**
 * Estrategia de scroll (§4.2): los items completados van a <Static> (render una
 * sola vez, scrollback nativo del terminal) EXCEPTO el último, que se mantiene
 * dinámico para que el usuario pueda navegar sus tool call blocks con Tab y
 * expandirlos con Space tras el `done` (§5.1). Cuando llega un item nuevo, el
 * anterior pasa a Static de forma natural.
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
}: Props) {
  const { stdout } = useStdout();
  // §9: en terminales anchas el contenido se limita para no leer líneas de 200 chars.
  const { contentWidth } = resolveLayout(stdout.columns ?? 80, stdout.rows ?? 24);

  const staticItems = completedItems.slice(0, -1);
  const lastCompleted =
    completedItems.length > 0 ? completedItems[completedItems.length - 1] : null;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} width={contentWidth}>
      <Static items={staticItems}>{(item, i) => renderItem(item, i)}</Static>
      {lastCompleted &&
        renderItem(lastCompleted, 'last-completed', focusedBlockId, expandedBlockIds, debug)}
      {currentItem && renderItem(currentItem, 'current', focusedBlockId, expandedBlockIds, debug)}
    </Box>
  );
}
