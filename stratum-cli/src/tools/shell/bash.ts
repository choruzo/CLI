import { z } from 'zod';
import { execa } from 'execa';
import type { ToolDefinition, ToolContext, ToolResult } from '../../agent/types.js';

const schema = z.object({
  command: z.string().describe('Shell command to execute'),
  timeout: z.number().int().positive().optional().describe('Timeout in milliseconds'),
});

const SHELL: string | boolean = process.platform === 'win32' ? 'pwsh.exe' : true;

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Execute a shell command and return stdout and stderr. Timeouts after 30s by default.',
  schema,
  destructive: false,
  serialized: true,

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { command, timeout } = schema.parse(params);
    const timeoutMs = timeout ?? ctx.config.tools.bashTimeout;

    try {
      const result = await execa(command, {
        shell: SHELL,
        timeout: timeoutMs,
        forceKillAfterDelay: 500,
        cancelSignal: ctx.signal,
        all: true,
        reject: false,
        cwd: ctx.cwd,
      });

      const output = result.all ?? result.stdout ?? '';
      const stderr = result.stderr;
      const exitCode = result.exitCode;

      let text = output;
      if (stderr && stderr !== output) text += (text ? '\n' : '') + stderr;
      if (exitCode !== 0) {
        text += `\n[exit code: ${exitCode}]`;
        return { ok: false, error: text.trim(), recoverable: true };
      }

      return { ok: true, output: text.trim() || '(no output)' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg, recoverable: true };
    }
  },
};
