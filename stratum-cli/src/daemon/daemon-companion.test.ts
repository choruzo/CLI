/**
 * M14 — el agente embebido `companion` en el daemon (`docs/protocol.md` §22),
 * sobre un daemon real con clientes reales:
 *
 *  - `sessions.open { agent: 'companion' }` abre **una** sesión de larga vida
 *    en su propio directorio (sin `cwd` del cliente) y, si ya existe, devuelve
 *    esa: también tras un reinicio del daemon;
 *  - `exec` solo en su caja: lo de fuera se veta en `preflight`, lo de dentro
 *    corre sin pedir aprobación;
 *  - no se cambia de agente ni se traspasa.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import { containerBackend } from '../tools/exec/backends/container.js';
import { localBackend } from '../tools/exec/backends/local.js';
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
  vi.restoreAllMocks();
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
  for (const b of bases.splice(0)) rmSync(b, { recursive: true, force: true });
});

function newBase(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-m14-')));
  bases.push(base);
  return base;
}

async function daemonAt(base: string, persist = false): Promise<TestDaemon> {
  const t = await startTestDaemon({
    base,
    ...(persist ? { sessionsDir: join(base, 'daemon', 'sessions') } : {}),
  });
  daemons.push(t);
  return t;
}

/** El directorio del companion en el arnés, con el guion de su modelo y la caja habilitada. */
function companionProject(t: TestDaemon, rounds: Round[]): string {
  return t.project(join('companion', 'workspace'), rounds, { box: { enabled: true } });
}

const failure = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) => (err instanceof ProtocolError ? err.code : `threw ${String(err)}`),
  );

describe('M14 — el companion en el daemon', () => {
  it('agents.list lo ofrece tras el asistente, con exec', async () => {
    const t = await daemonAt(newBase());
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { agents } = await dot.request('agents.list', {});
    expect(agents.map((a) => a.name).slice(0, 2)).toEqual(['assistant', 'companion']);
    expect(agents[1]).toMatchObject({ mode: 'primary', origin: 'builtin' });
    expect(agents[1]!.allowedTools).toContain('exec');
    expect(agents[1]!.allowedTools).not.toContain('read_file');
  });

  it('una sola sesión, en su directorio: sin cwd del cliente, y reabrir devuelve la misma', async () => {
    const t = await daemonAt(newBase());
    const cwd = companionProject(t, []);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });

    expect(await failure(dot.request('sessions.open', { agent: 'companion', cwd: t.base }))).toBe(
      'INVALID_PARAMS',
    );

    const [a, b] = await Promise.all([
      dot.request('sessions.open', { agent: 'companion' }),
      dot.request('sessions.open', { agent: 'companion' }),
    ]);
    expect(a.session).toMatchObject({ agent: 'companion', cwd, origin: 'dot' });
    expect(b.session.id).toBe(a.session.id);
    const again = await dot.request('sessions.open', { agent: 'companion' });
    expect(again.session.id).toBe(a.session.id);
    const listed = (await dot.request('sessions.list', {})).sessions;
    expect(listed.filter((s) => s.agent === 'companion')).toHaveLength(1);

    // Elegido al abrir: no se cambia.
    expect(
      await failure(dot.request('sessions.setAgent', { sessionId: a.session.id, agent: null })),
    ).toBe('INVALID_PARAMS');

    // Una conversación nueva es explícita: se cierra la actual.
    await dot.request('sessions.close', { sessionId: a.session.id });
    const fresh = await dot.request('sessions.open', { agent: 'companion' });
    expect(fresh.session.id).not.toBe(a.session.id);
  });

  it('exec: fuera de la caja se veta en preflight; dentro corre sin pedir aprobación', async () => {
    const box = vi.spyOn(containerBackend, 'run').mockResolvedValue({
      status: 'exited',
      exitCode: 0,
      stdout: 'jq-1.7\n',
      stderr: '',
    });
    const local = vi.spyOn(localBackend, 'run');
    const t = await daemonAt(newBase());
    const cwd = companionProject(t, [
      makeToolCallRound('c1', 'exec', { target: 'local', command: 'whoami' }),
      makeToolCallRound('c2', 'exec', {
        target: 'container:box',
        command: 'sudo apt-get install -y jq',
      }),
      makeTextRound('Instalado en mi caja.'),
    ]);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'instala jq' });
    await live.until(idleAgain);

    const vetoes = live.states().filter((e) => e.type === 'tool.blocked');
    expect(vetoes.map((e) => (e.data as { source: string }).source)).toEqual(['preflight']);
    // Nada pidió aprobación: lo de dentro de la caja no pregunta.
    expect(live.states().some((e) => e.type === 'approval.requested')).toBe(false);
    expect(local).not.toHaveBeenCalled();
    expect(box).toHaveBeenCalledTimes(1);

    const offered = t.provider(cwd).toolNames.at(0) ?? [];
    expect(offered).toContain('exec');
    expect(offered).not.toContain('read_file');
    expect(offered).not.toContain('delegate_task');
    expect(t.provider(cwd).systemPrompts.at(0)).toContain('container:box');
  });

  it('skills.list { agent: companion } no pide cwd y da solo las suyas de serie', async () => {
    const t = await daemonAt(newBase());
    const dot = await t.connect(['observer'], 'stratum-dot', { kind: 'dot' });
    const { skills } = await dot.request('skills.list', { agent: 'companion' });
    expect(skills.every((s) => s.scope === 'builtin' && s.presets.includes('companion'))).toBe(
      true,
    );
  });

  it('tras un reinicio del daemon, abrirlo devuelve la misma sesión con su conversación', async () => {
    const base = newBase();
    const first = await daemonAt(base, true);
    companionProject(first, [makeTextRound('Apuntado.')]);
    const dot = await first.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session } = await dot.request('sessions.open', { agent: 'companion' });
    const live = watch(dot, session.id);
    await live.untilSnapshot();
    await dot.request('runs.start', { sessionId: session.id, input: 'recuerda kiwi' });
    await live.until(idleAgain);
    await first.stop();
    daemons.splice(daemons.indexOf(first), 1);

    const second = await daemonAt(base, true);
    const cwd = companionProject(second, [makeTextRound('Dijiste kiwi.')]);
    const again = await second.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const reopened = await again.request('sessions.open', { agent: 'companion' });
    expect(reopened.session.id).toBe(session.id);
    const w = watch(again, session.id);
    await w.untilSnapshot();
    await again.request('runs.start', { sessionId: session.id, input: '¿qué te dije?' });
    await w.until(idleAgain);
    expect(second.provider(cwd).userInputs.at(-1)).toEqual(
      expect.arrayContaining(['recuerda kiwi', '¿qué te dije?']),
    );
  });
});
