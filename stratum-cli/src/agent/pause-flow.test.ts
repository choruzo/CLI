/**
 * Pausa cooperativa en el loop (PRD de Stratum Dot, M5). Cada test pide la
 * pausa en un momento concreto del turno —durante una tool, durante la
 * respuesta del modelo, con una aprobación abierta— y comprueba qué llegó a
 * empezar y qué no, y que al reanudar el turno sigue desde donde estaba.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { StratumAgent } from './core.js';
import { SUPERSEDED_BY_STEERING } from './inbox.js';
import { ProfileLoader } from './profiles.js';
import { ProviderRouter } from '../providers/router.js';
import { ToolRegistry } from '../tools/registry.js';
import { registerBuiltinTools } from '../tools/index.js';
import { resetExecRuntime } from '../tools/exec/runtime.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { StratumConfigSchema } from '../config/schema.js';
import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type {
  AgentEvent,
  ConfirmRequest,
  DestructiveDecision,
  Message,
  RunOptions,
  SubagentRouter,
} from './types.js';
import type { TraceRuntimeEvent } from '../trace/records.js';
import type { TraceScope } from '../trace/recorder.js';

function makeConfig(maxConcurrency = 1): ReturnType<typeof StratumConfigSchema.parse> {
  return StratumConfigSchema.parse({
    tools: { auditLog: false },
    memory: { autoExtract: false },
    agents: { maxConcurrency },
    provider: {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
          contextWindow: 32768,
        },
      },
    },
  });
}
const config = makeConfig();

/** Provider con guion: guarda cada petición y deja un gancho a mitad de su stream. */
class ScriptedProvider implements IProvider {
  readonly requests: Message[][] = [];
  during: Record<number, () => void> = {};

  constructor(private readonly rounds: OpenAIStreamChunk[][]) {}

  async *complete(req: CompletionRequest): AsyncGenerator<OpenAIStreamChunk> {
    const n = this.requests.length;
    this.requests.push(JSON.parse(JSON.stringify(req.messages)) as Message[]);
    const chunks = this.rounds[n] ?? makeTextRound('[guion agotado]');
    for (const [i, chunk] of chunks.entries()) {
      yield chunk;
      if (i === 0) this.during[n]?.();
    }
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  seen(n: number): string {
    return (this.requests[n] ?? []).map((m) => m.content ?? '').join('\n');
  }
}

interface Probe {
  registry: ToolRegistry;
  executed: string[];
  release: () => void;
  slowStarted: Promise<void>;
}

function probe(): Probe {
  const registry = new ToolRegistry();
  const executed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const slowStarted = new Promise<void>((r) => (started = r));
  registry.register({
    name: 'slow',
    description: 'tool lenta',
    schema: z.object({}).passthrough(),
    async execute() {
      executed.push('slow');
      started();
      await gate;
      return { ok: true, output: 'slow terminó' };
    },
  });
  registry.register({
    name: 'mutate',
    description: 'tool que cambia algo',
    schema: z.object({}).passthrough(),
    async execute() {
      executed.push('mutate');
      return { ok: true, output: 'cambiado' };
    },
  });
  registry.register({
    name: 'danger',
    description: 'tool que pide confirmación',
    destructive: true,
    schema: z.object({}).passthrough(),
    async execute() {
      executed.push('danger');
      return { ok: true, output: 'hecho' };
    },
  });
  return { registry, executed, release, slowStarted };
}

const agents: StratumAgent[] = [];
function agentWith(
  provider: IProvider,
  registry: ToolRegistry,
  cfg: ReturnType<typeof makeConfig> = config,
): StratumAgent {
  const router = new ProviderRouter(cfg);
  (router as unknown as { getActive: () => IProvider }).getActive = () => provider;
  const agent = new StratumAgent(cfg, router, registry, {
    profileLoader: new ProfileLoader(mkdtempSync(join(tmpdir(), 'stratum-noprofiles-'))),
  });
  agents.push(agent);
  return agent;
}

/** Una respuesta del modelo con varias tool calls a la vez. */
function callsRound(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): OpenAIStreamChunk[] {
  return [
    ...calls.map(
      (c, index): OpenAIStreamChunk => ({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index,
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                },
              ],
            },
            finish_reason: null,
            index: 0,
          },
        ],
      }),
    ),
    { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ];
}

/** Una respuesta del modelo con dos `delegate_task` a la vez. */
function twoDelegations(): OpenAIStreamChunk[] {
  const call = (index: number, id: string, task: string): OpenAIStreamChunk => ({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              id,
              type: 'function',
              function: {
                name: 'delegate_task',
                arguments: JSON.stringify({ task, profile: 'general' }),
              },
            },
          ],
        },
        finish_reason: null,
        index: 0,
      },
    ],
  });
  return [
    call(0, 'p1', 'uno'),
    call(1, 'p2', 'dos'),
    { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
  ];
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

/** Consume un turno en segundo plano: sus eventos, y cuándo terminó. */
function drive(gen: AsyncGenerator<AgentEvent>): { events: AgentEvent[]; done: Promise<void> } {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const ev of gen) events.push(ev);
  })();
  return { events, done };
}

async function until(cond: () => boolean, what = 'condition', ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Unas vueltas del bucle de eventos: lo que fuera a pasar, ya habría pasado. */
async function quiet(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function rolesAlternate(messages: Message[]): boolean {
  for (let i = 1; i < messages.length; i++) {
    const [a, b] = [messages[i - 1]!.role, messages[i]!.role];
    if (a === b && (a === 'user' || a === 'assistant')) return false;
  }
  return true;
}

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.jobs?.shutdown();
  resetExecRuntime();
});

describe('A/D — pausa pedida durante una tool', () => {
  it('la tool termina, no se inicia la siguiente petición y el run queda en pausa', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'slow', {}),
      makeTextRound('Listo.'),
    ]);
    const agent = agentWith(provider, p.registry);
    const abort = new AbortController();
    const turn = drive(agent.run('haz la tarea', { signal: abort.signal }));

    await p.slowStarted;
    expect(agent.pause.requestPause()).toBe('requested');
    // Pedida, no alcanzada: la tool sigue.
    expect(agent.pause.state).toBe('pause-requested');
    p.release();

    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    // La tool no se interrumpió…
    expect(abort.signal.aborted).toBe(false);
    expect(turn.events.find((e) => e.type === 'tool_result')).toMatchObject({
      result: 'slow terminó',
    });
    // …y el modelo no ha recibido nada más.
    expect(provider.requests).toHaveLength(1);
    expect(turn.events.some((e) => e.type === 'done')).toBe(false);

    expect(agent.pause.resume()).toBe('resumed');
    await turn.done;
    expect(provider.requests).toHaveLength(2);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(agent.pause.state).toBe('idle');
  });
});

describe('B/C — pausa pedida durante la respuesta del modelo', () => {
  it('la respuesta termina, pero la tool que propone no se ejecuta hasta reanudar', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'mutate', {}),
      makeTextRound('Cambiado.'),
    ]);
    const agent = agentWith(provider, p.registry);
    provider.during[0] = () => void agent.pause.requestPause();
    const turn = drive(agent.run('cambia el fichero'));

    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    // La llamada se conoce entera (el stream no se cortó), pero no ha empezado.
    expect(turn.events.some((e) => e.type === 'tool_call_ready')).toBe(true);
    expect(p.executed).toEqual([]);
    expect(provider.requests).toHaveLength(1);

    agent.pause.resume();
    await turn.done;
    expect(p.executed).toEqual(['mutate']);
    expect(provider.requests).toHaveLength(2);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('el texto en curso no se corta', async () => {
    const p = probe();
    const provider = new ScriptedProvider([makeTextRound('Una respuesta completa y larga.')]);
    const agent = agentWith(provider, p.registry);
    provider.during[0] = () => void agent.pause.requestPause();
    const turn = drive(agent.run('explica'));
    await turn.done;

    const text = turn.events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('');
    expect(text).toBe('Una respuesta completa y larga.');
    // No quedaba nada por empezar: el run termina y la pausa se va con él.
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(agent.pause.state).toBe('idle');
    expect(agent.pause.resume()).toBe('not-running');
  });
});

describe('E — reanudar', () => {
  async function runOnce(pauseAt: 'tool' | 'model' | null): Promise<{
    requests: Message[][];
    types: string[];
    messages: Message[];
  }> {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'slow', {}),
      makeToolCallRound('c2', 'mutate', {}),
      makeTextRound('Terminado.'),
    ]);
    const agent = agentWith(provider, p.registry);
    if (pauseAt === 'model') provider.during[1] = () => void agent.pause.requestPause();
    const turn = drive(agent.run('haz la tarea'));
    await p.slowStarted;
    if (pauseAt === 'tool') agent.pause.requestPause();
    p.release();
    if (pauseAt) {
      await until(() => agent.pause.state === 'paused', 'paused');
      await quiet();
      agent.pause.resume();
    }
    await turn.done;
    return {
      requests: provider.requests,
      types: turn.events.map((e) => e.type),
      messages: agent.getMessages(),
    };
  }

  it('AC-6: el turno termina igual que sin pausa — mismas peticiones, mismos eventos, mismo historial', async () => {
    const plain = await runOnce(null);
    for (const at of ['tool', 'model'] as const) {
      const paused = await runOnce(at);
      expect(paused.requests).toEqual(plain.requests);
      expect(paused.types).toEqual(plain.types);
      expect(paused.messages).toEqual(plain.messages);
    }
  });

  it('es el mismo turno: una sola observación de principio a fin', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'slow', {}),
      makeTextRound('Listo.'),
    ]);
    const agent = agentWith(provider, p.registry);
    const seen: string[] = [];
    agent.observe((o) => {
      if (o.type !== 'event') seen.push(o.type);
    });
    const turn = drive(agent.run('haz la tarea'));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');
    agent.pause.resume();
    await turn.done;
    expect(seen).toEqual(['turn_started', 'turn_ended']);
  });
});

describe('F — cancelar con el run en pausa', () => {
  it('antes de la petición al modelo: termina cancelado, sin reanudar', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'slow', {}),
      makeTextRound('no debería llegar'),
    ]);
    const agent = agentWith(provider, p.registry);
    const abort = new AbortController();
    const turn = drive(agent.run('haz la tarea', { signal: abort.signal }));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');

    abort.abort();
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    expect(provider.requests).toHaveLength(1);
    expect(agent.pause.state).toBe('idle');
    expect(agent.pause.waiting).toBe(0);
  });

  it('antes de ejecutar una tool: no se ejecuta y el historial queda cerrado', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'mutate', {}),
      makeTextRound('Sigo.'),
    ]);
    const agent = agentWith(provider, p.registry);
    provider.during[0] = () => void agent.pause.requestPause();
    const abort = new AbortController();
    const turn = drive(agent.run('cambia el fichero', { signal: abort.signal }));
    await until(() => agent.pause.state === 'paused', 'paused');

    abort.abort();
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    expect(p.executed).toEqual([]);
    // La llamada ya estaba anunciada: se cierra en el stream, no solo en el historial.
    expect(turn.events.some((e) => e.type === 'tool_call_ready' && e.id === 'c1')).toBe(true);
    expect(turn.events.find((e) => e.type === 'tool_error')).toMatchObject({
      id: 'c1',
      recoverable: true,
    });

    // La tool call sin respuesta no se queda colgando: el turno siguiente funciona.
    const history = agent.getMessages();
    const calls = history.flatMap((m) => m.tool_calls ?? []).map((c) => c.id);
    const answered = history.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : []));
    expect(answered).toEqual(calls);
    const next = drive(agent.run('continúa'));
    await next.done;
    expect(next.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(rolesAlternate(agent.getMessages())).toBe(true);
  });

  it('con la pausa solo pedida y una tool en curso, cancelar sigue siendo inmediato', async () => {
    const p = probe();
    const provider = new ScriptedProvider([makeToolCallRound('c1', 'slow', {})]);
    const agent = agentWith(provider, p.registry);
    const abort = new AbortController();
    const turn = drive(agent.run('haz la tarea', { signal: abort.signal }));
    await p.slowStarted;
    agent.pause.requestPause();
    abort.abort();
    await turn.done;
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    expect(agent.pause.state).toBe('idle');
    p.release();
  });
});

describe('G — steering con el run en pausa', () => {
  it('se acepta, no reanuda, y el modelo lo recibe al continuar', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'slow', {}),
      makeTextRound('Cambio de enfoque.'),
    ]);
    const agent = agentWith(provider, p.registry);
    const turn = drive(agent.run('haz la tarea'));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');

    expect(agent.enqueueUserMessage('cambia el enfoque').status).toBe('accepted');
    await quiet();
    // Redirigir no es reanudar.
    expect(agent.pause.state).toBe('paused');
    expect(provider.requests).toHaveLength(1);

    agent.pause.resume();
    await turn.done;
    expect(provider.seen(1)).toContain('1. User: cambia el enfoque');
    expect(turn.events.filter((e) => e.type === 'runtime_updates')).toHaveLength(1);
  });

  it('pausado antes de una tool: el mensaje invalida el lote y el modelo decide de nuevo', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'mutate', {}),
      makeTextRound('De acuerdo, no lo toco.'),
    ]);
    const agent = agentWith(provider, p.registry);
    provider.during[0] = () => void agent.pause.requestPause();
    const turn = drive(agent.run('cambia el fichero'));
    await until(() => agent.pause.state === 'paused', 'paused');

    expect(agent.enqueueUserMessage('no lo cambies').status).toBe('accepted');
    agent.pause.resume();
    await turn.done;
    expect(p.executed).toEqual([]);
    expect(provider.seen(1)).toContain('1. User: no lo cambies');
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });
});

describe('H — jobs en segundo plano', () => {
  it('un job lanzado antes sigue corriendo con el run en pausa', async () => {
    const p = probe();
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, config);
    registry.register(p.registry.get('slow')!);
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'exec', {
        command: 'node -e "setTimeout(Object, 20000)"',
        background: true,
      }),
      makeToolCallRound('c2', 'slow', {}),
      makeTextRound('El job sigue.'),
    ]);
    const agent = agentWith(provider, registry);
    const turn = drive(agent.run('lanza el job'));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');
    await new Promise((r) => setTimeout(r, 150));

    const jobs = agent.jobs!.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('running');
    expect(agent.pause.state).toBe('paused');

    agent.pause.resume();
    await turn.done;
    expect(agent.jobs!.list()[0]!.status).toBe('running');
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  }, 30_000);
});

describe('I — subagentes', () => {
  function delegating(
    parent: ScriptedProvider,
    children: ScriptedProvider[],
    cfg = config,
  ): { agent: StratumAgent; opts: RunOptions } {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, cfg);
    const agent = agentWith(parent, registry, cfg);
    let n = 0;
    return { agent, opts: { makeSubagentRouter: () => mockRouter(children[n++]!) } };
  }

  it('la pausa del padre alcanza al hijo: no empieza otra petición', async () => {
    const parent = new ScriptedProvider([
      makeToolCallRound('p1', 'delegate_task', { task: 'investiga', profile: 'general' }),
      makeTextRound('Hecho.'),
    ]);
    const child = new ScriptedProvider([
      makeToolCallRound('k1', 'list_directory', { path: '.' }),
      makeTextRound('Investigado.'),
    ]);
    const { agent, opts } = delegating(parent, [child]);
    // Se pide con el hijo a mitad de su primera respuesta.
    child.during[0] = () => void agent.pause.requestPause();
    const turn = drive(agent.run('delega', opts));

    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    expect(child.requests).toHaveLength(1);
    // Ni su tool llegó a ejecutarse.
    const childEvents = (): AgentEvent[] =>
      turn.events.flatMap((e) => (e.type === 'subagent_event' ? [e.event] : []));
    expect(childEvents().some((e) => e.type === 'tool_result')).toBe(false);
    expect(parent.requests).toHaveLength(1);

    agent.pause.resume();
    await turn.done;
    expect(child.requests).toHaveLength(2);
    expect(childEvents().some((e) => e.type === 'tool_result')).toBe(true);
    expect(turn.events.find((e) => e.type === 'subagent_completed')).toMatchObject({
      result: { status: 'completed' },
    });
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('con el run en pausa no nace un subagente nuevo', async () => {
    const parent = new ScriptedProvider([twoDelegations(), makeTextRound('Los dos hechos.')]);
    const first = new ScriptedProvider([makeTextRound('Uno hecho.')]);
    const second = new ScriptedProvider([makeTextRound('Dos hecho.')]);
    const { agent, opts } = delegating(parent, [first, second]);
    // El primero está en su última respuesta: terminará sin pasar por un punto seguro.
    first.during[0] = () => void agent.pause.requestPause();
    const turn = drive(agent.run('delega dos', opts));

    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    const started = (): number => turn.events.filter((e) => e.type === 'subagent_started').length;
    // El segundo tenía el turno, pero no se ha lanzado.
    expect(turn.events.filter((e) => e.type === 'tool_call_ready')).toHaveLength(2);
    expect(started()).toBe(1);
    expect(second.requests).toHaveLength(0);

    agent.pause.resume();
    await turn.done;
    expect(started()).toBe(2);
    expect(second.requests).toHaveLength(1);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    expect(agent.pause.waiting).toBe(0);
  });

  it('cancelar con un hijo en pausa lo cancela a él también', async () => {
    const parent = new ScriptedProvider([
      makeToolCallRound('p1', 'delegate_task', { task: 'investiga', profile: 'general' }),
    ]);
    const child = new ScriptedProvider([makeToolCallRound('k1', 'list_directory', { path: '.' })]);
    const { agent, opts } = delegating(parent, [child]);
    child.during[0] = () => void agent.pause.requestPause();
    const abort = new AbortController();
    const turn = drive(agent.run('delega', { ...opts, signal: abort.signal }));
    await until(() => agent.pause.state === 'paused', 'paused');

    abort.abort();
    await turn.done;
    expect(turn.events.find((e) => e.type === 'subagent_completed')).toMatchObject({
      result: { status: 'cancelled' },
    });
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
    expect(agent.pause.state).toBe('idle');
    expect(agent.pause.waiting).toBe(0);
  });
});

describe('pausa a mitad de un lote', () => {
  function setup(first: 'slow' | 'danger'): {
    p: Probe;
    agent: StratumAgent;
    parent: ScriptedProvider;
    child: ScriptedProvider;
    opts: RunOptions;
  } {
    const p = probe();
    const registry = new ToolRegistry();
    registerBuiltinTools(registry, config);
    registry.register(p.registry.get(first)!);
    const parent = new ScriptedProvider([
      callsRound([
        { id: 'c1', name: first, args: {} },
        { id: 'c2', name: 'delegate_task', args: { task: 'investiga', profile: 'general' } },
      ]),
      makeTextRound('Entendido.'),
    ]);
    const child = new ScriptedProvider([makeTextRound('Investigado.')]);
    const agent = agentWith(parent, registry);
    return { p, agent, parent, child, opts: { makeSubagentRouter: () => mockRouter(child) } };
  }
  const subagents = (events: AgentEvent[]): number =>
    events.filter((e) => e.type === 'subagent_started').length;

  it('pedida durante una tool: la delegación del mismo lote espera, y sin steering sigue al reanudar', async () => {
    const { p, agent, child, opts } = setup('slow');
    const turn = drive(agent.run('haz y delega', opts));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    expect(subagents(turn.events)).toBe(0);
    expect(child.requests).toHaveLength(0);

    agent.pause.resume();
    await turn.done;
    expect(subagents(turn.events)).toBe(1);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('con steering en esa pausa, lo que quedaba del lote no empieza', async () => {
    const { p, agent, parent, child, opts } = setup('slow');
    const turn = drive(agent.run('haz y delega', opts));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');
    agent.enqueueUserMessage('no delegues nada');
    agent.pause.resume();
    await turn.done;

    expect(subagents(turn.events)).toBe(0);
    expect(child.requests).toHaveLength(0);
    // La tool que ya había terminado conserva su resultado; la delegación, el rechazo.
    expect(turn.events.find((e) => e.type === 'tool_result')).toMatchObject({ id: 'c1' });
    expect(turn.events.find((e) => e.type === 'tool_error')).toMatchObject({
      id: 'c2',
      error: SUPERSEDED_BY_STEERING,
    });
    expect(parent.seen(1)).toContain('1. User: no delegues nada');
    expect(rolesAlternate(agent.getMessages())).toBe(true);
  });

  it('aprobación + pausa + steering: ni la tool aprobada ni la delegación del lote', async () => {
    const { p, agent, child, opts } = setup('danger');
    let decide!: (d: DestructiveDecision) => void;
    let asked = false;
    const onConfirmDestructive = (): Promise<DestructiveDecision> => {
      asked = true;
      return new Promise((resolve) => (decide = resolve));
    };
    const turn = drive(
      agent.run('haz y delega', { ...opts, destructivePolicy: 'ask', onConfirmDestructive }),
    );
    await until(() => asked, 'confirmation');
    agent.pause.requestPause();
    decide('approve');
    await until(() => agent.pause.state === 'paused', 'paused');
    agent.enqueueUserMessage('no hagas nada de eso');
    agent.pause.resume();
    await turn.done;

    expect(p.executed).toEqual([]);
    expect(subagents(turn.events)).toBe(0);
    expect(child.requests).toHaveLength(0);
    const rejected = turn.events.flatMap((e) => (e.type === 'tool_error' ? [e.id] : []));
    expect(rejected.sort()).toEqual(['c1', 'c2']);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });
});

describe('J — aprobación pendiente', () => {
  it('aprobar no reanuda: la tool aprobada espera a resume', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'danger', {}),
      makeTextRound('Hecho.'),
    ]);
    const agent = agentWith(provider, p.registry);
    let decide!: (d: DestructiveDecision) => void;
    let asked = false;
    const onConfirmDestructive = (_req: ConfirmRequest): Promise<DestructiveDecision> => {
      asked = true;
      return new Promise((resolve) => (decide = resolve));
    };
    const turn = drive(agent.run('hazlo', { destructivePolicy: 'ask', onConfirmDestructive }));
    await until(() => asked, 'confirmation');

    // Con la aprobación abierta, la pausa queda pedida: la solicitud sigue ahí.
    expect(agent.pause.requestPause()).toBe('requested');
    await quiet();
    expect(agent.pause.state).toBe('pause-requested');

    decide('approve');
    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    expect(p.executed).toEqual([]);
    expect(provider.requests).toHaveLength(1);

    agent.pause.resume();
    await turn.done;
    // Se ejecuta lo aprobado, una vez, sin volver a preguntar.
    expect(p.executed).toEqual(['danger']);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('steering con lo aprobado en pausa: la acción se descarta y el modelo decide de nuevo', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'danger', {}),
      makeTextRound('De acuerdo, no lo hago.'),
    ]);
    const agent = agentWith(provider, p.registry);
    let decide!: (d: DestructiveDecision) => void;
    let asks = 0;
    const onConfirmDestructive = (): Promise<DestructiveDecision> => {
      asks++;
      return new Promise((resolve) => (decide = resolve));
    };
    const runtime: TraceRuntimeEvent[] = [];
    const scope: TraceScope = {
      turnStart: () => {},
      turnEnd: () => {},
      modelStart: () => ({ firstChunk: () => {}, usage: () => {}, end: () => {} }),
      event: () => {},
      runtime: (ev) => runtime.push(ev),
      child: () => scope,
    };
    const turn = drive(
      agent.run('hazlo', { destructivePolicy: 'ask', onConfirmDestructive, trace: scope }),
    );
    await until(() => asks === 1, 'confirmation');
    agent.pause.requestPause();
    decide('approve');
    await until(() => agent.pause.state === 'paused', 'paused');

    // La aprobación ya consta; ahora el usuario cambia de idea.
    expect(agent.enqueueUserMessage('no lo hagas, cambia el enfoque').status).toBe('accepted');
    agent.pause.resume();
    await turn.done;

    // Lo aprobado NO se ejecuta por delante del mensaje.
    expect(p.executed).toEqual([]);
    expect(turn.events.find((e) => e.type === 'tool_error')).toMatchObject({
      id: 'c1',
      error: SUPERSEDED_BY_STEERING,
      recoverable: true,
    });
    // El modelo recibe el rechazo y el mensaje juntos, y no se vuelve a preguntar.
    expect(provider.seen(1)).toContain(SUPERSEDED_BY_STEERING);
    expect(provider.seen(1)).toContain('1. User: no lo hagas, cambia el enfoque');
    expect(asks).toBe(1);
    expect(rolesAlternate(agent.getMessages())).toBe(true);
    expect(turn.events.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
    // En la traza: aprobada, y después vetada por steering.
    expect(runtime.find((e) => e.event === 'confirmation')).toMatchObject({ decision: 'approved' });
    expect(runtime.find((e) => e.event === 'veto')).toMatchObject({
      source: 'steering',
      callId: 'c1',
    });
  });

  it('sin steering, lo aprobado en pausa sí se ejecuta: solo un mensaje del usuario lo descarta', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'danger', {}),
      makeTextRound('Hecho.'),
    ]);
    const agent = agentWith(provider, p.registry);
    let decide!: (d: DestructiveDecision) => void;
    let asked = false;
    const onConfirmDestructive = (): Promise<DestructiveDecision> => {
      asked = true;
      return new Promise((resolve) => (decide = resolve));
    };
    const turn = drive(agent.run('hazlo', { destructivePolicy: 'ask', onConfirmDestructive }));
    await until(() => asked, 'confirmation');
    // Steering ANTES de la aprobación y sin pausa: la semántica previa a M5 no cambia.
    expect(agent.enqueueUserMessage('y luego avisa').status).toBe('accepted');
    decide('approve');
    await turn.done;
    expect(p.executed).toEqual(['danger']);
  });

  it('denegar tampoco reanuda: el run queda en pausa antes de la siguiente petición', async () => {
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'danger', {}),
      makeTextRound('Entendido.'),
    ]);
    const agent = agentWith(provider, p.registry);
    let decide!: (d: DestructiveDecision) => void;
    let asked = false;
    const onConfirmDestructive = (): Promise<DestructiveDecision> => {
      asked = true;
      return new Promise((resolve) => (decide = resolve));
    };
    const turn = drive(agent.run('hazlo', { destructivePolicy: 'ask', onConfirmDestructive }));
    await until(() => asked, 'confirmation');
    agent.pause.requestPause();
    decide('deny');

    await until(() => agent.pause.state === 'paused', 'paused');
    await quiet();
    expect(p.executed).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    agent.pause.resume();
    await turn.done;
    expect(p.executed).toEqual([]);
    expect(provider.requests).toHaveLength(2);
  });
});

describe('traza', () => {
  it('queda cuándo se pidió, se alcanzó y se retiró la pausa', async () => {
    const runtime: TraceRuntimeEvent[] = [];
    const scope: TraceScope = {
      turnStart: () => {},
      turnEnd: () => {},
      modelStart: () => ({ firstChunk: () => {}, usage: () => {}, end: () => {} }),
      event: () => {},
      runtime: (ev) => runtime.push(ev),
      child: () => scope,
    };
    const p = probe();
    const provider = new ScriptedProvider([
      makeToolCallRound('c1', 'slow', {}),
      makeTextRound('Listo.'),
    ]);
    const agent = agentWith(provider, p.registry);
    const turn = drive(agent.run('haz la tarea', { trace: scope }));
    await p.slowStarted;
    agent.pause.requestPause();
    p.release();
    await until(() => agent.pause.state === 'paused', 'paused');
    agent.pause.resume();
    await turn.done;

    const phases = runtime.flatMap((e) => (e.event === 'pause' ? [e.phase] : []));
    expect(phases).toEqual(['requested', 'paused', 'resumed']);
  });
});
