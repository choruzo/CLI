import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, ToolDispatcher, describeCall } from './registry.js';
import { commandIsDestructive } from './shell/bash.js';
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  DestructiveDecision,
} from '../agent/types.js';
import { StratumConfigSchema } from '../config/schema.js';

const config = StratumConfigSchema.parse({});

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    signal: new AbortController().signal,
    cwd: process.cwd(),
    config,
    ...overrides,
  };
}

function makeDestructiveTool(executeImpl?: () => Promise<ToolResult>): ToolDefinition {
  return {
    name: 'nuke',
    description: 'destructive test tool',
    schema: z.object({ target: z.string() }),
    destructive: true,
    execute: executeImpl ?? (async () => ({ ok: true, output: 'boom executed' })),
  };
}

// ---------------------------------------------------------------------------
// commandIsDestructive — safety check de bash (§12.5)
// ---------------------------------------------------------------------------

describe('commandIsDestructive', () => {
  const patterns = config.tools.destructivePatterns;

  it.each([
    'rm -rf /tmp/x',
    'sudo rm file.txt',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs -t ext4 /dev/sdb1',
    'echo done && rm -r build',
    'psql -c "DROP TABLE users"',
  ])('detects: %s', (cmd) => {
    expect(commandIsDestructive(cmd, patterns)).toBe(true);
  });

  it.each([
    'ls -la',
    'npm run build',
    'git status',
    'grep -r "rmdir_helper" src/', // substring, no palabra completa
    'echo formidable', // "format" como substring
    'cat readme.md',
  ])('does not flag: %s', (cmd) => {
    expect(commandIsDestructive(cmd, patterns)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Confirmación en el dispatcher
// ---------------------------------------------------------------------------

describe('ToolDispatcher destructive confirmation', () => {
  const call = { id: 'c1', name: 'nuke', input: { target: 'x' } };

  it('blocks with policy deny and injects recoverable error', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);

    const results = await dispatcher.dispatch([call], makeCtx({ destructivePolicy: 'deny' }));
    expect(results[0]!.result.ok).toBe(false);
    if (!results[0]!.result.ok) {
      expect(results[0]!.result.recoverable).toBe(true);
      expect(results[0]!.result.error).toContain('blocked');
    }
  });

  it('blocks with policy ask but no callback (CI/piped mode)', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);

    const results = await dispatcher.dispatch([call], makeCtx({ destructivePolicy: 'ask' }));
    expect(results[0]!.result.ok).toBe(false);
  });

  it('executes with policy allow without asking', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);
    const confirm = vi.fn();

    const results = await dispatcher.dispatch(
      [call],
      makeCtx({ destructivePolicy: 'allow', confirmDestructive: confirm }),
    );
    expect(results[0]!.result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('executes when the user approves', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'approve');

    const results = await dispatcher.dispatch(
      [call],
      makeCtx({ destructivePolicy: 'ask', confirmDestructive: confirm }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(results[0]!.result.ok).toBe(true);
  });

  it('injects user denial as recoverable error', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'deny');

    const results = await dispatcher.dispatch(
      [call],
      makeCtx({ destructivePolicy: 'ask', confirmDestructive: confirm }),
    );
    expect(results[0]!.result.ok).toBe(false);
    if (!results[0]!.result.ok) {
      expect(results[0]!.result.error).toContain('User denied');
      expect(results[0]!.result.recoverable).toBe(true);
    }
  });

  it('allow-all suppresses subsequent confirmations in the session', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'allow-all');
    const ctx = makeCtx({ destructivePolicy: 'ask', confirmDestructive: confirm });

    const first = await dispatcher.dispatch([call], ctx);
    expect(first[0]!.result.ok).toBe(true);

    const second = await dispatcher.dispatch([{ ...call, id: 'c2' }], ctx);
    expect(second[0]!.result.ok).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('skips confirmation entirely when confirmDestructive=false in config', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    const dispatcher = new ToolDispatcher(registry);
    const confirm = vi.fn();
    const noConfirmConfig = StratumConfigSchema.parse({ tools: { confirmDestructive: false } });

    const results = await dispatcher.dispatch(
      [call],
      makeCtx({ config: noConfirmConfig, destructivePolicy: 'ask', confirmDestructive: confirm }),
    );
    expect(results[0]!.result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('uses isDestructive predicate for dynamic detection (bash)', async () => {
    const registry = new ToolRegistry();
    const fakeBash: ToolDefinition = {
      name: 'bash',
      description: 'test bash',
      schema: z.object({ command: z.string() }),
      destructive: false,
      isDestructive: (params, ctx) =>
        commandIsDestructive(
          (params as { command: string }).command,
          ctx.config.tools.destructivePatterns,
        ),
      execute: async () => ({ ok: true, output: 'ran' }),
    };
    registry.register(fakeBash);
    const dispatcher = new ToolDispatcher(registry);
    const confirm = vi.fn(async (): Promise<DestructiveDecision> => 'deny');
    const ctx = makeCtx({ destructivePolicy: 'ask', confirmDestructive: confirm });

    const safe = await dispatcher.dispatch(
      [{ id: 's1', name: 'bash', input: { command: 'ls -la' } }],
      ctx,
    );
    expect(safe[0]!.result.ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    const dangerous = await dispatcher.dispatch(
      [{ id: 'd1', name: 'bash', input: { command: 'rm -rf /' } }],
      ctx,
    );
    expect(dangerous[0]!.result.ok).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it('preserves original call order with mixed denied/approved calls', async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool());
    registry.register({
      name: 'safe',
      description: 'safe tool',
      schema: z.object({}),
      execute: async () => ({ ok: true, output: 'safe ok' }),
    });
    const dispatcher = new ToolDispatcher(registry);
    const ctx = makeCtx({ destructivePolicy: 'deny' });

    const results = await dispatcher.dispatch(
      [
        { id: 'a', name: 'safe', input: {} },
        { id: 'b', name: 'nuke', input: { target: 'x' } },
        { id: 'c', name: 'safe', input: {} },
      ],
      ctx,
    );
    expect(results.map((r) => r.callId)).toEqual(['a', 'b', 'c']);
    expect(results[0]!.result.ok).toBe(true);
    expect(results[1]!.result.ok).toBe(false);
    expect(results[2]!.result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Timeout y cancelación
// ---------------------------------------------------------------------------

describe('ToolDispatcher timeout & cancellation', () => {
  it('aborts a tool that exceeds its timeout', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow',
      description: 'never finishes',
      schema: z.object({}),
      timeout: 50,
      execute: () => new Promise<ToolResult>(() => undefined), // nunca resuelve
    });
    const dispatcher = new ToolDispatcher(registry);

    const results = await dispatcher.dispatch([{ id: 't1', name: 'slow', input: {} }], makeCtx());
    expect(results[0]!.result.ok).toBe(false);
    if (!results[0]!.result.ok) expect(results[0]!.result.error).toContain('timed out');
  });

  it('passes an AbortSignal that fires on timeout so tools can clean up', async () => {
    const registry = new ToolRegistry();
    let receivedSignal: AbortSignal | null = null;
    registry.register({
      name: 'observer',
      description: 'observes its signal',
      schema: z.object({}),
      timeout: 50,
      execute: (_params, ctx) =>
        new Promise<ToolResult>((resolve) => {
          receivedSignal = ctx.signal;
          ctx.signal.addEventListener('abort', () =>
            resolve({ ok: false, error: 'aborted internally', recoverable: true }),
          );
        }),
    });
    const dispatcher = new ToolDispatcher(registry);

    await dispatcher.dispatch([{ id: 'o1', name: 'observer', input: {} }], makeCtx());
    expect(receivedSignal).not.toBeNull();
    expect((receivedSignal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('cancels execution when the user signal aborts', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'cancellable',
      description: 'waits forever',
      schema: z.object({}),
      timeout: 10000,
      execute: () => new Promise<ToolResult>(() => undefined),
    });
    const dispatcher = new ToolDispatcher(registry);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const results = await dispatcher.dispatch(
      [{ id: 'x1', name: 'cancellable', input: {} }],
      makeCtx({ signal: controller.signal }),
    );
    expect(results[0]!.result.ok).toBe(false);
  });
});

describe('describeCall', () => {
  it('shows the full command for bash', () => {
    expect(describeCall({ id: '1', name: 'bash', input: { command: 'rm -rf /tmp' } })).toBe(
      'bash: rm -rf /tmp',
    );
  });

  it('compacts other tools to json', () => {
    expect(describeCall({ id: '1', name: 'nuke', input: { target: 'x' } })).toBe(
      'nuke: {"target":"x"}',
    );
  });
});
