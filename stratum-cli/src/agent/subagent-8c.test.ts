import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ReactLoop } from './harness.js';
import { ProfileLoader } from './profiles.js';
import { inferBashWrites } from './subagent.js';
import { Semaphore, Mutex } from './concurrency.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { MockProvider, makeTextRound } from '../providers/mock.js';
import type {
  AgentEvent,
  ConfirmRequest,
  DestructiveDecision,
  Message,
  SubagentRouter,
} from './types.js';
import type { IProvider, OpenAIStreamChunk } from '../providers/base.js';
import { StratumConfigSchema } from '../config/schema.js';

function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  return (async () => {
    const events: AgentEvent[] = [];
    for await (const ev of gen) events.push(ev);
    return events;
  })();
}

function newRegistry(config: ReturnType<typeof StratumConfigSchema.parse>): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r, config);
  return r;
}

function emptyProfiles(): ProfileLoader {
  return new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-8c-noprofiles-')));
}

function mockRouter(provider: IProvider): SubagentRouter {
  return {
    getActive: () => provider,
    model: 'mock',
    providerName: 'mock',
    contextWindow: 32768,
    hasFallback: false,
    advanceProvider: () => null,
    switchModel: () => {},
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Un turno del padre con N tool calls delegate_task (índices 0..N-1). */
function multiDelegateRound(
  specs: Array<{ id: string; task: string; profile?: string }>,
): OpenAIStreamChunk[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: specs.map((s, i) => ({
              index: i,
              id: s.id,
              type: 'function' as const,
              function: {
                name: 'delegate_task',
                arguments: JSON.stringify({ task: s.task, profile: s.profile ?? 'general' }),
              },
            })),
          },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ];
}

/** Un turno con una tool call exec (target local) arbitraria. */
function bashRound(id: string, command: string): OpenAIStreamChunk[] {
  const args = JSON.stringify({ command });
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function' as const,
                function: { name: 'exec', arguments: args },
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ];
}

/** Un turno con una tool call write_file. */
function writeRound(id: string, path: string, content: string): OpenAIStreamChunk[] {
  const args = JSON.stringify({ path, content });
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function' as const,
                function: { name: 'write_file', arguments: args },
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ];
}

// ---------------------------------------------------------------------------
// Primitivas de concurrencia
// ---------------------------------------------------------------------------
describe('Semaphore (Hito 8C)', () => {
  it('nunca deja más de N secciones activas a la vez', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let max = 0;
    const task = async () => {
      const release = await sem.acquire();
      active++;
      max = Math.max(max, active);
      await delay(10);
      active--;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, () => task()));
    expect(max).toBe(2);
    expect(active).toBe(0);
  });

  it('con 1 permiso es estrictamente secuencial', async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        sem.run(async () => {
          active++;
          max = Math.max(max, active);
          await delay(5);
          active--;
        }),
      ),
    );
    expect(max).toBe(1);
  });
});

describe('Mutex (Hito 8C)', () => {
  it('serializa secciones críticas (nunca dos a la vez) y preserva FIFO', async () => {
    const mutex = new Mutex();
    let active = 0;
    let max = 0;
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3].map((n) =>
        mutex.runExclusive(async () => {
          active++;
          max = Math.max(max, active);
          await delay(8);
          order.push(n);
          active--;
        }),
      ),
    );
    expect(max).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]); // orden de llegada preservado
  });
});

// ---------------------------------------------------------------------------
// Write-log de bash (§12.16)
// ---------------------------------------------------------------------------
describe('inferBashWrites (Hito 8C)', () => {
  it('infiere redirecciones, tee, touch, rm y destino de cp/mv', () => {
    expect(inferBashWrites('echo hi > out.txt')).toContainEqual({
      path: 'out.txt',
      action: 'modified',
    });
    expect(inferBashWrites('cat a >> log.txt')).toContainEqual({
      path: 'log.txt',
      action: 'modified',
    });
    expect(inferBashWrites('echo x | tee shared.md')).toContainEqual({
      path: 'shared.md',
      action: 'modified',
    });
    expect(inferBashWrites('touch newfile')).toContainEqual({
      path: 'newfile',
      action: 'created',
    });
    expect(inferBashWrites('rm -rf build')).toContainEqual({
      path: 'build',
      action: 'deleted',
    });
    expect(inferBashWrites('cp src.ts dist.ts')).toContainEqual({
      path: 'dist.ts',
      action: 'modified',
    });
  });

  it('no inventa paths para comandos de solo lectura', () => {
    expect(inferBashWrites('ls -la')).toEqual([]);
    expect(inferBashWrites('grep foo bar.txt')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Orquestación paralela
// ---------------------------------------------------------------------------
describe('Orquestación paralela de subagentes (Hito 8C)', () => {
  /** Provider que mide cuántos `complete()` corren a la vez, compartiendo tracker. */
  function concurrencyProbe(delayMs = 30) {
    const tracker = { active: 0, max: 0 };
    const make = (): IProvider => ({
      async *complete(): AsyncGenerator<OpenAIStreamChunk> {
        tracker.active++;
        tracker.max = Math.max(tracker.max, tracker.active);
        await delay(delayMs);
        for (const c of makeTextRound('subtarea completada')) yield c;
        tracker.active--;
      },
      async healthCheck() {
        return true;
      },
    });
    return { tracker, make };
  }

  it('respeta el semáforo con maxConcurrency=2 (nunca >2 activos)', async () => {
    const config = StratumConfigSchema.parse({ agents: { maxConcurrency: 2 } });
    const parent = new MockProvider([
      multiDelegateRound([
        { id: 'a', task: 'tarea A' },
        { id: 'b', task: 'tarea B' },
        { id: 'c', task: 'tarea C' },
        { id: 'd', task: 'tarea D' },
      ]),
      makeTextRound('todas delegadas'),
    ]);
    const probe = concurrencyProbe();
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      parent,
      newRegistry(config),
      messages,
      config,
      'm',
      32768,
      undefined,
      {
        profiles: emptyProfiles(),
      },
    );

    const events = await collect(loop.run({ makeSubagentRouter: () => mockRouter(probe.make()) }));

    expect(probe.tracker.max).toBe(2);
    expect(probe.tracker.active).toBe(0);
    const completed = events.filter((e) => e.type === 'subagent_completed');
    expect(completed).toHaveLength(4);
    // Cuatro tool results de delegate_task inyectados.
    const toolMsgs = messages.filter((m) => m.role === 'tool' && m.name === 'delegate_task');
    expect(toolMsgs).toHaveLength(4);
  });

  it('con maxConcurrency=1 la ejecución es estrictamente secuencial (max=1)', async () => {
    const config = StratumConfigSchema.parse({ agents: { maxConcurrency: 1 } });
    const parent = new MockProvider([
      multiDelegateRound([
        { id: 'a', task: 'tarea A' },
        { id: 'b', task: 'tarea B' },
        { id: 'c', task: 'tarea C' },
      ]),
      makeTextRound('ok'),
    ]);
    const probe = concurrencyProbe();
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      parent,
      newRegistry(config),
      messages,
      config,
      'm',
      32768,
      undefined,
      {
        profiles: emptyProfiles(),
      },
    );

    await collect(loop.run({ makeSubagentRouter: () => mockRouter(probe.make()) }));
    expect(probe.tracker.max).toBe(1);
  });

  it('re-emite los eventos del hijo envueltos como subagent_event', async () => {
    const config = StratumConfigSchema.parse({ agents: { maxConcurrency: 2 } });
    const parent = new MockProvider([
      multiDelegateRound([{ id: 'a', task: 'explora' }]),
      makeTextRound('listo'),
    ]);
    const child = new MockProvider([makeTextRound('he explorado el módulo X')]);
    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      parent,
      newRegistry(config),
      messages,
      config,
      'm',
      32768,
      undefined,
      {
        profiles: emptyProfiles(),
      },
    );

    const events = await collect(loop.run({ makeSubagentRouter: () => mockRouter(child) }));

    const wrapped = events.filter((e) => e.type === 'subagent_event');
    expect(wrapped.length).toBeGreaterThan(0);
    // Alguno envuelve un text_delta del hijo, etiquetado con su subagentId.
    const started = events.find((e) => e.type === 'subagent_started') as
      | { subagentId: string }
      | undefined;
    expect(started).toBeDefined();
    const textEv = wrapped.find((e) => (e as { event: AgentEvent }).event.type === 'text_delta') as
      | { subagentId: string; event: { type: string; delta: string } }
      | undefined;
    expect(textEv).toBeDefined();
    expect(textEv!.subagentId).toBe(started!.subagentId);
    expect(textEv!.event.delta).toContain('explorado');
  });

  it('detecta conflicto de fichero entre subagentes paralelos y emite warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-8c-conflict-'));
    const shared = join(dir, 'shared.txt');
    try {
      const config = StratumConfigSchema.parse({ agents: { maxConcurrency: 2 } });
      const parent = new MockProvider([
        multiDelegateRound([
          { id: 'a', task: 'escribe compartido A' },
          { id: 'b', task: 'escribe compartido B' },
        ]),
        makeTextRound('hecho'),
      ]);
      // Cada hijo escribe el MISMO path y luego resume.
      const childA = new MockProvider([writeRound('wa', shared, 'A'), makeTextRound('escrito A')]);
      const childB = new MockProvider([writeRound('wb', shared, 'B'), makeTextRound('escrito B')]);
      const childProviders = [childA, childB];
      let idx = 0;
      const messages: Message[] = [{ role: 'system', content: 'sys' }];
      const loop = new ReactLoop(
        parent,
        newRegistry(config),
        messages,
        config,
        'm',
        32768,
        undefined,
        { profiles: emptyProfiles() },
      );

      const events = await collect(
        loop.run({ makeSubagentRouter: () => mockRouter(childProviders[idx++ % 2]!) }),
      );

      const warning = events.find(
        (e) => e.type === 'warning' && e.message.includes('subagent_file_conflict'),
      );
      expect(warning).toBeDefined();
      expect((warning as { message: string }).message).toContain('shared.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serializa las confirmaciones destructivas de subagentes paralelos (mutex)', async () => {
    const config = StratumConfigSchema.parse({ agents: { maxConcurrency: 2 } });
    const parent = new MockProvider([
      multiDelegateRound([
        { id: 'a', task: 'borra temporales A' },
        { id: 'b', task: 'borra temporales B' },
      ]),
      makeTextRound('gestionado'),
    ]);
    // Cada hijo intenta un exec destructivo (rm) → confirmación al padre → deny.
    const childA = new MockProvider([bashRound('ba', 'rm -rf tmp_a'), makeTextRound('ok A')]);
    const childB = new MockProvider([bashRound('bb', 'rm -rf tmp_b'), makeTextRound('ok B')]);
    const childProviders = [childA, childB];
    let idx = 0;

    let activeConfirms = 0;
    let maxConfirms = 0;
    let calls = 0;
    const onConfirmDestructive = async (_req: ConfirmRequest): Promise<DestructiveDecision> => {
      calls++;
      activeConfirms++;
      maxConfirms = Math.max(maxConfirms, activeConfirms);
      await delay(15);
      activeConfirms--;
      return 'deny';
    };

    const messages: Message[] = [{ role: 'system', content: 'sys' }];
    const loop = new ReactLoop(
      parent,
      newRegistry(config),
      messages,
      config,
      'm',
      32768,
      undefined,
      {
        profiles: emptyProfiles(),
      },
    );

    const events = await collect(
      loop.run({
        makeSubagentRouter: () => mockRouter(childProviders[idx++ % 2]!),
        onConfirmDestructive,
        destructivePolicy: 'ask',
      }),
    );

    // Ambos hijos pidieron confirmación, pero NUNCA dos prompts a la vez.
    expect(calls).toBe(2);
    expect(maxConfirms).toBe(1);
    // Ambos completaron (el deny es un tool_error recuperable, no los tumba).
    const completed = events.filter((e) => e.type === 'subagent_completed');
    expect(completed).toHaveLength(2);
  });
});
