import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { MessageList } from './MessageList.js';
import type { ConvItem } from './App.js';

const waitForInk = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('MessageList live render budget', () => {
  it('does not rewrite accumulated static history when a long stream advances', async () => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const writes: string[] = [];
    Object.assign(stdout, { columns: 60, rows: 12, isTTY: true });
    Object.assign(stdin, { isTTY: true, setRawMode: () => {} });
    stdout.on('data', (chunk: Buffer) => writes.push(chunk.toString()));

    const completedItems: ConvItem[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'agent' as const,
      text: `STATIC-HISTORY-${i} ${'x'.repeat(180)}`,
      toolCalls: [],
      streaming: false,
    }));
    const current = (text: string): ConvItem => ({
      kind: 'agent',
      text,
      toolCalls: [],
      streaming: true,
    });
    const view = (text: string) =>
      React.createElement(MessageList, {
        completedItems,
        currentItem: current(text),
      });

    const instance = render(view('a'.repeat(10_000)), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
    });

    try {
      await waitForInk();
      writes.length = 0;
      instance.rerender(view('b'.repeat(12_000)));
      await waitForInk();

      const incrementalOutput = writes.join('');
      expect(incrementalOutput).not.toContain('STATIC-HISTORY-0');
      expect(incrementalOutput.length).toBeLessThan(5_000);
    } finally {
      instance.unmount();
      instance.cleanup();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
    }
  });
});
