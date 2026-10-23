import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  let sigintHandler: (() => void) | undefined;

  return {
    loadConfig: vi.fn(() => ({ mcp: { servers: [], heartbeatInterval: 30000 } })),
    registerBuiltinTools: vi.fn(),
    agentRun: vi.fn(),
    getContextUsage: vi.fn(() => ({ used: 1, max: 10, pct: 10 })),
    sessionUsage: vi.fn(() => ({
      llmCalls: 1,
      reportedCalls: 1,
      promptTokens: 1200,
      completionTokens: 80,
      llmMs: 500,
      toolMs: 10,
      turns: 1,
      costUsd: 0.0048,
    })),
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
      this.sessionUsage.mockReset();
      this.sessionUsage.mockImplementation(() => ({
        llmCalls: 1,
        reportedCalls: 1,
        promptTokens: 1200,
        completionTokens: 80,
        llmMs: 500,
        toolMs: 10,
        turns: 1,
        costUsd: 0.0048,
      }));
    },
  };
});

vi.mock('../../config/loader.js', () => ({
  loadConfig: mockState.loadConfig,
  takeConfigDeprecations: () => [],
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
    // La pausa cooperativa: `run` se suscribe para avisar por stderr.
    pause = { subscribe: () => () => undefined };

    constructor(_config: unknown, _router: unknown, _registry: unknown) {}

    run(input: string, opts?: unknown) {
      return mockState.agentRun(input, opts);
    }

    getContextUsage() {
      return mockState.getContextUsage();
    }

    getSessionUsage() {
      return mockState.sessionUsage();
    }

    getActiveProfile() {
      return null;
    }

    async cancelBackgroundWork() {}
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

    // `run` registra el handler tras varias esperas (config, MCP, logging):
    // leerlo en el acto era una carrera que fallaba bajo la carga de la suite.
    const sigint = await vi.waitFor(() => {
      const listener = mockState.getSigint();
      expect(listener).toBeTypeOf('function');
      return listener;
    });

    sigint?.();
    expect(exitSpy).not.toHaveBeenCalled();

    gate.resolve();

    await expect(action).rejects.toMatchObject({ code: 130 });
    expect(stderrWrite).toHaveBeenCalledWith('\n[cancelled]\n');
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('un segundo Ctrl+C sale en el acto con 130', async () => {
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

    // `run` registra el handler tras varias esperas (config, MCP, logging):
    // leerlo en el acto era una carrera que fallaba bajo la carga de la suite.
    const sigint = await vi.waitFor(() => {
      const listener = mockState.getSigint();
      expect(listener).toBeTypeOf('function');
      return listener;
    });

    sigint?.();
    // Segundo Ctrl+C: sale en el acto, con el mismo código que el primero (130).
    expect(() => sigint?.()).toThrowError(new ExitError(130));

    gate.resolve();
    await action;

    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('sale con código 1 si el turno termina con un error fatal', async () => {
    // Un provider caído (fallback agotado) acaba en error{fatal} + done: antes
    // el proceso salía con 0 y un script que encadena `stratum run` lo daba
    // por bueno.
    mockState.agentRun.mockImplementationOnce(async function* () {
      yield { type: 'text_delta' as const, delta: 'texto a medias' };
      yield { type: 'error' as const, message: 'LLM API error 500', fatal: true };
      yield { type: 'done' as const, stopReason: 'error' as const };
    });
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(Number(code ?? 0));
    }) as typeof process.exit);

    const { runCommand } = await import('./run.js');
    await expect(runCommand.parseAsync(['demo-task'], { from: 'user' })).rejects.toMatchObject({
      code: 1,
    });
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('LLM API error 500'));
  });

  it('un error no fatal no cambia el código de salida', async () => {
    mockState.agentRun.mockImplementationOnce(async function* () {
      yield { type: 'error' as const, message: 'tool falló', fatal: false };
      yield { type: 'text_delta' as const, delta: 'respuesta' };
      yield { type: 'done' as const, stopReason: 'stop' as const };
    });
    vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new ExitError(Number(code ?? 0));
    }) as typeof process.exit);

    const { runCommand } = await import('./run.js');
    await runCommand.parseAsync(['demo-task'], { from: 'user' });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rechaza --delegate combinado con --plan antes de cargar la config (Hito 15)', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(Number(code ?? 0));
    }) as typeof process.exit);

    const { runCommand } = await import('./run.js');
    await expect(
      runCommand.parseAsync(['demo-task', '--delegate', 'code', '--plan'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 1 });
    expect(mockState.loadConfig).not.toHaveBeenCalled();
    expect(mockState.agentRun).not.toHaveBeenCalled();
  });
});

/** Lo escrito por stdout, troceado en líneas no vacías. */
function stdoutLines(write: { mock: { calls: unknown[][] } }): string[] {
  return write.mock.calls
    .map((c) => String(c[0]))
    .join('')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function setupProcess() {
  vi.spyOn(process, 'on').mockImplementation((() => process) as typeof process.on);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new ExitError(Number(code ?? 0));
  }) as typeof process.exit);
  return { stdout, stderr, exit };
}

function textRound(text: string) {
  return async function* () {
    yield { type: 'text_delta' as const, delta: text };
    yield { type: 'done' as const, stopReason: 'stop' as const };
  };
}

describe('runCommand — --output-format (UX-3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockState.reset();
  });

  it('stream-json: stdout solo lleva JSON Lines y la última línea es el `result`', async () => {
    mockState.agentRun.mockImplementationOnce(async function* () {
      yield { type: 'tool_call_start' as const, id: 'c1', name: 'read_file', input_so_far: '{}' };
      yield { type: 'tool_result' as const, id: 'c1', name: 'read_file', result: '{}' };
      yield { type: 'text_delta' as const, delta: 'respuesta final' };
      yield { type: 'done' as const, stopReason: 'stop' as const };
    } as never);
    const { stdout, stderr, exit } = setupProcess();

    const { runCommand } = await import('./run.js');
    await runCommand.parseAsync(['demo-task', '--output-format', 'stream-json'], { from: 'user' });

    const lines = stdoutLines(stdout);
    // Todas y cada una de las líneas son JSON válido.
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toHaveLength(5);
    expect(parsed.filter((p) => p['type'] === 'result')).toHaveLength(1);
    const result = parsed.at(-1)!;
    expect(result).toMatchObject({
      type: 'result',
      stopReason: 'stop',
      text: 'respuesta final',
      sessionId: expect.any(String),
    });
    expect(result['usage']).toMatchObject({ turns: 1, costUsd: 0.0048 });
    // Lo humano (tools, duraciones) va por stderr, no por stdout.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[tool] read_file'));
    expect(lines.some((l) => l.includes('[tool]'))).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('json: un único objeto por stdout, con `events` y sin nada más', async () => {
    mockState.agentRun.mockImplementationOnce(async function* () {
      yield { type: 'text_delta' as const, delta: 'hola' };
      yield { type: 'error' as const, message: 'tool falló', fatal: false };
      yield { type: 'done' as const, stopReason: 'stop' as const };
    });
    const { stdout, exit } = setupProcess();

    const { runCommand } = await import('./run.js');
    await runCommand.parseAsync(['demo-task', '--output-format', 'json'], { from: 'user' });

    const lines = stdoutLines(stdout);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'result',
      stopReason: 'stop',
      text: 'hola',
      events: 3,
      sessionId: expect.any(String),
    });
    expect(payload['usage']).toMatchObject({ turns: 1 });
    // Sin `--then` no hay array de turnos.
    expect(payload).not.toHaveProperty('turns');
    expect(exit).not.toHaveBeenCalled();
  });

  it('json con --then: un `result` por turno en `turns`', async () => {
    mockState.agentRun
      .mockImplementationOnce(textRound('uno'))
      .mockImplementationOnce(textRound('dos'));
    const { stdout } = setupProcess();

    const { runCommand } = await import('./run.js');
    await runCommand.parseAsync(['demo-task', '--output-format', 'json', '--then', 'sigue'], {
      from: 'user',
    });

    expect(mockState.agentRun).toHaveBeenCalledTimes(2);
    const lines = stdoutLines(stdout);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { turns: Array<Record<string, unknown>> };
    expect(payload.turns).toHaveLength(2);
    expect(payload.turns[0]).toMatchObject({ type: 'result', stopReason: 'stop', text: 'uno' });
    expect(payload.turns[1]).toMatchObject({ type: 'result', stopReason: 'stop', text: 'dos' });
  });

  it('stream-json con --then: una línea `result` por turno', async () => {
    mockState.agentRun
      .mockImplementationOnce(textRound('uno'))
      .mockImplementationOnce(textRound('dos'));
    const { stdout } = setupProcess();

    const { runCommand } = await import('./run.js');
    await runCommand.parseAsync(
      ['demo-task', '--output-format', 'stream-json', '--then', 'sigue'],
      { from: 'user' },
    );

    const parsed = stdoutLines(stdout).map((l) => JSON.parse(l) as Record<string, unknown>);
    const results = parsed.filter((p) => p['type'] === 'result');
    expect(results.map((r) => r['text'])).toEqual(['uno', 'dos']);
  });

  it('rechaza un formato desconocido antes de cargar la config', async () => {
    const { stderr, exit } = setupProcess();

    const { runCommand } = await import('./run.js');
    await expect(
      runCommand.parseAsync(['demo-task', '--output-format', 'yaml'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 1 });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid --output-format'));
    expect(mockState.loadConfig).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
