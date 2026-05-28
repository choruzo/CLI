import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { theme } from './theme.js';

interface Props {
  text: string;
  streaming: boolean;
}

export function StreamingText({ text, streaming }: Props) {
  const [cursorVisible, setCursorVisible] = useState(true);

  useEffect(() => {
    if (!streaming) {
      setCursorVisible(false);
      return;
    }
    setCursorVisible(true);
    const iv = setInterval(() => setCursorVisible(v => !v), 500);
    return () => clearInterval(iv);
  }, [streaming]);

  return (
    <Text color={theme.textResponse} wrap="wrap">
      {text}
      {streaming && (
        <Text color={cursorVisible ? theme.accent : 'black'}>█</Text>
      )}
    </Text>
  );
}
