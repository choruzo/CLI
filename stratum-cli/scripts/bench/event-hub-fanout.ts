/**
 * Banco del reparto de eventos del daemon (`EventHub`): cuánto cuesta entregar
 * un turno a N clientes que siguen la misma sesión. Cada cliente falso codifica
 * la notificación con el codificador real (`encodeMessage`), como su conexión.
 *
 *   npx tsx scripts/bench/event-hub-fanout.ts [rondas]
 *
 * Mide tiempo de CPU del proceso (ingesta + entrega), no la red.
 */
import { EventHub, type HubClient } from '../../src/daemon/event-hub.js';
import { encodeMessage } from '../../src/ipc/codec.js';
import type { ProtocolEvent } from '../../src/protocol/index.js';

const SESSION = 'sess_bench';
const rounds = Number(process.argv[2] ?? 5);

/** Un turno: 400 fragmentos de texto, 30 tools con 4 KB de salida y 6 bloques de texto. */
function turn(startSeq: number): { events: ProtocolEvent[]; nextSeq: number } {
  const events: ProtocolEvent[] = [];
  let seq = startSeq;
  const at = Date.now();
  const state = (type: string, data: unknown): void => {
    events.push({
      type,
      sessionId: SESSION,
      runId: 'run_1',
      at,
      seq: ++seq,
      data,
    } as ProtocolEvent);
  };
  const output = 'línea de salida de la herramienta con algo de texto\n'.repeat(80); // ~4 KB
  for (let block = 0; block < 6; block++) {
    for (let d = 0; d < 66; d++) {
      events.push({
        type: 'message.delta',
        sessionId: SESSION,
        runId: 'run_1',
        at,
        after: seq,
        data: { text: 'unas palabras más ' },
      } as ProtocolEvent);
    }
    state('message.completed', { text: 'texto completo del bloque '.repeat(60) });
    for (let t = 0; t < 5; t++) {
      const call = {
        id: `c${block}_${t}`,
        name: 'read_file',
        description: 'read_file src/algo.ts',
        state: 'running',
      };
      state('tool.started', { call });
      state('tool.completed', { call: { ...call, state: 'completed', output, durationMs: 12 } });
    }
  }
  return { events, nextSeq: seq };
}

function fakeClient(id: number): HubClient & { bytes: number; frames: number } {
  return {
    id,
    bytes: 0,
    frames: 0,
    ready: () => true,
    notify(name, params) {
      this.sendEncoded(encodeMessage({ method: name, params }));
    },
    sendEncoded(line) {
      this.bytes += line.length;
      this.frames++;
    },
  };
}

const tickOver = (): Promise<void> => new Promise((r) => setImmediate(r));

async function run(clients: number): Promise<{ ms: number; frames: number; mb: number }> {
  const hub = new EventHub({
    snapshotOf: () => null,
    overviewOf: () => ({ sessions: [], pending: [] }) as never,
  });
  hub.openSession(SESSION);
  const fakes = Array.from({ length: clients }, (_, i) => fakeClient(i + 1));
  for (const c of fakes) hub.subscribe(c, { kind: 'session', sessionId: SESSION, sinceSeq: 0 });
  await tickOver();
  let seq = 0;
  const batches: ProtocolEvent[][] = [];
  for (let r = 0; r < rounds; r++) {
    const t = turn(seq);
    seq = t.nextSeq;
    // El publicador entrega por lotes pequeños.
    for (let i = 0; i < t.events.length; i += 16) batches.push(t.events.slice(i, i + 16));
  }
  const start = process.cpuUsage();
  const wall = performance.now();
  for (const batch of batches) {
    hub.ingest(SESSION, batch);
    await tickOver();
  }
  await tickOver();
  const cpu = process.cpuUsage(start);
  void wall;
  return {
    ms: (cpu.user + cpu.system) / 1000,
    frames: fakes.reduce((n, c) => n + c.frames, 0),
    mb: fakes.reduce((n, c) => n + c.bytes, 0) / 1e6,
  };
}

async function main(): Promise<void> {
  await run(5); // calentamiento del JIT
  console.log(`rondas=${rounds}  (CPU de ingesta + entrega; mediana de 5)`);
  for (const clients of [1, 10, 50]) {
    const samples: Array<{ ms: number; frames: number; mb: number }> = [];
    for (let i = 0; i < 5; i++) samples.push(await run(clients));
    samples.sort((a, b) => a.ms - b.ms);
    const m = samples[2]!;
    console.log(
      `clientes=${String(clients).padStart(2)}  cpu=${m.ms.toFixed(1).padStart(7)} ms  ` +
        `por cliente=${(m.ms / clients).toFixed(2)} ms  tramas=${m.frames}  salida=${m.mb.toFixed(1)} MB`,
    );
  }
}

void main();
