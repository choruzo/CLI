import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentObservation } from '../agent/core.js';
import { PauseController } from '../agent/pause.js';
import type { AgentEvent } from '../agent/types.js';
import { StratumConfigSchema, type StratumConfig } from '../config/schema.js';
import {
  DecisionMemory,
  _resetDecisionMemoryCache,
  _setDecisionMemory,
} from '../memory/decision-memory.js';
import type { EmbedFn } from '../memory/embeddings.js';
import {
  applySessionEvent,
  type ProtocolEvent,
  type ProtocolStateEvent,
} from '../protocol/index.js';
import { eventSchema, sessionSnapshotSchema } from '../protocol/schemas.js';
import { MockProvider, makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { ProviderRouter } from '../providers/router.js';
import { createSessionEnv } from '../runtime/session-env.js';
import { closeExecRuntime } from '../tools/exec/runtime.js';
import { SessionHost } from './session-host.js';
import {
  SNAPSHOT_BYTE_BUDGET,
  SNAPSHOT_MIN_BUDGET,
  SessionPublisher,
  fitSnapshot,
  type PublisherSink,
} from './session-publisher.js';
import { MAX_MESSAGE_BYTES, type ProtocolSessionSnapshot } from '../protocol/index.js';
import {
  sampleApproval,
  sampleRun,
  sampleSession,
  sampleSnapshot,
  sampleToolCall,
} from '../protocol/protocol.fixtures.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-publisher-')));
afterAll(async () => {
  await closeExecRuntime();
  rmSync(base, { recursive: true, force: true });
});

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function testConfig(name: string, memoryDir = name): StratumConfig {
  return StratumConfigSchema.parse({
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
    memory: {
      autoExtract: false,
      decisionsFile: join(base, memoryDir, 'decisions.json'),
      vectorDb: join(base, memoryDir, 'vectors.db'),
      embeddingDimension: 4,
      similarityThreshold: 0.9,
    },
    skills: { enabled: false },
    tools: { auditLog: join(base, `${name}-audit.jsonl`) },
    trace: { enabled: false },
  });
}

/** Sink que apunta lo que recibe y comprueba que cumple el contrato. */
function recorder(): PublisherSink & {
  events: ProtocolEvent[];
  log: string[];
  states(): ProtocolStateEvent[];
} {
  const events: ProtocolEvent[] = [];
  const log: string[] = [];
  return {
    events,
    log,
    states: () => events.filter((e): e is ProtocolStateEvent => 'seq' in e),
    onEvents(batch) {
      for (const event of batch) {
        expect(eventSchema.safeParse(event).success, event.type).toBe(true);
        events.push(event);
        log.push('seq' in event ? `${event.seq}:${event.type}` : event.type);
      }
    },
    onOverflow() {
      log.push('OVERFLOW');
    },
  };
}

// ---------------------------------------------------------------------------
// Con una sesión de verdad
// ---------------------------------------------------------------------------

const hosts: SessionHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose({ cancelBackground: true })));
  _resetDecisionMemoryCache();
});

async function realHost(name: string, rounds: Parameters<typeof makeTextRound>[0][] | unknown[]) {
  const cwd = join(base, name);
  mkdirSync(cwd, { recursive: true });
  const config = testConfig(name);
  const router = new ProviderRouter(config);
  vi.spyOn(router, 'getActive').mockReturnValue(new MockProvider(rounds as never));
  const host = await SessionHost.create({
    env: createSessionEnv({ cwd, env: process.env }),
    config,
    router,
    mcp: 'none',
  });
  hosts.push(host);
  return { host, cwd };
}

describe('SessionPublisher — una sesión real', () => {
  it('numera sin huecos desde 1, no entrega nada dentro de observe() y la foto cuadra con el seq', async () => {
    const { host, cwd } = await realHost('real', [
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'hola' }),
      makeTextRound('Hecho.'),
    ]);
    const sink = recorder();
    let observing = false;
    const guarded: PublisherSink = {
      onEvents: (batch) => {
        // La invariante: el sink nunca corre dentro del turno del agente.
        expect(observing).toBe(false);
        sink.onEvents(batch);
      },
      onOverflow: () => sink.onOverflow(),
    };
    // Los observadores se llaman en orden de registro: este abre la ventana…
    host.agent.observe(() => (observing = true));
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'daemon', client: 'daemon', connected: true },
      sink: guarded,
    });
    publisher.start();
    // …y este la cierra, después del publicador.
    host.agent.observe(() => (observing = false));

    // Nada sale de forma síncrona.
    expect(sink.events).toEqual([]);
    const initial = publisher.snapshot();
    expect(initial).toMatchObject({ seq: 1, run: null, toolCalls: [] });
    expect(sessionSnapshotSchema.safeParse(initial).success).toBe(true);
    await tick();
    expect(sink.log).toEqual(['1:session.opened']);

    // Foto a mitad de turno, tomada desde dentro del propio turno.
    const mid: Array<{ seq: number; calls: number; status: string | undefined }> = [];
    for await (const event of host.run('escribe un fichero') as AsyncGenerator<AgentEvent>) {
      if (event.type === 'tool_result') {
        const snap = publisher.snapshot();
        mid.push({ seq: snap.seq, calls: snap.toolCalls.length, status: snap.run?.status });
        expect(snap.session).toMatchObject({ state: 'running', seq: snap.seq });
        expect(snap.toolCalls[0]).toMatchObject({ id: 'c1', state: 'completed' });
      }
    }
    await tick();

    expect(sink.log.filter((l) => l !== 'message.delta')).toEqual([
      '1:session.opened',
      '2:run.started',
      '3:session.updated',
      '4:tool.started',
      '5:tool.completed',
      '6:message.completed',
      '7:run.completed',
      '8:session.updated',
    ]);
    // La foto de mitad de turno es el estado justo tras `tool.completed`.
    expect(mid).toEqual([{ seq: 5, calls: 1, status: 'running' }]);
    // El `session` que viaja en un evento lleva el `seq` de ese evento.
    for (const event of sink.states()) {
      if (event.type === 'session.updated' || event.type === 'session.opened') {
        expect(event.data.session.seq).toBe(event.seq);
      }
    }
    const tool = sink.states().find((e) => e.type === 'tool.started');
    expect(tool).toMatchObject({ data: { call: { name: 'write_file', state: 'running' } } });
    expect(JSON.stringify(tool)).toContain('a.txt');
    expect(sink.states().find((e) => e.type === 'message.completed')).toMatchObject({
      data: { text: 'Hecho.' },
    });

    const final = publisher.snapshot();
    expect(final).toMatchObject({ seq: 8, partial: { text: '', reasoning: '' } });
    expect(final.run).toMatchObject({
      status: 'completed',
      stopReason: 'stop',
      input: 'escribe un fichero',
    });
    expect(final.session).toMatchObject({
      state: 'idle',
      currentRunId: null,
      cwd,
      title: 'escribe un fichero',
    });

    publisher.close('closed');
    // El último evento sale en el acto y después no se publica nada más.
    expect(sink.log.at(-1)).toBe('9:session.closed');
    host.agent.observe(() => undefined);
    await tick();
    expect(sink.states()).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// Con un anfitrión de mentira, para conducir las observaciones a mano
// ---------------------------------------------------------------------------

function fakeHost(sessionId: string, config: StratumConfig) {
  let observer: (o: AgentObservation) => void = () => undefined;
  const agent = {
    observe: (fn: (o: AgentObservation) => void) => {
      observer = fn;
      return () => undefined;
    },
    jobs: undefined,
    inbox: { subscribe: () => () => undefined },
    pause: new PauseController(),
    getContextUsage: () => ({ used: 10, max: 100, pct: 10, estimated: true }),
    getTokenUsage: () => ({ status: 'unavailable' as const }),
    getActiveContext: () => ({ target: 'local', environment: null }),
    getActiveProfile: () => null,
    getSessionProfile: () => ({ name: 'code' }),
    getSessionProfileRequest: () => 'auto',
    isReadOnly: () => false,
    providerName: 'test',
    model: 'test-model',
  };
  const host = {
    sessionId,
    config,
    env: { cwd: join(base, sessionId) },
    agent,
  } as unknown as SessionHost;
  return { host, pause: agent.pause, emit: (o: AgentObservation) => observer(o) };
}

const event = (e: AgentEvent): AgentObservation => ({ type: 'event', event: e });

describe('SessionPublisher — pausa', () => {
  it('publica paused cuando el runtime la alcanza, no cuando se pide; y deja de estarlo al reanudar', async () => {
    const { host, pause, emit } = fakeHost('s-pause', testConfig('pause'));
    const sink = recorder();
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'daemon', client: 'daemon', connected: true },
      sink,
    });
    publisher.start();
    pause.begin();
    emit({ type: 'turn_started', kind: 'run', input: 'trabaja' });
    emit(event({ type: 'text_delta', delta: 'a medias' }));
    const before = publisher.snapshot();

    // Pedida: nada que contar todavía.
    pause.requestPause();
    expect(publisher.seq).toBe(before.seq);
    expect(publisher.snapshot().run?.status).toBe('running');

    // Alcanzada: el run y la sesión lo dicen, y la foto conserva lo que había.
    void pause.waitAtSafePoint();
    const held = publisher.snapshot();
    expect(held.run?.status).toBe('paused');
    expect(held.session).toMatchObject({ state: 'paused', currentRunId: held.run!.id });
    expect(held.partial.text).toBe('a medias');
    expect(publisher.activeRun?.status).toBe('paused');

    pause.resume();
    expect(publisher.snapshot().run?.status).toBe('running');
    expect(publisher.snapshot().session.state).toBe('running');

    // Otra vez, y el turno se cancela en pausa: se cierra como cancelado, sin
    // pasar por `running`.
    pause.requestPause();
    void pause.waitAtSafePoint();
    pause.end();
    emit({ type: 'turn_ended', kind: 'run', stopReason: 'cancelled' });
    await tick();

    const after = sink.states().filter((e) => e.seq > before.seq);
    expect(after.map((e) => e.type)).toEqual([
      'run.updated',
      'session.updated',
      'run.updated',
      'session.updated',
      'run.updated',
      'session.updated',
      'message.completed',
      'run.cancelled',
      'session.updated',
    ]);
    const statuses = after.flatMap((e) =>
      e.type === 'run.updated' || e.type === 'run.cancelled' ? [e.data.run.status] : [],
    );
    expect(statuses).toEqual(['paused', 'running', 'paused', 'cancelled']);
    // Sin huecos: el `seq` sigue siendo el de la sesión.
    expect(after.map((e) => e.seq)).toEqual(after.map((_, i) => before.seq + 1 + i));

    // Quien sigue la sesión por eventos llega a la misma foto que da el anfitrión.
    let reduced = before;
    for (const e of after) reduced = applySessionEvent(reduced, e);
    expect(reduced).toEqual(publisher.snapshot());
  });

  it('con una solicitud abierta, la pausa pedida no tapa la espera', () => {
    const { host, pause, emit } = fakeHost('s-pause-wait', testConfig('pause-wait'));
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'daemon', client: 'daemon', connected: true },
      sink: recorder(),
    });
    publisher.start();
    pause.begin();
    // Un loop que aún puede empezar algo: está esperando a una persona.
    const unit = pause.enter();
    emit({ type: 'turn_started', kind: 'run', input: 'trabaja' });
    pause.requestPause();
    expect(pause.state).toBe('pause-requested');
    expect(publisher.snapshot().session.state).toBe('running');
    unit.leave();
  });
});

describe('SessionPublisher — cola local acotada', () => {
  it('agrupa los fragmentos seguidos y cierra cada bloque con el texto entero', async () => {
    const { host, emit } = fakeHost('s-coalesce', testConfig('coalesce'));
    const sink = recorder();
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink,
    });
    publisher.start();
    emit({ type: 'turn_started', kind: 'run', input: 'hola' });
    for (const delta of ['Vo', 'y a ', 'mirar']) emit(event({ type: 'text_delta', delta }));
    expect(publisher.snapshot().partial.text).toBe('Voy a mirar');
    emit(event({ type: 'tool_call_start', id: 't1', name: 'read_file', input_so_far: '' }));
    await tick();
    const deltas = sink.events.filter((e) => e.type === 'message.delta');
    expect(deltas).toMatchObject([{ after: 3, data: { text: 'Voy a mirar' } }]);
    expect(sink.states().at(-1)).toMatchObject({
      type: 'message.completed',
      data: { text: 'Voy a mirar' },
    });
    expect(publisher.snapshot().partial.text).toBe('');
  });

  it('al llenarse descarta primero lo volátil: los eventos de estado llegan todos', async () => {
    const { host, emit } = fakeHost('s-volatile', testConfig('volatile'));
    const sink = recorder();
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink,
      maxQueue: 12,
    });
    publisher.start();
    emit({ type: 'turn_started', kind: 'run', input: 'hola' });
    // Todo en la misma vuelta: el sink no llega a correr entre medias.
    for (let i = 0; i < 4; i++) {
      emit(event({ type: 'text_delta', delta: `t${i}` }));
      emit(event({ type: 'warning', message: `w${i}` }));
      emit(event({ type: 'thinking', text: `r${i}` }));
    }
    expect(publisher.queued).toBeLessThanOrEqual(12);
    await tick();
    expect(sink.log).not.toContain('OVERFLOW');
    const seqs = sink.states().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(seqs.at(-1)).toBe(publisher.seq);
    // Se perdió texto en vivo, y no pasa nada: sigue en la foto.
    expect(sink.events.filter((e) => !('seq' in e)).length).toBeLessThan(8);
    expect(publisher.snapshot().partial.text).toBe('t0t1t2t3');
  });

  it('si ni así cabe, avisa de la pérdida y el seq sigue: quien recibe resincroniza con la foto', async () => {
    const { host, emit } = fakeHost('s-overflow', testConfig('overflow'));
    const sink = recorder();
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink,
      maxQueue: 8,
    });
    publisher.start();
    await tick();
    emit({ type: 'turn_started', kind: 'run', input: 'hola' });
    let max = 0;
    for (let i = 0; i < 500; i++) {
      emit(event({ type: 'warning', message: `w${i}` }));
      max = Math.max(max, publisher.queued);
    }
    // La memoria no crece con lo que no se pudo entregar.
    expect(max).toBeLessThanOrEqual(8);
    await tick();

    expect(sink.log[0]).toBe('1:session.opened');
    expect(sink.log[1]).toBe('OVERFLOW');
    // Lo que llega después no está renumerado: hay un hueco a la vista.
    const after = sink.states().slice(1);
    expect(after.length).toBeLessThanOrEqual(8);
    expect(after[0]!.seq).toBeGreaterThan(2);
    expect(after.at(-1)!.seq).toBe(publisher.seq);
    expect(publisher.seq).toBe(503);
    // Y la foto dice exactamente dónde está la sesión.
    expect(publisher.snapshot()).toMatchObject({ seq: 503, run: { status: 'running' } });
  });
});

// ---------------------------------------------------------------------------
// memory.write: quién lo intentó, no de quién es el registro
// ---------------------------------------------------------------------------

const VOCAB = ['sqlite', 'chroma', 'docker', 'python'];
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const vec = new Float32Array(VOCAB.length);
    VOCAB.forEach((w, i) => {
      if (t.toLowerCase().includes(w)) vec[i] = 1;
    });
    if (vec.every((x) => x === 0)) vec[0] = 0.001;
    return vec;
  });

describe('SessionPublisher — memory.write', () => {
  it('se atribuye a la sesión que lo intentó, también cuando el registro es de otra (dedup)', async () => {
    // Dos sesiones que comparten la misma memoria de decisiones.
    const configA = testConfig('mem-a', 'shared-memory');
    const configB = testConfig('mem-b', 'shared-memory');
    const memory = new DecisionMemory(configA, {
      embedding: { embedFn: fakeEmbed },
      forceFallbackVectors: true,
    });
    _setDecisionMemory(configA, memory);
    const seen: Array<{ deduped: boolean; attempt: unknown; record: string }> = [];
    memory.subscribe((e) => {
      if (e.type === 'saved')
        seen.push({ deduped: e.deduped, attempt: e.attempt, record: e.record.id });
    });

    const a = fakeHost('sess_A', configA);
    const b = fakeHost('sess_B', configB);
    const sinkA = recorder();
    const sinkB = recorder();
    const hostInfo = { kind: 'daemon', client: 'daemon', connected: true } as const;
    new SessionPublisher({ host: a.host, hostInfo, sink: sinkA }).start();
    new SessionPublisher({ host: b.host, hostInfo, sink: sinkB }).start();

    const decision = {
      title: 'Usar sqlite en vez de chroma',
      content: 'sqlite embebido; chroma exige un servidor.',
      type: 'architectural' as const,
      tags: ['db'],
      importance: 'high' as const,
      source: 'agent' as const,
    };
    const first = await memory.save(decision, { sessionId: 'sess_A', source: 'tool' });
    // B intenta guardar lo mismo: no se escribe nada nuevo, el registro es el de A.
    const second = await memory.save(decision, { sessionId: 'sess_B', source: 'auto-extract' });
    expect(second).toMatchObject({ deduped: true, duplicateOf: first.record.id });
    // Un guardado sin autor declarado no es de ninguna sesión.
    await memory.save({ ...decision, title: 'Docker para python', content: 'docker y python.' });
    await tick();

    expect(seen).toEqual([
      { deduped: false, attempt: { sessionId: 'sess_A', source: 'tool' }, record: first.record.id },
      {
        deduped: true,
        attempt: { sessionId: 'sess_B', source: 'auto-extract' },
        record: first.record.id,
      },
      { deduped: false, attempt: undefined, record: expect.any(String) },
    ]);
    const writes = (sink: ReturnType<typeof recorder>) =>
      sink.states().flatMap((e) => (e.type === 'memory.write' ? [e] : []));
    expect(writes(sinkA)).toMatchObject([
      { sessionId: 'sess_A', data: { memory: { kind: 'write', source: 'tool' } } },
    ]);
    // B publica **su** intento (con el registro que quedó), no un evento de A.
    expect(writes(sinkB)).toMatchObject([
      {
        sessionId: 'sess_B',
        data: {
          memory: {
            kind: 'write',
            source: 'auto-extract',
            decisions: [{ id: first.record.id, title: decision.title }],
          },
        },
      },
    ]);
  });
});

describe('fitSnapshot — una foto tiene que caber en una trama', () => {
  it('con texto corriente no toca nada', () => {
    const snapshot = sampleSnapshot();
    expect(fitSnapshot(snapshot)).toBe(snapshot);
  });

  it('una foto al límite de todo, con texto de varios bytes, se reduce hasta caber y lo dice', () => {
    const wide = (n: number): string => '漢'.repeat(n);
    const messages = Array.from({ length: 12 }, (_, i) => ({
      kind: 'assistant' as const,
      id: `m${i + 1}`,
      runId: 'run_1',
      at: 1,
      text: wide(12_000),
    }));
    const huge = sampleSnapshot({
      partial: { text: wide(100_000), reasoning: wide(100_000) },
      toolCalls: Array.from({ length: 100 }, (_, i) =>
        sampleToolCall({ id: `c${i}`, description: wide(2_000), output: wide(1_000) }),
      ),
      messages,
    });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(MAX_MESSAGE_BYTES);

    const fit = fitSnapshot(huge);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    expect(sessionSnapshotSchema.safeParse(fit).success).toBe(true);
    // Lo primero que se va es lo menos valioso; la conversación, lo último, y se avisa.
    expect(fit.partial.reasoning).toBe('');
    expect(fit.seq).toBe(huge.seq);
    expect(fit.messages.at(-1)).toEqual(messages.at(-1));
    expect(fit.messages.length < messages.length).toBe(fit.messagesTruncated);
    expect(fit.toolCalls).toHaveLength(100);
  });
});

describe('fitSnapshot — postcondición estricta', () => {
  const bytes = (s: ProtocolSessionSnapshot): number =>
    Buffer.byteLength(JSON.stringify(s), 'utf8');
  /** Texto de 4 bytes por carácter visible, con pares de surrogates en cada corte posible. */
  const emoji = (n: number): string => '😀漢'.repeat(Math.floor(n / 3));
  const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  /** Una foto desmesurada en todas sus listas, con una sola entrada de conversación. */
  function monster(messages = 1): ProtocolSessionSnapshot {
    const approval = (i: number) =>
      sampleApproval({
        id: `appr_${i}`,
        description: emoji(2_000),
        reason: emoji(500),
        confirmPhrase: `prod-${i}`,
        forced: true,
      });
    return sampleSnapshot({
      session: sampleSession({ title: emoji(80), cwd: `/work/${emoji(300)}` }),
      run: sampleRun({ input: emoji(2_000), status: 'waiting_approval' }),
      partial: { text: emoji(100_000), reasoning: emoji(100_000) },
      toolCalls: Array.from({ length: 100 }, (_, i) =>
        sampleToolCall({
          id: `call_${i}`,
          state: i % 10 === 0 ? 'running' : 'completed',
          description: emoji(2_000),
          output: emoji(1_000),
        }),
      ),
      subagents: Array.from({ length: 50 }, (_, i) => ({
        id: `sub_${i}`,
        runId: 'run_1',
        profile: 'code',
        task: emoji(1_000),
        status: i < 3 ? ('running' as const) : ('completed' as const),
        summary: emoji(1_000),
        filesChanged: Array.from({ length: 200 }, (_, f) => ({
          path: `src/${emoji(60)}/${f}.ts`,
          action: 'modified' as const,
        })),
      })),
      todos: Array.from({ length: 400 }, (_, i) => ({
        id: `todo_${i}`,
        title: emoji(400),
        status: i < 4 ? ('in_progress' as const) : ('done' as const),
      })),
      jobs: Array.from({ length: 1_500 }, (_, i) => ({
        id: `job_${i}`,
        sessionId: 'ses_20261012_abc123',
        command: emoji(600),
        cwd: `/work/${emoji(100)}`,
        status: i < 5 ? ('running' as const) : ('completed' as const),
        startedAt: 1,
        scope: 'main',
      })),
      approvals: [approval(1), approval(2)],
      questions: [
        {
          id: 'q_1',
          sessionId: 'ses_20261012_abc123',
          runId: 'run_1',
          questions: [
            {
              question: emoji(4_000),
              options: [
                { id: 'opt_a', label: emoji(300) },
                { id: 'opt_b', label: emoji(300) },
              ],
            },
          ],
          requestedAt: 1,
          expiresAt: null,
        },
      ],
      plans: [
        {
          id: 'plan_1',
          sessionId: 'ses_20261012_abc123',
          runId: 'run_1',
          plan: {
            summary: emoji(2_000),
            steps: Array.from({ length: 100 }, (_, i) => ({
              id: `step_${i}`,
              title: emoji(2_000),
              detail: emoji(2_000),
              status: 'pending' as const,
            })),
          },
          requestedAt: 1,
          expiresAt: null,
        },
      ],
      messages: Array.from({ length: messages }, (_, i) => ({
        kind: 'assistant' as const,
        id: `m${i + 1}`,
        runId: 'run_1',
        at: 1,
        text: emoji(12_000),
      })),
    });
  }

  const ids = (items: Array<{ id: string }>): string[] => items.map((i) => i.id);

  it('con una sola entrada de conversación y el resto desmesurado, cabe igual', () => {
    const huge = monster(1);
    // Recortar la conversación ya no puede ayudar: hay que llegar más lejos.
    expect(bytes(huge)).toBeGreaterThan(4 * MAX_MESSAGE_BYTES);
    const fit = fitSnapshot(huge);

    expect(bytes(fit)).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
    expect(sessionSnapshotSchema.safeParse(fit).success).toBe(true);
    expect(LONE_SURROGATE.test(JSON.stringify(fit))).toBe(false);

    // El estado vivo está entero: sesión, run, y todo lo que sigue abierto.
    expect(fit.seq).toBe(huge.seq);
    expect(fit.session.id).toBe(huge.session.id);
    expect(fit.run).toMatchObject({ id: 'run_1', status: 'waiting_approval' });
    const open = huge.toolCalls.filter((c) => c.state === 'running');
    expect(ids(fit.toolCalls.filter((c) => c.state === 'running'))).toEqual(ids(open));
    expect(ids(fit.subagents.filter((a) => a.status === 'running'))).toEqual([
      'sub_0',
      'sub_1',
      'sub_2',
    ]);
    expect(ids(fit.jobs.filter((j) => j.status === 'running'))).toHaveLength(5);
    expect(ids(fit.todos.filter((t) => t.status === 'in_progress'))).toHaveLength(4);
    // Lo terminado se redujo, y en el mismo orden.
    expect(fit.jobs.length).toBeLessThan(huge.jobs.length);
    expect(ids(fit.jobs)).toEqual(ids(huge.jobs).filter((id) => ids(fit.jobs).includes(id)));

    // Lo pendiente se puede seguir resolviendo: ids, opciones y frase, intactos.
    expect(fit.approvals.map((a) => [a.id, a.confirmPhrase, a.forced, a.status])).toEqual([
      ['appr_1', 'prod-1', true, 'pending'],
      ['appr_2', 'prod-2', true, 'pending'],
    ]);
    expect(fit.questions[0]!.questions[0]!.options!.map((o) => o.id)).toEqual(['opt_a', 'opt_b']);
    expect(ids(fit.plans[0]!.plan.steps)).toEqual(ids(huge.plans[0]!.plan.steps));
    expect(fit.messagesTruncated).toBe(fit.messages.length < huge.messages.length);
    // La de entrada no se toca.
    expect(huge.partial.reasoning.length).toBe(99_999);
  });

  it('cada presupuesto fuerza una etapa más, y la postcondición se cumple en todas', () => {
    const huge = monster(40);
    const budgets = [
      SNAPSHOT_BYTE_BUDGET,
      512 * 1024,
      256 * 1024,
      128 * 1024,
      64 * 1024,
      32 * 1024,
      SNAPSHOT_MIN_BUDGET,
    ];
    const sizes: number[] = [];
    for (const budget of budgets) {
      const fit = fitSnapshot(huge, budget);
      const size = bytes(fit);
      sizes.push(size);
      expect(size, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(sessionSnapshotSchema.safeParse(fit).success, `budget ${budget}`).toBe(true);
      expect(LONE_SURROGATE.test(JSON.stringify(fit)), `budget ${budget}`).toBe(false);
      expect(fit.seq).toBe(huge.seq);
      expect(fit.run?.id).toBe('run_1');
      expect(fit.session.state).toBe(huge.session.state);
      // Si falta conversación, se dice.
      if (fit.messages.length < huge.messages.length) expect(fit.messagesTruncated).toBe(true);
    }
    // No es siempre la misma foto mínima: con más sitio se conserva más.
    expect(new Set(sizes).size).toBeGreaterThan(3);
    expect(sizes[0]!).toBeGreaterThan(sizes.at(-1)!);
    // Con sitio, las aprobaciones pendientes no se pierden nunca.
    for (const budget of budgets.slice(0, 5)) {
      expect(ids(fitSnapshot(huge, budget).approvals), `budget ${budget}`).toEqual([
        'appr_1',
        'appr_2',
      ]);
    }
  });

  it('muchas formas de foto, un solo resultado: siempre cabe', () => {
    // Variaciones deterministas: qué lista domina y con cuántos elementos.
    for (let seed = 1; seed <= 24; seed++) {
      const base = monster(seed % 5);
      const pick = <T>(items: T[], every: number): T[] =>
        seed % every === 0 ? items : items.slice(0, Math.max(1, items.length >> (seed % 4)));
      const snapshot: ProtocolSessionSnapshot = {
        ...base,
        toolCalls: pick(base.toolCalls, 2),
        subagents: pick(base.subagents, 3),
        todos: pick(base.todos, 4),
        jobs: pick(base.jobs, 5),
        partial: seed % 2 ? base.partial : { text: '', reasoning: '' },
      };
      const fit = fitSnapshot(snapshot);
      expect(bytes(fit), `seed ${seed}`).toBeLessThanOrEqual(SNAPSHOT_BYTE_BUDGET);
      expect(sessionSnapshotSchema.safeParse(fit).success, `seed ${seed}`).toBe(true);
      expect(ids(fit.approvals), `seed ${seed}`).toEqual(['appr_1', 'appr_2']);
    }
  });
});

describe('SessionPublisher — tool_error vetada', () => {
  it('un tool_error con blocked publica tool.blocked y cuenta en blocked, no en toolErrors', async () => {
    const { host, emit } = fakeHost('s-blocked', testConfig('blocked'));
    const sink = recorder();
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink,
    });
    publisher.start();
    emit({ type: 'turn_started', kind: 'run', input: 'hola' });
    emit(event({ type: 'tool_call_ready', id: 't1', name: 'read_file', input: {} }));
    emit(
      event({
        type: 'tool_error',
        id: 't1',
        name: 'read_file',
        error: 'modo read-only',
        recoverable: true,
        blocked: 'read-only',
      }),
    );
    await tick();
    expect(sink.states().filter((e) => e.type === 'tool.blocked')).toMatchObject([
      { data: { call: { id: 't1', state: 'blocked' }, source: 'read-only' } },
    ]);
    expect(sink.events.some((e) => e.type === 'tool.failed')).toBe(false);
    expect(publisher.snapshot()).toMatchObject({
      run: { counters: { blocked: 1, toolErrors: 0 } },
    });
  });

  it('sin blocked sigue siendo un fallo de la tool: tool.failed y toolErrors', async () => {
    const { host, emit } = fakeHost('s-failed', testConfig('failed'));
    const sink = recorder();
    const publisher = new SessionPublisher({
      host,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink,
    });
    publisher.start();
    emit({ type: 'turn_started', kind: 'run', input: 'hola' });
    emit(event({ type: 'tool_call_ready', id: 't1', name: 'read_file', input: {} }));
    emit(
      event({
        type: 'tool_error',
        id: 't1',
        name: 'read_file',
        error: 'falló de verdad',
        recoverable: true,
      }),
    );
    await tick();
    expect(sink.states().filter((e) => e.type === 'tool.failed')).toMatchObject([
      { data: { call: { id: 't1', state: 'error' }, recoverable: true } },
    ]);
    expect(sink.events.some((e) => e.type === 'tool.blocked')).toBe(false);
    expect(publisher.snapshot()).toMatchObject({
      run: { counters: { blocked: 0, toolErrors: 1 } },
    });
  });
});
