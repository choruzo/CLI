/**
 * Cierre de M14 — conversación nueva del `companion` (`docs/protocol.md` §22.1),
 * sobre un daemon real con clientes reales:
 *
 *  - `sessions.open { agent: 'companion', fresh: true }` compacta entera la
 *    conversación actual, la archiva (en disco, no se borra ni se recupera al
 *    arrancar) y abre otra que hereda su memoria;
 *  - lo heredado llega al modelo y a `sessions.memory`, y siembra el resumen;
 *  - un fallo de la compactación deja la actual como estaba y siendo la suya;
 *  - con un run en curso, `BUSY`; `fresh` sin `companion`, `INVALID_PARAMS`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import {
  idleAgain,
  startTestDaemon,
  watch,
  type Round,
  type TestDaemon,
} from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-fresh-')));
  bases.push(base);
  return base;
}

const sessionsDir = (base: string): string => join(base, 'daemon', 'sessions');

async function daemonAt(base: string): Promise<TestDaemon> {
  const t = await startTestDaemon({ base, sessionsDir: sessionsDir(base) });
  daemons.push(t);
  return t;
}

function companionProject(t: TestDaemon, rounds: Round[]): string {
  return t.project(join('companion', 'workspace'), rounds, { box: { enabled: true } });
}

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

/** El extractor apunta un hecho con la primera entrada que vea; el resumen, fijo. */
function rememberingModel(t: TestDaemon, cwd: string, fact: string, summary: string): void {
  t.provider(cwd).memory = {
    extractor: (prompt) => {
      const id = /\[(e\d+) /.exec(prompt.slice(prompt.indexOf('<conversation>')))?.[1];
      return JSON.stringify({
        items: [{ kind: 'fact', key: 'pet-name', text: fact, sources: [id] }],
      });
    },
    summarizer: () => summary,
  };
}

describe('cierre de M14 — conversación nueva del companion', () => {
  it('compacta y archiva la actual; la nueva hereda su memoria, también tras un reinicio', async () => {
    const base = newBase();
    const t = await daemonAt(base);
    const cwd = companionProject(t, [
      makeTextRound('Apuntado: Toby.'),
      makeTextRound('Hola de nuevo.'),
    ]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session: old } = await dot.request('sessions.open', { agent: 'companion' });
    rememberingModel(t, cwd, 'The user dog is called Toby.', 'The user told the agent about Toby.');
    const live = watch(dot, old.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: old.id, input: 'mi perro se llama Toby' });
    await live.until(idleAgain);

    const opened = await dot.request('sessions.open', { agent: 'companion', fresh: true });
    expect(opened.session.id).not.toBe(old.id);
    expect(opened.session).toMatchObject({ agent: 'companion', cwd });
    expect(opened.archived).toEqual({ sessionId: old.id, memoryCarried: true });

    // La anterior: fuera de la lista y archivada en disco, con su conversación.
    const listed = (await dot.request('sessions.list', {})).sessions;
    expect(listed.filter((s) => s.agent === 'companion').map((s) => s.id)).toEqual([
      opened.session.id,
    ]);
    expect(existsSync(join(sessionsDir(base), old.id))).toBe(false);
    expect(existsSync(join(sessionsDir(base), 'archived', old.id, 'conversation.jsonl'))).toBe(
      true,
    );

    // Abrir sin `fresh` devuelve la nueva.
    const again = await dot.request('sessions.open', { agent: 'companion' });
    expect(again.session.id).toBe(opened.session.id);

    // Lo heredado, con procedencia, en `sessions.memory`; la memoria propia, vacía.
    const { memory } = await dot.request('sessions.memory', { sessionId: opened.session.id });
    expect(memory.items).toEqual([]);
    expect(memory.inherited).toMatchObject({
      fromSessionId: old.id,
      summary: 'The user told the agent about Toby.',
      items: [
        {
          kind: 'fact',
          key: 'pet-name',
          text: 'The user dog is called Toby.',
          origin: { sessionId: old.id, sourceCount: 1 },
        },
      ],
    });

    // Y llega al modelo en el system prompt, sin la conversación vieja literal.
    const w = watch(dot, opened.session.id);
    await w.untilSnapshot();
    await dot.request('runs.start', { sessionId: opened.session.id, input: 'hola' });
    await w.until(idleAgain);
    const provider = t.provider(cwd);
    expect(provider.systemPrompts.at(-1)).toContain('From the previous conversation');
    expect(provider.systemPrompts.at(-1)).toContain('The user dog is called Toby.');
    expect(provider.userInputs.at(-1)).toEqual(['hola']);

    // Tras un reinicio: la nueva sigue siendo la suya, con lo heredado; la archivada no vuelve.
    await t.stop();
    daemons.splice(daemons.indexOf(t), 1);
    const second = await daemonAt(base);
    companionProject(second, []);
    const dot2 = await second.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const after = (await dot2.request('sessions.list', {})).sessions;
    expect(after.some((s) => s.id === old.id)).toBe(false);
    const reopened = await dot2.request('sessions.open', { agent: 'companion' });
    expect(reopened.session.id).toBe(opened.session.id);
    const restored = await dot2.request('sessions.memory', { sessionId: opened.session.id });
    expect(restored.memory.inherited?.fromSessionId).toBe(old.id);
  });

  it('lo heredado siembra el resumen de la nueva y pasa a la siguiente', async () => {
    const t = await daemonAt(newBase());
    const cwd = companionProject(t, [makeTextRound('Vale.'), makeTextRound('Vale otra vez.')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session: first } = await dot.request('sessions.open', { agent: 'companion' });
    rememberingModel(t, cwd, 'The user dog is called Toby.', 'First summary.');
    let w = watch(dot, first.id);
    await w.untilSnapshot();
    await dot.request('runs.start', { sessionId: first.id, input: 'mi perro es Toby' });
    await w.until(idleAgain);
    const { session: second } = await dot.request('sessions.open', {
      agent: 'companion',
      fresh: true,
    });

    // La segunda: otro hecho; su resumen parte del heredado.
    const provider = t.provider(cwd);
    provider.memory = {
      extractor: (prompt) => {
        const id = /\[(e\d+) /.exec(prompt.slice(prompt.indexOf('<conversation>')))?.[1];
        return JSON.stringify({
          items: [{ kind: 'fact', key: 'city', text: 'The user lives in Bilbao.', sources: [id] }],
        });
      },
      summarizer: () => 'Second summary.',
    };
    w = watch(dot, second.id);
    await w.untilSnapshot();
    await dot.request('runs.start', { sessionId: second.id, input: 'vivo en Bilbao' });
    await w.until(idleAgain);
    const third = await dot.request('sessions.open', { agent: 'companion', fresh: true });

    const summarizer = provider.memoryPrompts.filter((p) => p.role === 'summarizer').at(-1);
    expect(summarizer?.prompt).toContain('(from the previous conversation)\nFirst summary.');
    const { memory } = await dot.request('sessions.memory', { sessionId: third.session.id });
    expect(memory.inherited?.fromSessionId).toBe(second.id);
    expect(memory.inherited?.summary).toBe('Second summary.');
    // Lo de la primera sigue, con su procedencia; lo propio de la segunda va primero.
    expect(memory.inherited?.items.map((i) => [i.key, i.origin.sessionId])).toEqual([
      ['city', second.id],
      ['pet-name', first.id],
    ]);
  });

  it('si la compactación falla, la actual se queda como estaba y sigue siendo la suya', async () => {
    const base = newBase();
    const t = await daemonAt(base);
    const cwd = companionProject(t, [makeTextRound('Apuntado.')]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const w = watch(dot, session.id);
    await w.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'apunta algo' });
    await w.until(idleAgain);

    t.provider(cwd).memory.extractor = () => new Error('memory model down');
    expect(await failure(dot.request('sessions.open', { agent: 'companion', fresh: true }))).toBe(
      'UNAVAILABLE',
    );
    const still = await dot.request('sessions.open', { agent: 'companion' });
    expect(still.session.id).toBe(session.id);
    expect(existsSync(join(sessionsDir(base), 'archived'))).toBe(false);
    const listed = (await dot.request('sessions.list', {})).sessions;
    expect(listed.filter((s) => s.agent === 'companion')).toHaveLength(1);
  });

  it('con un run en curso, BUSY; sin companion o con cwd, INVALID_PARAMS; sin conversación, abre una', async () => {
    const t = await daemonAt(newBase());
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    companionProject(t, [{ wait, then: makeTextRound('Hecho.') }]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });

    expect(await failure(dot.request('sessions.open', { fresh: true }))).toBe('INVALID_PARAMS');
    expect(
      await failure(dot.request('sessions.open', { agent: 'companion', fresh: true, cwd: t.base })),
    ).toBe('INVALID_PARAMS');

    // Sin conversación todavía: es como abrirla.
    const first = await dot.request('sessions.open', { agent: 'companion', fresh: true });
    expect(first.archived).toBeUndefined();

    const w = watch(dot, first.session.id);
    await w.untilSnapshot();
    await dot.request('runs.start', { sessionId: first.session.id, input: 'tarda' });
    expect(await failure(dot.request('sessions.open', { agent: 'companion', fresh: true }))).toBe(
      'BUSY',
    );
    release();
    await w.until(idleAgain);
    const still = await dot.request('sessions.open', { agent: 'companion' });
    expect(still.session.id).toBe(first.session.id);
  });
});
