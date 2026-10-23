/**
 * `trace.subscribe` contra un daemon real: la traza que la sesión del daemon
 * escribe en `<trace.dir>/<sessionId>.jsonl` se retransmite al cliente suscrito
 * —antes y después del turno, con la sesión montada, con un id inventado, con
 * una sesión par y con una guardada sin montar. Daemon real sobre un pipe,
 * cliente real (`StratumClient`); solo el modelo es de guion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StratumClient } from '../client/client.js';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import type { ProtocolEvent } from '../protocol/index.js';
import {
  startPeer,
  startTestDaemon,
  watch,
  type TestDaemon,
  type Watcher,
} from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const peers: Array<{ stop(): Promise<void> }> = [];
const bases: string[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-trace-')));
  bases.push(base);
  return base;
}

async function daemonAt(base: string): Promise<TestDaemon> {
  const t = await startTestDaemon({
    base,
    sessionsDir: join(base, 'daemon', 'sessions'),
    tracePollMs: 20,
  });
  daemons.push(t);
  return t;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** La traza activa de un proyecto del test, en la carpeta del test. */
const traceExtra = (base: string): Record<string, unknown> => ({
  trace: { enabled: true, dir: join(base, 'traces') },
});

type TraceBatch = { records: Array<Record<string, unknown>>; reset: boolean; format: number };

interface TraceSight {
  readonly batches: TraceBatch[];
  readonly errors: unknown[];
  close(): void;
}

/** Una suscripción de traza que apunta lo que llega, sin lanzar nunca. */
function collectTrace(client: StratumClient, sessionId: string): TraceSight {
  const batches: TraceBatch[] = [];
  const errors: unknown[] = [];
  const subscription = client.subscribeTrace(sessionId, {
    onRecords: (records, reset, format) => batches.push({ records, reset, format }),
    onError: (err) => errors.push(err),
  });
  return { batches, errors, close: () => subscription.close() };
}

const flatRecords = (sight: TraceSight): Array<Record<string, unknown>> =>
  sight.batches.flatMap((b) => b.records);

const hasRecord = (sight: TraceSight, match: (r: Record<string, unknown>) => boolean): boolean =>
  flatRecords(sight).some(match);

/** Espera por sondeo a que la traza vista cumpla `cond`; falla con su primer error. */
async function untilTrace(
  sight: TraceSight,
  cond: (sight: TraceSight) => boolean,
  ms = 10_000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (sight.errors.length > 0) throw sight.errors[0];
    if (cond(sight)) return;
    if (Date.now() - t0 >= ms) throw new Error('untilTrace: la traza no llegó a tiempo');
    await delay(25);
  }
}

/** Espera por sondeo a una condición sobre el disco (la traza escrita). */
async function untilFile(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 >= ms) throw new Error('untilFile: el fichero no llegó a tiempo');
    await delay(25);
  }
}

/** Un turno por el protocolo, esperando a que su run termine. */
async function ask(
  client: StratumClient,
  live: Watcher,
  sessionId: string,
  input: string,
): Promise<string> {
  const { run } = await client.request('runs.start', { sessionId, input });
  await live.until(
    (e: ProtocolEvent) =>
      e.type === 'run.completed' && (e.data as { run: { id: string } }).run.id === run.id,
    20_000,
  );
  return run.id;
}

describe('trace.subscribe contra el daemon', () => {
  it('suscripción antes del primer turno: reset vacío; el turno llega después con reset false, con turn y model', async () => {
    const t = await startTestDaemon({ tracePollMs: 20 });
    daemons.push(t);
    const cwd = t.project('viva', [makeTextRound('Hecho.')], traceExtra(t.base));
    const client = await t.connect(['operator']);
    const { session } = await client.request('sessions.open', { cwd });
    const live = watch(client, session.id);
    await live.untilSnapshot();

    const sight = collectTrace(client, session.id);
    await untilTrace(sight, (s) => s.batches.length >= 1);
    expect(sight.batches[0]).toMatchObject({ reset: true, format: 1 });
    expect(sight.batches[0].records).toEqual([]);

    await ask(client, live, session.id, 'hola traza');
    await untilTrace(sight, (s) => hasRecord(s, (r) => r.t === 'turn'));
    await untilTrace(sight, (s) => hasRecord(s, (r) => r.kind === 'model'));
    const records = flatRecords(sight);
    expect(records.find((r) => r.t === 'turn')).toMatchObject({ input: 'hola traza' });
    expect(records.find((r) => r.kind === 'model')).toMatchObject({ t: 'begin' });
    // El reset solo sale una vez; el resto son líneas nuevas.
    expect(sight.batches.slice(1).every((b) => b.reset === false)).toBe(true);
    for (const b of sight.batches) expect(b.format).toBe(1);
    expect(sight.errors).toEqual([]);
  }, 30_000);

  it('suscripción después del turno: el primer reset ya trae lo escrito, sin repetirlo luego', async () => {
    const t = await startTestDaemon({ tracePollMs: 20 });
    daemons.push(t);
    const cwd = t.project('tardia', [makeTextRound('A toca.')], traceExtra(t.base));
    const client = await t.connect(['operator']);
    const { session } = await client.request('sessions.open', { cwd });
    const live = watch(client, session.id);
    await live.untilSnapshot();
    await ask(client, live, session.id, 'primero la traza');
    // `run.completed` no garantiza que el recorder ya haya volcado la traza:
    // el caso es suscribirse cuando lo escrito ya está en disco.
    const traceFile = join(t.base, 'traces', `${session.id}.jsonl`);
    await untilFile(() => {
      if (!existsSync(traceFile)) return false;
      const text = readFileSync(traceFile, 'utf8');
      return text.includes('"t":"turn"') && text.includes('"kind":"model"');
    });

    const sight = collectTrace(client, session.id);
    await untilTrace(
      sight,
      (s) => hasRecord(s, (r) => r.t === 'turn') && hasRecord(s, (r) => r.kind === 'model'),
    );
    // El primer lote ya trae lo escrito; lo que el recorder añada después llega
    // detrás, sin otro reset y sin repetir nada.
    expect(sight.batches[0]).toMatchObject({ reset: true, format: 1 });
    expect(sight.batches[0].records.some((r) => r.t === 'turn')).toBe(true);
    expect(sight.batches.slice(1).every((b) => b.reset === false)).toBe(true);
    const records = flatRecords(sight);
    expect(records.filter((r) => r.t === 'meta')).toHaveLength(1);
    expect(records.filter((r) => r.t === 'turn')).toHaveLength(1);
    expect(records.some((r) => r.kind === 'model')).toBe(true);
  }, 30_000);

  it('trace.subscribe de un id que no existe: NOT_FOUND', async () => {
    const t = await startTestDaemon({ tracePollMs: 20 });
    daemons.push(t);
    const client = await t.connect(['operator']);
    let err: unknown;
    try {
      await client.request('trace.subscribe', { sessionId: 'sess_20260101_000000_abc' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('NOT_FOUND');
  });

  it('la traza de una sesión par la escribe su proceso: UNAVAILABLE con reason peer-hosted', async () => {
    const t = await startTestDaemon({ tracePollMs: 20 });
    daemons.push(t);
    const peer = await startPeer(t, 'par', [makeTextRound('Hola desde el par.')]);
    peers.push(peer);
    const client = await t.connect(['operator']);

    // La publicación del par puede tardar un pelín: se reintenta hasta el código final.
    let err: unknown;
    const t0 = Date.now();
    for (;;) {
      try {
        await client.request('trace.subscribe', { sessionId: peer.sessionId });
        err = null;
      } catch (e) {
        err = e;
        if (
          e instanceof ProtocolError &&
          e.code === 'UNAVAILABLE' &&
          (e.data as { reason?: string } | undefined)?.reason === 'peer-hosted'
        ) {
          break;
        }
      }
      if (Date.now() - t0 >= 10_000) break;
      await delay(25);
    }
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('UNAVAILABLE');
    expect((err as ProtocolError).data).toMatchObject({ reason: 'peer-hosted' });

    await peer.stop();
    peers.splice(peers.indexOf(peer), 1);
  }, 30_000);

  it('sesión guardada sin montar: su traza se sirve con reset true, sin montar la sesión', async () => {
    const base = newBase();
    const first = await daemonAt(base);
    const cwd = first.project('guardada', [makeTextRound('Del primer daemon.')], traceExtra(base));
    // La traza de una sesión guardada sale de la config de su directorio: el
    // proyecto necesita su fichero de config con la traza activa.
    writeFileSync(join(cwd, '.stratumrc.json'), JSON.stringify(traceExtra(base)));
    const client = await first.connect(['operator']);
    const { session } = await client.request('sessions.open', { cwd });
    const live = watch(client, session.id);
    await live.untilSnapshot();
    await ask(client, live, session.id, 'la traza que sobrevive');

    const traceFile = join(base, 'traces', `${session.id}.jsonl`);
    await untilFile(
      () => existsSync(traceFile) && readFileSync(traceFile, 'utf8').includes('"t":"turn"'),
    );

    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemonAt(base);
    second.project('guardada', [makeTextRound('Del segundo.')], traceExtra(base));
    const client2 = await second.connect(['operator']);
    expect(second.daemon.liveSessions).toBe(0);

    const sight = collectTrace(client2, session.id);
    await untilTrace(sight, (s) => hasRecord(s, (r) => r.t === 'turn'));
    expect(sight.batches[0]).toMatchObject({ reset: true, format: 1 });
    expect(sight.batches[0].records.some((r) => r.t === 'turn')).toBe(true);
    expect(sight.batches[0].records.some((r) => r.kind === 'model')).toBe(true);
    expect(second.daemon.liveSessions).toBe(0);
  }, 60_000);

  it('trace.unsubscribe devuelve {} y repetirlo también', async () => {
    const t = await startTestDaemon({ tracePollMs: 20 });
    daemons.push(t);
    const cwd = t.project('baja', [makeTextRound('Nada.')], traceExtra(t.base));
    const client = await t.connect(['operator']);
    const { session } = await client.request('sessions.open', { cwd });
    const { subscriptionId } = await client.request('trace.subscribe', { sessionId: session.id });
    expect(await client.request('trace.unsubscribe', { subscriptionId })).toEqual({});
    expect(await client.request('trace.unsubscribe', { subscriptionId })).toEqual({});
  });
});
