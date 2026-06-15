import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  let sigintHandler: (() => void) | undefined;

  return {
    loadConfig: vi.fn(() => ({ mcp: { servers: [], heartbeatInterval: 30000 } })),
    registerBuiltinTools: vi.fn(),
    agentRun: vi.fn(),
    getContextUsage: vi.fn(() => ({ used: 1, max: 10, pct: 10 })),
    captureSigint(handler?: () => void) {
      sigintHandler = handler;
    },
    getSigint() {
      return sigintHandler;
    },
    reset() {
      sigintHandler = undefined;
      this.loadConfig.mockReset();
      this.loadConfig.mockImplementation(() => ({
        mcp: { servers: [], heartbeatInterval: 30000 },
      }));
      this.registerBuiltinTools.mockReset();
      this.agentRun.mockReset();
      this.getContextUsage.mockReset();
      this.getContextUsage.mockImplementation(() => ({ used: 1, max: 10, pct: 10 }));
    },
  };
});

vi.mock('../../config/loader.js', () => ({
  loadConfig: mockState.loadConfig,
}));

vi.mock('../../tools/index.js', () => ({
  registerBuiltinTools: mockState.registerBuiltinTools,
}));

vi.mock('../../tools/mcp/manager.js', () => ({
  McpManager: class McpManager {
    connectAll() {
      return Promise.resolve([]);
    }
    registerInto() {}
    startHeartbeat() {}
    shutdownAll() {
      return Promise.resolve();
    }
  },
}));

vi.mock('../../providers/router.js', () => ({
  ProviderRouter: class ProviderRouter {
    providerName = 'mock-provider';
    model = 'mock-model';
    contextWindow = 4096;

    constructor(_config: unknown, _provider?: string) {}

    getActive(): object {
      return {};
    }
  },
}));

vi.mock('../../agent/core.js', () => ({
  StratumAgent: class StratumAgent {
    constructor(_config: unknown, _router: unknown, _registry: unknown) {}

    run(input: string, opts?: unknown) {
      return mockState.agentRun(input, opts);
    }

    getContextUsage() {
      return mockState.getContextUsage();
    }
  },
}));

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('runCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockState.reset();
  });

  it('waits for done(cancelled) before exiting with code 130 after SIGINT', async () => {
    const gate = deferred<void>();
    mockState.agentRun.mockImplementationOnce(async function* (
      _task: string,
      opts?: { signal?: AbortSignal },
    ) {
      await gate.promise;
      if (opts?.signal?.aborted) {
        yield { type: 'done' as const, stopReason: 'cancelled' as const };
        return;
      }
      yield { type: 'done' as const, stopReason: 'stop' as const };
    });

    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT') {
        mockState.captureSigint(listener);
      }
      return process;
    }) as typeof process.on);

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new ExitError(Number(code ?? 0));
    }) as typeof process.exit);

    const { runCommand } = await import('./run.js');
    const action = runCommand.parseAsync(['demo-task'], { from: 'user' });

    const sigint = mockState.getSigint();
    expect(sigint).toBeTypeOf('function');

    sigint?.();
    expect(exitSpy).not.toHaveBeenCalled();

    gate.resolve();

    await expect(action).rejects.toMatchObject({ code: 130 });
    expect(stderrWrite).toHaveBeenCalledWith('\n[cancelled]\n');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('forces exit code 1 on a second SIGINT during cancellation', async () => {
    const gate = deferred<void>();
    mockState.agentRun.mockImplementationOnce(async function* (
      _task: string,
      opts?: { signal?: AbortSignal },
    ) {
      await gate.promise;
      if (opts?.signal?.aborted) {
        yield { type: 'done' as const, stopReason: 'cancelled' as const };
      }
    });

    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'SIGINT') {
        mockState.captureSigint(listener);
      }
      return process;
    }) as typeof process.on);

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new ExitError(Number(code ?? 0));
    }) as typeof process.exit);

    const { runCommand } = await import('./run.js');
    const action = runCommand.parseAsync(['demo-task'], { from: 'user' }).catch(() => undefined);

    const sigint = mockState.getSigint();
    expect(sigint).toBeTypeOf('function');

    sigint?.();
    expect(() => sigint?.()).toThrowError(new ExitError(1));

    gate.resolve();
    await action;

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
