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
import { SessionPublisher, type PublisherSink } from './session-publisher.js';

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
