/**
 * M11 — sesiones del daemon que sobreviven a un reinicio de `stratumd`:
 *
 *   chat → muchos turnos → compactación → reinicio → la misma sesión vuelve →
 *   la conversación entera se ve (foto + `sessions.history`) → una pregunta
 *   sobre lo antiguo se contesta con la memoria de sesión.
 *
 * Daemon real sobre un pipe, clientes reales, `SessionHost` real; solo el
 * modelo es de guion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StratumClient } from '../client/client.js';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import type { ProtocolChatMessage, ProtocolEvent } from '../protocol/index.js';
import { SESSION_MEMORY_START } from '../agent/context-builder.js';
import {
  startPeer,
  startTestDaemon,
  watch,
  type Round,
  type TestDaemon,
  type Watcher,
} from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m11-')));
  bases.push(base);
  return base;
}

async function daemonAt(base: string, persist = true): Promise<TestDaemon> {
  const t = await startTestDaemon({
    base,
    ...(persist ? { sessionsDir: join(base, 'daemon', 'sessions') } : {}),
  });
  daemons.push(t);
  return t;
}

const filler = (n: number): string => 'relleno '.repeat(n).trim();

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) =>
      err instanceof ProtocolError
        ? `${err.code}${(err.data as { reason?: string } | undefined)?.reason ? `:${(err.data as { reason: string }).reason}` : ''}`
        : `threw ${String(err)}`,
  );

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

/** Toda la conversación guardada, de atrás adelante con `sessions.history`. */
async function fullHistory(
  client: StratumClient,
  sessionId: string,
): Promise<ProtocolChatMessage[]> {
  const out: ProtocolChatMessage[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await client.request('sessions.history', {
      sessionId,
      limit: 25,
      ...(before ? { before } : {}),
    });
    out.unshift(...page.messages);
    if (!page.hasMore || page.messages.length === 0) return out;
    before = page.messages[0]!.id;
  }
}

/** Ventana con la que, para una sesión real del daemon, caben `room` tokens de conversación. */
async function windowFor(base: string, room: number): Promise<number> {
  const probe = await daemonAt(newBase(), false);
  const cwd = probe.project('probe', []);
  const client = await probe.connect(['operator']);
  const { session } = await client.request('sessions.open', { cwd });
  const { report } = await client.request('sessions.context', { sessionId: session.id });
  void base;
  return Math.ceil((report.context!.system + report.context!.tools + room) / 0.7) + 1_024;
}

function smallWindow(window: number): Record<string, unknown> {
  return {
    provider: {
      default: 'test',
      providers: {
        test: {
          type: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: '',
          model: 'test-model',
          contextWindow: window,
        },
      },
    },
    context: { reserveOutput: 1_024 },
  };
}

/** El extractor del guion: un hecho por cada «dato: clave=valor» del trozo, con su fuente. */
function extractFacts(prompt: string): string {
  const items: unknown[] = [];
  const re = /\[(e\d+) user\]\n[^\n]*dato: (\S+)/g;
  for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
    items.push({ kind: 'fact', key: m[2]!.split('=')[0], text: m[2], sources: [m[1]] });
  }
  return JSON.stringify({ items });
}

describe('M11 — una sesión del daemon sobrevive a un reinicio', () => {
  it('compacta, se reinicia, vuelve entera y contesta sobre lo antiguo con su memoria', async () => {
    const base = newBase();
    const window = await windowFor(base, 3_000);
    const turns = 30;
    const rounds: Round[] = Array.from({ length: turns }, (_, i) => makeTextRound(`Vale ${i}.`));

    // ── Primer daemon: una conversación larga ─────────────────────────────
    const first = await daemonAt(base);
    const cwd = first.project('larga', rounds, smallWindow(window));
    const dot = await first.connect(['operator'], 'dot');
    const { session } = await dot.request('sessions.open', { cwd });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    first.provider(cwd).memory.extractor = extractFacts;

    await ask(dot, live, session.id, `dato: proyecto=orca ${filler(90)}`);
    for (let i = 1; i < turns; i++) await ask(dot, live, session.id, `turno ${i} ${filler(90)}`);

    const before = (await dot.request('sessions.context', { sessionId: session.id })).report;
    expect(before.conversation!.compactions).toBeGreaterThan(0);
    expect(before.conversation!.storedMessages).toBe(turns * 2);
    expect(before.context!.activeMessages).toBeLessThan(turns * 2);
    expect(before.memory).toMatchObject({ enabled: true, hasSummary: true });
    const memory = (await dot.request('sessions.memory', { sessionId: session.id })).memory;
    expect(memory.items.find((i) => i.text === 'proyecto=orca')).toMatchObject({
      kind: 'fact',
      status: 'active',
      sources: ['e1'],
    });
    const { snapshot: lastSnapshot } = await dot.request('sessions.get', { sessionId: session.id });
    const transcriptBefore = await fullHistory(dot, session.id);
    expect(transcriptBefore).toHaveLength(turns * 2);

    // ── Reinicio ──────────────────────────────────────────────────────────
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);
    const dir = join(base, 'daemon', 'sessions', session.id);
    expect(readdirSync(dir).sort()).toEqual(
      ['context.json', 'conversation.jsonl', 'memory.json', 'session.json', 'snapshot.json'].sort(),
    );
    // Nada de claves ni del entorno en disco.
    const onDisk = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    expect(onDisk).not.toContain('STRATUMD_TEST');

    const second = await daemonAt(base);
    second.project('larga', [makeTextRound('El proyecto se llama orca.')], smallWindow(window));
    const client = await second.connect(['operator'], 'dot');

    // La misma sesión, en la lista, parada y del daemon.
    const listed = (await client.request('sessions.list', {})).sessions;
    expect(listed.map((s) => s.id)).toEqual([session.id]);
    expect(listed[0]).toMatchObject({ state: 'idle', host: { kind: 'daemon' }, cwd });

    // Dot ve la conversación entera: la foto lleva lo último y el resto se pagina.
    const { snapshot } = await client.request('sessions.get', { sessionId: session.id });
    expect(snapshot.seq).toBeGreaterThanOrEqual(lastSnapshot.seq);
    expect(snapshot.messages.map((m) => m.id)).toEqual(lastSnapshot.messages.map((m) => m.id));
    const transcriptAfter = await fullHistory(client, session.id);
    expect(transcriptAfter).toEqual(transcriptBefore);
    expect(transcriptAfter[0]).toMatchObject({
      kind: 'user',
      text: expect.stringContaining('dato: proyecto=orca'),
    });

    // Sin montar todavía: el informe sale del disco.
    const dormant = (await client.request('sessions.context', { sessionId: session.id })).report;
    expect(dormant.context).toBeNull();
    expect(dormant.conversation).toMatchObject({
      storedMessages: turns * 2,
      compactions: before.conversation!.compactions,
    });

    // Una pregunta sobre lo antiguo: se monta y el modelo tiene la memoria de sesión.
    const live2 = watch(client, session.id);
    const firstSnap = await live2.untilSnapshot();
    await ask(client, live2, session.id, '¿Cómo se llamaba el proyecto?');
    const provider = second.provider(cwd);
    const system = provider.systemPrompts.at(-1)!;
    expect(system).toContain(SESSION_MEMORY_START);
    expect(system).toContain('proyecto=orca');
    // El turno 0 no está literal en el contexto: se contesta por la memoria.
    expect(provider.userInputs.at(-1)!.some((u) => u.includes('dato: proyecto=orca'))).toBe(false);
    // El `seq` continúa, sin volver a empezar.
    const seqs = live2.seqs();
    expect(seqs[0]).toBe(firstSnap.seq + 1);
    const { snapshot: after } = await client.request('sessions.get', { sessionId: session.id });
    expect(after.messages.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'El proyecto se llama orca.',
    });
    expect((await fullHistory(client, session.id)).length).toBe(turns * 2 + 2);
  }, 120_000);

  it('una sesión cerrada con sessions.close no vuelve; una muerta a la fuerza sí', async () => {
    const base = newBase();
    const first = await daemonAt(base);
    const cwdA = first.project('a', [makeTextRound('A.')]);
    const cwdB = first.project('b', [makeTextRound('B.')]);
    const client = await first.connect(['operator']);
    const a = (await client.request('sessions.open', { cwd: cwdA })).session;
    const b = (await client.request('sessions.open', { cwd: cwdB })).session;
    const liveB = watch(client, b.id);
    await liveB.untilSnapshot();
    await ask(client, liveB, b.id, 'hola b');
    await client.request('sessions.close', { sessionId: a.id });
    expect(existsSync(join(base, 'daemon', 'sessions', a.id))).toBe(false);
    // Muere sin apagarse: lo guardado al cerrar el turno basta.
    await first.daemon.crash();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemonAt(base);
    second.project('b', [makeTextRound('B otra vez.')]);
    const c2 = await second.connect(['operator']);
    const ids = (await c2.request('sessions.list', {})).sessions.map((s) => s.id);
    expect(ids).toEqual([b.id]);
    const page = await c2.request('sessions.history', { sessionId: b.id });
    expect(page.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);

    // Cerrarla sin haberla montado la borra también.
    await c2.request('sessions.close', { sessionId: b.id });
    expect((await c2.request('sessions.list', {})).sessions).toEqual([]);
    expect(existsSync(join(base, 'daemon', 'sessions', b.id))).toBe(false);
  });

  it('sessions.open { resume } monta la guardada: misma sesión, sus ajustes, una sola vez', async () => {
    const base = newBase();
    const first = await daemonAt(base);
    const cwd = first.project('r', [makeTextRound('Antes.')]);
    const client = await first.connect(['operator'], 'dot', { kind: 'dot' });
    const { session } = await client.request('sessions.open', { cwd, readOnly: true });
    const live = watch(client, session.id);
    await live.untilSnapshot();
    await ask(client, live, session.id, 'hola');
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemonAt(base);
    second.project('r', [makeTextRound('Después.')]);
    const c2 = await second.connect(['operator']);
    // Es la misma sesión: no admite los ajustes de una nueva.
    expect(await failure(c2.request('sessions.open', { resume: session.id, cwd }))).toBe(
      'INVALID_PARAMS',
    );
    expect(
      await failure(c2.request('sessions.open', { resume: session.id, readOnly: false })),
    ).toBe('INVALID_PARAMS');
    expect(second.daemon.liveSessions).toBe(0);

    // Dos a la vez montan una sola.
    const [a, b] = await Promise.all([
      c2.request('sessions.open', { resume: session.id }),
      c2.request('sessions.open', { resume: session.id }),
    ]);
    expect(a.session).toMatchObject({ id: session.id, cwd, readOnly: true, origin: 'dot' });
    expect(b.session.id).toBe(session.id);
    expect(second.daemon.liveSessions).toBe(1);
    // Montada: el contexto activo ya existe, y la conversación sigue ahí.
    const report = (await c2.request('sessions.context', { sessionId: session.id })).report;
    expect(report.context).not.toBeNull();
    expect((await fullHistory(c2, session.id)).map((m) => m.kind)).toEqual(['user', 'assistant']);
    // Ya montada: se devuelve tal cual.
    const again = await c2.request('sessions.open', { resume: session.id });
    expect(again.session.id).toBe(session.id);
    expect(second.daemon.liveSessions).toBe(1);
    expect((await c2.request('sessions.list', {})).sessions.map((s) => s.id)).toEqual([session.id]);
  });

  it('sin la carpeta de sesiones, la conversación vive en memoria y se pagina igual', async () => {
    const base = newBase();
    const t = await daemonAt(base, false);
    const cwd = t.project('mem', [makeTextRound('uno'), makeTextRound('dos')]);
    const client = await t.connect(['operator']);
    const { session } = await client.request('sessions.open', { cwd });
    const live = watch(client, session.id);
    await live.untilSnapshot();
    await ask(client, live, session.id, 'a');
    await ask(client, live, session.id, 'b');
    const page = await client.request('sessions.history', { sessionId: session.id, limit: 2 });
    expect(page).toMatchObject({ hasMore: true, total: 4 });
    expect(page.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect(
      await failure(client.request('sessions.history', { sessionId: session.id, before: 'm999' })),
    ).toBe('INVALID_PARAMS');
    expect(existsSync(join(base, 'daemon', 'sessions'))).toBe(false);
  });
});

describe('M11 — compatibilidad con M10 (traspaso)', () => {
  it('chat → detach → daemon: se guarda; tras reiniciar, vuelve con su conversación y su contexto', async () => {
    const base = newBase();
    const first = await daemonAt(base);
    const peer = await startPeer(first, 'par', [makeTextRound('Hola desde el par.')]);
    await peer.run('dato: equipo=rojo');
    const observer = await first.connect(['operator']);
    expect(await failure(observer.request('sessions.history', { sessionId: peer.sessionId }))).toBe(
      'UNAVAILABLE:peer-hosted',
    );
    expect(await failure(observer.request('sessions.open', { resume: peer.sessionId }))).toBe(
      'UNAVAILABLE:peer-hosted',
    );
    // El daemon monta la sesión que recibe en ese directorio.
    first.project('par', []);
    const outcome = await peer.detach();
    expect(outcome.status).toBe('detached');

    const live = await observer.request('sessions.history', { sessionId: peer.sessionId });
    expect(live.messages.map((m) => m.kind)).toEqual(['user', 'assistant']);
    await peer.stop();
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemonAt(base);
    second.project('par', [makeTextRound('Era rojo.')]);
    const client = await second.connect(['operator']);
    const listed = (await client.request('sessions.list', {})).sessions;
    expect(listed.map((s) => s.id)).toEqual([peer.sessionId]);
    const history = await fullHistory(client, peer.sessionId);
    expect(history.map((m) => m.kind)).toEqual(['user', 'assistant']);
    expect(history[0]).toMatchObject({ text: 'dato: equipo=rojo' });

    const w = watch(client, peer.sessionId);
    await w.untilSnapshot();
    await ask(client, w, peer.sessionId, '¿de qué color era el equipo?');
    // El contexto del agente que traspasó el par sigue ahí.
    const inputs = second.provider(join(base, 'par')).userInputs.at(-1)!;
    expect(inputs).toEqual(
      expect.arrayContaining(['dato: equipo=rojo', '¿de qué color era el equipo?']),
    );
  });
});
