import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { Banner } from './Banner.js';
import { ASCII_ART_FULL } from './ascii-art.js';

interface RenderedBanner {
  output: () => string;
  dispose: () => void;
}

function renderBanner(logoPreRendered: boolean): RenderedBanner {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  let output = '';

  Object.assign(stdout, { columns: 80, rows: 30, isTTY: true });
  Object.assign(stdin, { isTTY: true, setRawMode: () => {} });
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const instance = render(
    React.createElement(Banner, {
      version: 'test',
      onSend: () => {},
      logoPreRendered,
    }),
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      debug: false,
      patchConsole: false,
    },
  );

  return {
    output: () => output,
    dispose: () => {
      instance.unmount();
      instance.cleanup();
      stdout.destroy();
      stdin.destroy();
      stderr.destroy();
    },
  };
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

describe('Banner startup logo ownership', () => {
  it('does not render the logo when stdout already contains it', async () => {
    const banner = renderBanner(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      for (const row of ASCII_ART_FULL.split('\n')) {
        expect(banner.output()).not.toContain(row);
      }
    } finally {
      banner.dispose();
    }
  });

  it('renders the complete static logo exactly once in fallback mode', async () => {
    const banner = renderBanner(false);
    try {
      // Two subtitle-color updates prove that later Banner renders do not emit
      // the logo again because it belongs to Ink's permanent <Static> output.
      await new Promise((resolve) => setTimeout(resolve, 120));
      for (const row of ASCII_ART_FULL.split('\n')) {
        expect(countOccurrences(banner.output(), row)).toBe(1);
      }
    } finally {
      banner.dispose();
    }
  });
});
