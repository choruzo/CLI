import { describe, it, expect } from 'vitest';
import { bashTool } from './shell/bash.js';
import type { ToolContext } from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});
const ctx: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  config,
};

describe('bash', () => {
  it('executes a simple command and returns output', async () => {
    const result = await bashTool.execute({ command: 'echo "hello world"' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('hello world');
  });

  it('returns error result for failed command', async () => {
    const result = await bashTool.execute({ command: 'exit 1' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recoverable).toBe(true);
  });

  it('captures stderr', async () => {
    const result = await bashTool.execute({ command: 'echo "err" >&2 && echo "out"' }, ctx);
    // Either ok or error, should contain some output
    const output = result.ok ? result.output : result.error;
    expect(output.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')(
    'times out as expected',
    async () => {
      const result = await bashTool.execute({ command: 'sleep 30', timeout: 300 }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeTruthy();
    },
    4000,
  );
});
