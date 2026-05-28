import React from 'react';
import { Box } from 'ink';
import { StatusBar } from './StatusBar.js';
import { MessageList } from './MessageList.js';
import { InputArea } from './InputArea.js';
import type { ConvItem } from './App.js';

interface Props {
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  inputValue: string;
  onInputChange: (value: string) => void;
  onInputSubmit: (value: string) => void;
  thinking: boolean;
  providerName: string;
  model: string;
  contextUsed: number;
  contextMax: number;
}

export function ConversationView({
  completedItems,
  currentItem,
  inputValue,
  onInputChange,
  onInputSubmit,
  thinking,
  providerName,
  model,
  contextUsed,
  contextMax,
}: Props) {
  return (
    <Box flexDirection="column" width="100%">
      <StatusBar
        providerName={providerName}
        model={model}
        contextUsed={contextUsed}
        contextMax={contextMax}
      />
      <MessageList completedItems={completedItems} currentItem={currentItem} />
      <InputArea
        value={inputValue}
        onChange={onInputChange}
        onSubmit={onInputSubmit}
        disabled={thinking}
      />
    </Box>
  );
}
