/**
 * Modo código de Desktop — `git.changes` y `git.diff` contra un daemon real:
 * solo leen el disco del proyecto de una sesión (montada, par), con `observe`;
 * rutas confinadas, embebidos fuera. Daemon real sobre un pipe, cliente real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import { startPeer, startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const peers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const failure = async (p: Promise<unknown>): Promise<ProtocolError | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ProtocolError ? e : null;
  }
};

/** `cwd` como repo git con `a.txt` commiteado, `a.txt` modificado y `nuevo.txt` sin seguir. */
async function dirtyRepo(cwd: string): Promise<void> {
  const git = (args: string[]) => execa('git', args, { cwd });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(cwd, 'a.txt'), 'uno\n');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'base']);
  writeFileSync(join(cwd, 'a.txt'), 'uno\ndos\n');
  writeFileSync(join(cwd, 'nuevo.txt'), 'x\ny\nz\n');
}

describe('git.changes / git.diff contra el daemon', () => {
  it('lee los cambios y el diff de una sesión de código, solo con observe', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = t.project('codigo', [makeTextRound('Hola.')]);
    await dirtyRepo(cwd);
    const operator = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    const { session } = await operator.request('sessions.open', { cwd });
    const observer = await t.connect(['observer'], 'mirón');

    const { changes } = await observer.request('git.changes', { sessionId: session.id });
    expect(changes).toMatchObject({
      isRepo: true,
      files: 2,
      added: 4,
      deleted: 0,
      truncated: false,
    });
    expect(changes.changes.map((c) => [c.path, c.status])).toEqual([
      ['a.txt', 'modified'],
      ['nuevo.txt', 'untracked'],
    ]);

    const tracked = await observer.request('git.diff', { sessionId: session.id, path: 'a.txt' });
    expect(tracked).toMatchObject({ truncated: false, binary: false });
    expect(tracked.diff).toContain('+dos');
    const added = await observer.request('git.diff', { sessionId: session.id, path: 'nuevo.txt' });
    expect(added.diff).toContain('@@ -0,0 +1,3 @@');

    // Ruta fuera, con `..` o absoluta: INVALID_PARAMS, sin leer nada.
    for (const path of ['../fuera.txt', 'x/../../y', join(t.base, 'otro.txt')]) {
      const err = await failure(observer.request('git.diff', { sessionId: session.id, path }));
      expect(err?.code, path).toBe('INVALID_PARAMS');
    }
    // Sesión que no existe.
    for (const ask of [
      observer.request('git.changes', { sessionId: 'ses_nada' }),
      observer.request('git.diff', { sessionId: 'ses_nada', path: 'a.txt' }),
    ]) {
      expect((await failure(ask))?.code).toBe('NOT_FOUND');
    }
  }, 60_000);

  it('fuera de un repo: isRepo false y el diff, UNAVAILABLE not-a-repo', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = t.project('sin-repo', [makeTextRound('Hola.')]);
    const client = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    const { session } = await client.request('sessions.open', { cwd });
    const { changes } = await client.request('git.changes', { sessionId: session.id });
    expect(changes).toMatchObject({ isRepo: false, files: 0, changes: [], truncated: false });
    const err = await failure(client.request('git.diff', { sessionId: session.id, path: 'a.txt' }));
    expect(err?.code).toBe('UNAVAILABLE');
    expect(err?.data).toMatchObject({ reason: 'not-a-repo' });
  }, 60_000);

  it('una sesión del asistente no es de un proyecto: UNAVAILABLE embedded-agent', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = t.project('chat', [makeTextRound('Hola.')]);
    await dirtyRepo(cwd);
    const desktop = await t.connect(['operator'], 'stratum-desktop', { kind: 'desktop' });
    const { session } = await desktop.request('sessions.open', { cwd, agent: 'assistant' });
    for (const ask of [
      desktop.request('git.changes', { sessionId: session.id }),
      desktop.request('git.diff', { sessionId: session.id, path: 'a.txt' }),
    ]) {
      const err = await failure(ask);
      expect(err?.code).toBe('UNAVAILABLE');
      expect(err?.data).toMatchObject({ reason: 'embedded-agent' });
    }
  }, 60_000);

  it('una sesión par: el daemon lee el disco de su cwd', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = join(t.base, 'par');
    mkdirSync(cwd, { recursive: true });
    await dirtyRepo(cwd);
    const peer = await startPeer(t, 'par', [makeTextRound('Hola desde el par.')]);
    peers.push(peer);
    const client = await t.connect(['observer'], 'mirón');
    // El par se registra en el daemon al arrancar: se espera a que lo conozca.
    let err: ProtocolError | null = null;
    const t0 = Date.now();
    for (;;) {
      err = await failure(client.request('git.changes', { sessionId: peer.sessionId }));
      if (err?.code !== 'NOT_FOUND' || Date.now() - t0 >= 10_000) break;
      await delay(25);
    }
    expect(err).toBeNull();
    const { changes } = await client.request('git.changes', { sessionId: peer.sessionId });
    expect(changes.changes.map((c) => c.path)).toEqual(['a.txt', 'nuevo.txt']);
    const { diff } = await client.request('git.diff', { sessionId: peer.sessionId, path: 'a.txt' });
    expect(diff).toContain('+dos');
  }, 60_000);
});
