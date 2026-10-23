/**
 * `sessions.revert` contra un daemon real: el turno del agente toca ficheros y
 * el revert —con el mismo plan que `/undo`— los deshace: dryRun, conflictos,
 * permisos, sesiones par y el aviso `<files_reverted>` del turno siguiente.
 * Daemon real sobre un pipe, cliente real; solo el modelo es de guion.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { StratumClient } from '../client/client.js';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import type { ProtocolEvent, ProtocolRevertPlan } from '../protocol/index.js';
import {
  startPeer,
  startTestDaemon,
  watch,
  type TestDaemon,
  type Watcher,
} from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const peers: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
  for (const d of daemons.splice(0)) await d.stop().catch(() => undefined);
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Un proyecto que es repo git, con `a.txt` ya commiteado para poder restaurarlo. */
async function gitProject(t: TestDaemon, name: string, rounds: Parameters<typeof t.project>[1]) {
  const cwd = t.project(name, rounds);
  await execa('git', ['init', '-q'], { cwd, reject: false });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd, reject: false });
  await execa('git', ['config', 'user.name', 'test'], { cwd, reject: false });
  writeFileSync(join(cwd, 'a.txt'), 'original');
  await execa('git', ['add', '-A'], { cwd });
  await execa(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '-m', 'base'],
    { cwd, reject: false },
  );
  return cwd;
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

const failure = async (p: Promise<unknown>): Promise<ProtocolError | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ProtocolError ? e : null;
  }
};

/** El plan de un resultado de revert. */
const planOf = (r: { status: string; plan: ProtocolRevertPlan | null }): ProtocolRevertPlan =>
  r.plan ?? { turns: [], restore: [], remove: [], conflicts: [], skipped: [], truncated: false };

/** Abre la sesión y hace el turno que crea `nuevo.txt` y pisa `a.txt`. */
async function openAndTurn(client: StratumClient, cwd: string) {
  const { session } = await client.request('sessions.open', { cwd });
  const live = watch(client, session.id);
  await live.untilSnapshot();
  await ask(client, live, session.id, 'toca los ficheros');
  return session;
}

describe('sessions.revert contra el daemon', () => {
  it('dryRun planifica sin tocar disco; el revert borra lo creado y restaura lo pisado', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const rounds = [
      makeToolCallRound('c1', 'write_file', { path: 'nuevo.txt', content: 'creado' }),
      makeToolCallRound('c2', 'write_file', { path: 'a.txt', content: 'modificado' }),
      makeTextRound('Hecho.'),
    ];
    const cwd = await gitProject(t, 'deshace', rounds);
    const client = await t.connect(['operator', 'approver'], 'ambos');
    const session = await openAndTurn(client, cwd);
    expect(readFileSync(join(cwd, 'nuevo.txt'), 'utf8')).toBe('creado');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('modificado');

    const dry = await client.request('sessions.revert', { sessionId: session.id, dryRun: true });
    expect(dry.status).toBe('planned');
    expect(planOf(dry).remove).toContain('nuevo.txt');
    expect(planOf(dry).restore).toContain('a.txt');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('modificado');
    expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(true);

    const done = await client.request('sessions.revert', { sessionId: session.id });
    expect(done.status).toBe('reverted');
    expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(false);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('original');
  }, 60_000);

  it('un operator sin approve recibe FORBIDDEN y no toca nada', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const rounds = [
      makeToolCallRound('c1', 'write_file', { path: 'nuevo.txt', content: 'x' }),
      makeTextRound('Hecho.'),
    ];
    const cwd = await gitProject(t, 'permisos', rounds);
    const operator = await t.connect(['operator'], 'sin-approve');
    const session = await openAndTurn(operator, cwd);

    const err = await failure(operator.request('sessions.revert', { sessionId: session.id }));
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err!.code).toBe('FORBIDDEN');
    expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(true);
  }, 30_000);

  it('conflicto: sin force no toca nada; con force deshace', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const rounds = [
      makeToolCallRound('c1', 'write_file', { path: 'nuevo.txt', content: 'creado' }),
      makeToolCallRound('c2', 'write_file', { path: 'a.txt', content: 'modificado' }),
      makeTextRound('Hecho.'),
    ];
    const cwd = await gitProject(t, 'conflicto', rounds);
    const client = await t.connect(['operator', 'approver'], 'ambos');
    const session = await openAndTurn(client, cwd);
    writeFileSync(join(cwd, 'a.txt'), 'cambiado a mano');

    const conflicted = await client.request('sessions.revert', { sessionId: session.id });
    expect(conflicted.status).toBe('conflicts');
    expect(planOf(conflicted).conflicts).toContain('a.txt');
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('cambiado a mano');
    expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(true);

    const forced = await client.request('sessions.revert', { sessionId: session.id, force: true });
    expect(forced.status).toBe('reverted');
    expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(false);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('original');
  }, 60_000);

  it('una sesión en solo lectura no revierte: INVALID_PARAMS y nada cambia', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const rounds = [
      makeToolCallRound('c1', 'write_file', { path: 'nuevo.txt', content: 'x' }),
      makeTextRound('Hecho.'),
    ];
    const cwd = await gitProject(t, 'solo-lectura', rounds);
    const client = await t.connect(['operator', 'approver'], 'ambos');
    const session = await openAndTurn(client, cwd);
    await client.request('sessions.setReadOnly', { sessionId: session.id, readOnly: true });

    const err = await failure(client.request('sessions.revert', { sessionId: session.id }));
    expect(err?.code).toBe('INVALID_PARAMS');
    expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(true);
  }, 30_000);

  it('cerrar la sesión espera al revert en curso: no queda a medias', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const rounds = [
      makeToolCallRound('c1', 'write_file', { path: 'nuevo.txt', content: 'creado' }),
      makeToolCallRound('c2', 'write_file', { path: 'a.txt', content: 'modificado' }),
      makeTextRound('Hecho.'),
    ];
    const cwd = await gitProject(t, 'cierre', rounds);
    const client = await t.connect(['operator', 'approver'], 'ambos');
    const session = await openAndTurn(client, cwd);

    // Las dos peticiones salen a la vez. Gane quien gane, nunca queda a medias:
    // o el cierre espera al revert entero, o el revert llega tarde y no toca nada.
    const revert = failure(client.request('sessions.revert', { sessionId: session.id }));
    await client.request('sessions.close', { sessionId: session.id });
    const err = await revert;
    if (err === null) {
      expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(false);
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('original');
    } else {
      expect(err.code).toMatch(/^(UNAVAILABLE|NOT_FOUND)$/);
      expect(existsSync(join(cwd, 'nuevo.txt'))).toBe(true);
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('modificado');
    }
  }, 60_000);

  it('sin turnos con cambios: nothing y plan null', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = await gitProject(t, 'recien', [makeTextRound('Hola.')]);
    const client = await t.connect(['operator', 'approver'], 'ambos');
    const { session } = await client.request('sessions.open', { cwd });
    const result = await client.request('sessions.revert', { sessionId: session.id });
    expect(result).toEqual({ status: 'nothing', plan: null });
  }, 30_000);

  it('id inexistente: NOT_FOUND; sesión par: UNAVAILABLE peer-hosted', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const client = await t.connect(['operator', 'approver'], 'ambos');

    const missing = await failure(
      client.request('sessions.revert', { sessionId: 'sess_20260101_000000_abc' }),
    );
    expect(missing).toBeInstanceOf(ProtocolError);
    expect(missing!.code).toBe('NOT_FOUND');

    const peer = await startPeer(t, 'par', [makeTextRound('Hola desde el par.')]);
    peers.push(peer);
    let err: ProtocolError | null = null;
    const t0 = Date.now();
    for (;;) {
      err = await failure(client.request('sessions.revert', { sessionId: peer.sessionId }));
      if (
        err?.code === 'UNAVAILABLE' &&
        (err.data as { reason?: string }).reason === 'peer-hosted'
      ) {
        break;
      }
      if (Date.now() - t0 >= 10_000) break;
      await delay(25);
    }
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err!.code).toBe('UNAVAILABLE');
    expect(err!.data).toMatchObject({ reason: 'peer-hosted' });

    await peer.stop();
    peers.splice(peers.indexOf(peer), 1);
  }, 30_000);

  it('tras revertir, el turno siguiente abre con el aviso files_reverted en el prompt', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const rounds = [
      makeToolCallRound('c1', 'write_file', { path: 'nuevo.txt', content: 'creado' }),
      makeTextRound('Hecho.'),
      makeTextRound('Sigo.'),
    ];
    const cwd = await gitProject(t, 'aviso', rounds);
    const client = await t.connect(['operator', 'approver'], 'ambos');
    const session = await openAndTurn(client, cwd);

    const done = await client.request('sessions.revert', { sessionId: session.id });
    expect(done.status).toBe('reverted');

    const live = watch(client, session.id);
    await live.untilSnapshot();
    await ask(client, live, session.id, '¿en qué quedó?');
    const inputs = t.provider(cwd).userInputs.at(-1)!;
    expect(inputs.some((u) => u.includes('files_reverted'))).toBe(true);
  }, 60_000);
});
