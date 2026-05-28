import React from 'react';
import { Box, Static } from 'ink';
import { UserMessage } from './UserMessage.js';
import { AgentMessage } from './AgentMessage.js';
import type { ConvItem } from './App.js';

interface Props {
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
}

function renderItem(item: ConvItem, key: string | number) {
  if (item.kind === 'user') {
    return <UserMessage key={key} text={item.text} />;
  }
  return (
    <AgentMessage
      key={key}
      text={item.text}
      toolCalls={item.toolCalls}
      streaming={item.streaming}
    />
  );
}

export function MessageList({ completedItems, currentItem }: Props) {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      <Static items={completedItems}>
        {(item, i) => renderItem(item, i)}
      </Static>
      {currentItem && renderItem(currentItem, 'current')}
    </Box>
  );
}
