/**
 * Paridad del modo código de Desktop con `chat`, contra un daemon real:
 *  - `sessions.ask` (`/btw`): contesta sin tools y no entra en la conversación;
 *  - `jobs.background` (Ctrl+B): el `exec` en primer plano pasa a job;
 *  - `sessions.turns` (`/rewind`): los turnos que se pueden deshacer;
 *  - `memory.*` con `sessionId` y `memory.documents`: la memoria del proyecto
 *    de la sesión, sin que el cliente nombre un directorio.
 * Daemon real sobre un pipe, cliente real; solo el modelo es de guion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { loadConfig } from '../config/loader.js';
import { _resetDecisionMemoryCache, getDecisionMemory } from '../memory/decision-memory.js';
import { DecisionStore } from '../memory/decisions.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { startTestDaemon, watch, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const bases: string[] = [];
const memoryProjects: string[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  // El índice abierto impediría borrar la carpeta en Windows.
  for (const cwd of memoryProjects.splice(0)) {
    await getDecisionMemory(loadConfig(cwd))
      .vectors.close()
      .catch(() => undefined);
  }
  _resetDecisionMemoryCache();
  for (const b of bases.splice(0)) {
    rmSync(b, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

async function daemon(): Promise<TestDaemon> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-code-mode-')));
  bases.push(base);
  const t = await startTestDaemon({ base });
  daemons.push(t);
  return t;
}

const failure = async (p: Promise<unknown>): Promise<ProtocolError | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ProtocolError ? e : null;
  }
};

const reason = (e: ProtocolError | null): unknown => (e?.data as { reason?: string })?.reason;

describe('sessions.ask — la pregunta lateral (/btw)', () => {
  it('contesta sin tools y no entra en la conversación ni en el uso', async () => {
    const t = await daemon();
    const cwd = t.project('p', [
      makeTextRound('hola, soy el agente'),
      makeTextRound('  es una respuesta lateral  '),
      makeTextRound('segundo turno'),
    ]);
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();
    const first = await operator.request('runs.start', { sessionId: session.id, input: 'saluda' });
    await live.until((e) => e.type === 'run.completed' && e.data.run.id === first.run.id, 20_000);

    // Preguntar gasta modelo: no basta con mirar.
    expect(
      (
        await failure(
          observer.request('sessions.ask', { sessionId: session.id, question: '¿qué dijiste?' }),
        )
      )?.code,
    ).toBe('FORBIDDEN');
    const before = (await operator.request('sessions.get', { sessionId: session.id })).snapshot;
    const asked = await operator.request('sessions.ask', {
      sessionId: session.id,
      question: '¿qué dijiste?',
    });
    expect(asked).toEqual({ answer: 'es una respuesta lateral', truncated: false });

    const provider = t.provider(cwd);
    // La llamada lateral llevó la conversación y la pregunta, y ninguna tool.
    expect(provider.toolNames[1]).toEqual([]);
    expect(provider.userInputs[1]!.join('\n')).toContain('¿qué dijiste?');
    expect(provider.userInputs[1]).toContain('saluda');

    // Nada de ello quedó en la sesión: ni mensajes, ni historial, ni un run.
    const after = (await operator.request('sessions.get', { sessionId: session.id })).snapshot;
    expect(after.messages).toEqual(before.messages);
    expect(after.session.currentRunId).toBeNull();
    const history = await operator.request('sessions.history', { sessionId: session.id });
    expect(JSON.stringify(history.messages)).not.toContain('respuesta lateral');
    expect(JSON.stringify(history.messages)).not.toContain('¿qué dijiste?');

    // El turno siguiente no ve la pregunta lateral.
    const second = await operator.request('runs.start', { sessionId: session.id, input: 'sigue' });
    await live.until((e) => e.type === 'run.completed' && e.data.run.id === second.run.id, 20_000);
    expect(provider.userInputs[2]!.join('\n')).not.toContain('¿qué dijiste?');

    expect(
      (await failure(operator.request('sessions.ask', { sessionId: session.id, question: '  ' })))
        ?.code,
    ).toBe('INVALID_PARAMS');
    expect(
      (await failure(operator.request('sessions.ask', { sessionId: 'no-existe', question: 'x' })))
        ?.code,
    ).toBe('NOT_FOUND');
  });

  it('vale con un turno en curso, y solo una a la vez', async () => {
    const t = await daemon();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const cwd = t.project('p', [
      { wait: new Promise(() => undefined), then: [] },
      { wait: hold, then: makeTextRound('lateral') },
    ]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd });
    await operator.request('runs.start', { sessionId: session.id, input: 'no acaba' });
    const provider = t.provider(cwd);
    while (provider.calls < 1) await new Promise((r) => setTimeout(r, 10));

    const pending = operator.request('sessions.ask', { sessionId: session.id, question: 'uno' });
    while (provider.calls < 2) await new Promise((r) => setTimeout(r, 10));
    expect(
      (await failure(operator.request('sessions.ask', { sessionId: session.id, question: 'dos' })))
        ?.code,
    ).toBe('BUSY');
    release();
    expect((await pending).answer).toBe('lateral');
  });
});

describe('jobs.background — pasar a segundo plano el comando en curso (Ctrl+B)', () => {
  it('el exec en primer plano pasa a job y el agente sigue', async () => {
    const t = await daemon();
    const cwd = t.project('p', [
      makeToolCallRound('c1', 'exec', { command: 'node -e "setInterval(() => {}, 1000)"' }),
      makeTextRound('sigo con otra cosa'),
    ]);
    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();

    // Sin nada corriendo no mueve nada.
    expect(await operator.request('jobs.background', { sessionId: session.id })).toEqual({
      moved: 0,
      errors: [],
    });
    const { run } = await operator.request('runs.start', { sessionId: session.id, input: 'lanza' });
    await live.until((e) => e.type === 'tool.started', 20_000);

    expect(
      (await failure(observer.request('jobs.background', { sessionId: session.id })))?.code,
    ).toBe('FORBIDDEN');
    // El proceso tarda un instante en anunciarse como «en primer plano».
    let moved = 0;
    for (let i = 0; i < 100 && moved === 0; i++) {
      moved = (await operator.request('jobs.background', { sessionId: session.id })).moved;
      if (moved === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(moved).toBe(1);
    await live.until((e) => e.type === 'run.completed' && e.data.run.id === run.id, 20_000);

    const { jobs } = await operator.request('jobs.list', { sessionId: session.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'running' });
    await operator.request('jobs.cancel', { sessionId: session.id, jobId: jobs[0]!.id });
  }, 40_000);
});

describe('sessions.turns — los turnos que se pueden deshacer (/rewind)', () => {
  it('lista los turnos con cambios, el más reciente primero, y casa con sessions.revert', async () => {
    const t = await daemon();
    const cwd = t.project('p', [
      makeToolCallRound('c1', 'write_file', { path: 'uno.txt', content: 'uno' }),
      makeTextRound('hecho uno'),
      makeTextRound('nada que cambiar'),
      makeToolCallRound('c2', 'write_file', { path: 'dos.txt', content: 'dos' }),
      makeTextRound('hecho dos'),
    ]);
    await execa('git', ['init', '-q'], { cwd, reject: false });
    const operator = await t.connect(['operator', 'approver']);
    const observer = await t.connect(['observer']);
    const { session } = await operator.request('sessions.open', { cwd });
    const live = watch(operator, session.id);
    await live.untilSnapshot();
    expect((await observer.request('sessions.turns', { sessionId: session.id })).turns).toEqual([]);

    for (const input of ['escribe uno', 'no hagas nada', 'escribe dos']) {
      const { run } = await operator.request('runs.start', { sessionId: session.id, input });
      await live.until((e) => e.type === 'run.completed' && e.data.run.id === run.id, 20_000);
    }

    const { turns } = await observer.request('sessions.turns', { sessionId: session.id });
    // El turno sin cambios no cuenta.
    expect(turns.map((x) => x.files.map((f) => f.path))).toEqual([['dos.txt'], ['uno.txt']]);
    expect(turns[0]).toMatchObject({ totalFiles: 1, skipped: 0 });
    expect(turns[0]!.files[0]!.status).toBe('added');
    expect(turns[0]!.turn).toBeGreaterThan(turns[1]!.turn);

    // La posición en la lista (+1) es el `turns` de `sessions.revert`.
    const plan = await operator.request('sessions.revert', {
      sessionId: session.id,
      turns: 2,
      dryRun: true,
    });
    expect(plan.plan?.remove.sort()).toEqual(['dos.txt', 'uno.txt']);
    expect([...(plan.plan?.turns ?? [])].sort()).toEqual(turns.map((x) => x.turn).sort());

    expect((await failure(observer.request('sessions.turns', { sessionId: 'no' })))?.code).toBe(
      'NOT_FOUND',
    );
  }, 40_000);
});

describe('memory.* con sessionId — la memoria del proyecto de la sesión', () => {
  it('lee y olvida las decisiones del proyecto de esa sesión, y nunca las de otro', async () => {
    const t = await daemon();
    const seed = (cwd: string, title: string): string => {
      mkdirSync(join(cwd, '.stratum', 'memory'), { recursive: true });
      return new DecisionStore(join(cwd, '.stratum', 'memory', 'decisions.json')).add({
        title,
        content: `${title}: contenido con ghp_${'a'.repeat(36)}`,
        type: 'user_preference',
        tags: [],
        importance: 'medium',
      }).id;
    };
    const tienda = t.project('tienda', [makeTextRound('hola')]);
    const blog = t.project('blog', [makeTextRound('hola')]);
    // La memoria de cada proyecto, en el proyecto: sin depender de la config
    // global de quien lanza los tests (que puede apuntarla a su home).
    for (const cwd of [tienda, blog]) {
      memoryProjects.push(cwd);
      writeFileSync(
        join(cwd, '.stratumrc.json'),
        JSON.stringify({
          memory: {
            projectFile: './STRATUM.md',
            decisionsFile: './.stratum/memory/decisions.json',
            vectorDb: './.stratum/memory/vectors.db',
          },
        }),
      );
    }
    const idTienda = seed(tienda, 'Usar pnpm en la tienda');
    seed(blog, 'El blog va en Astro');
    writeFileSync(join(tienda, 'STRATUM.md'), `# Tienda\n\nToken: ghp_${'b'.repeat(36)}\n`);

    const operator = await t.connect(['operator']);
    const observer = await t.connect(['observer']);
    const a = (await operator.request('sessions.open', { cwd: tienda })).session;
    const b = (await operator.request('sessions.open', { cwd: blog })).session;

    const ofA = await observer.request('memory.decisions', { sessionId: a.id });
    expect(ofA.decisions.map((d) => d.title)).toEqual(['Usar pnpm en la tienda']);
    // Redactado, y sin secciones: la memoria de un proyecto no las tiene.
    expect(ofA.decisions[0]!.content).not.toContain('ghp_');
    expect(ofA.decisions[0]).not.toHaveProperty('summary');
    const ofB = await observer.request('memory.decisions', { sessionId: b.id });
    expect(ofB.decisions.map((d) => d.title)).toEqual(['El blog va en Astro']);
    expect((await observer.request('memory.status', { sessionId: a.id })).decisions).toBe(1);

    // `STRATUM.md` del proyecto, redactado y sin rutas.
    const docs = await observer.request('memory.documents', { sessionId: a.id });
    expect(docs.project?.content).toContain('# Tienda');
    expect(docs.project?.content).not.toContain('ghp_');
    expect(docs.project?.truncated).toBe(false);
    expect((await observer.request('memory.documents', { sessionId: b.id })).project).toBeNull();

    // Una sola memoria por petición.
    for (const extra of [{ cwd: blog }, { agent: 'assistant' as const }]) {
      expect(
        (await failure(observer.request('memory.decisions', { sessionId: a.id, ...extra })))?.code,
      ).toBe('INVALID_PARAMS');
    }
    expect(
      (await failure(observer.request('memory.decisions', { sessionId: 'no-existe' })))?.code,
    ).toBe('NOT_FOUND');

    // Olvidar es `control`, y el id de un proyecto no borra en otro.
    const forget = (client: typeof operator, sessionId: string) =>
      client.request('memory.forget', { sessionId, decisionId: idTienda });
    expect((await failure(forget(observer, a.id)))?.code).toBe('FORBIDDEN');
    expect(await forget(operator, b.id)).toEqual({ removed: false });
    expect(await forget(operator, a.id)).toEqual({ removed: true });
    expect((await observer.request('memory.decisions', { sessionId: a.id })).decisions).toEqual([]);
    expect(
      (await observer.request('memory.decisions', { sessionId: b.id })).decisions,
    ).toHaveLength(1);
  }, 40_000);

  it('la sesión de un agente embebido no es de un proyecto', async () => {
    const t = await daemon();
    const cwd = t.project('a', [makeTextRound('hola')]);
    const operator = await t.connect(['operator']);
    const { session } = await operator.request('sessions.open', { cwd, agent: 'assistant' });
    for (const call of [
      operator.request('memory.decisions', { sessionId: session.id }),
      operator.request('memory.documents', { sessionId: session.id }),
    ]) {
      const error = await failure(call);
      expect(error?.code).toBe('UNAVAILABLE');
      expect(reason(error)).toBe('embedded-agent');
    }
  });
});
