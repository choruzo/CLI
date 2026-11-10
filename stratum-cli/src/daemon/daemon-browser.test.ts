/**
 * El navegador del agente por el protocolo: `browser.screen` (mirar, nunca lo
 * arranca) y `browser.navigate` (la persona lo mueve, en reposo, sin aprobar
 * orígenes). Daemon real sobre un pipe, cliente real; ningún navegador de
 * verdad: el «ejecutable» es Node, que no arranca como navegador.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { makeTextRound } from '../providers/mock.js';
import { METHODS } from '../protocol/index.js';
import { PARAMS, RESULTS } from '../protocol/schemas.js';
import { gate, startPeer, startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

const daemons: TestDaemon[] = [];
const peers: Array<{ stop(): Promise<void> }> = [];

beforeEach(() => {
  // `vitest.config.ts` apaga el navegador; aquí se quiere uno «configurado».
  vi.stubEnv('STRATUM_NO_BROWSER', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
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

const withBrowser = { tools: { browser: { executable: process.execPath } } };

describe('browser.* contra el daemon', () => {
  it('el contrato: observe para mirar, control para mover; goto exige url', () => {
    expect(METHODS['browser.screen']).toMatchObject({ capability: 'observe', mutating: false });
    expect(METHODS['browser.navigate']).toMatchObject({ capability: 'control', mutating: true });
    expect(PARAMS['browser.navigate'].safeParse({ sessionId: 's', action: 'goto' }).success).toBe(
      false,
    );
    expect(PARAMS['browser.navigate'].safeParse({ sessionId: 's', action: 'back' }).success).toBe(
      true,
    );
    expect(
      PARAMS['browser.navigate'].safeParse({ sessionId: 's', action: 'open', url: 'x' }).success,
    ).toBe(false);
    expect(
      PARAMS['browser.navigate'].safeParse({
        sessionId: 's',
        action: 'goto',
        url: 'x'.repeat(2049),
      }).success,
    ).toBe(false);
    expect(
      RESULTS['browser.screen'].safeParse({ browser: { state: 'closed' }, screen: null }).success,
    ).toBe(true);
  });

  it('mirar nunca arranca el navegador; lo externo y lo vetado no se abren con control', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = t.project('web', [makeTextRound('Hola.')], withBrowser);
    const operator = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    const { session } = await operator.request('sessions.open', { cwd });
    const observer = await t.connect(['observer'], 'mirón');

    expect(await observer.request('browser.screen', { sessionId: session.id })).toEqual({
      browser: { state: 'closed' },
      screen: null,
    });
    // Un observador no lo mueve.
    expect(
      (
        await failure(
          observer.request('browser.navigate', { sessionId: session.id, action: 'reload' }),
        )
      )?.code,
    ).toBe('FORBIDDEN');

    const external = await failure(
      operator.request('browser.navigate', {
        sessionId: session.id,
        action: 'goto',
        url: 'https://example.com/',
      }),
    );
    expect(external?.code).toBe('INVALID_PARAMS');
    expect(external?.data).toMatchObject({ reason: 'needs-approval' });
    const blocked = await failure(
      operator.request('browser.navigate', {
        sessionId: session.id,
        action: 'goto',
        url: 'http://169.254.169.254/',
      }),
    );
    expect(blocked?.code).toBe('INVALID_PARAMS');
    expect(blocked?.data).toMatchObject({ reason: 'blocked-url' });
    // Atrás sin navegador abierto.
    const back = await failure(
      operator.request('browser.navigate', { sessionId: session.id, action: 'back' }),
    );
    expect(back?.data).toMatchObject({ reason: 'browser-closed' });
    // Nada de eso lo arrancó.
    expect(
      (await observer.request('browser.screen', { sessionId: session.id })).browser.state,
    ).toBe('closed');
  }, 60_000);

  it('un navegador que no arranca es un fallo auxiliar: UNAVAILABLE y la sesión sigue', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const cwd = t.project('roto', [makeTextRound('Sigo aquí.')], withBrowser);
    const operator = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    const { session } = await operator.request('sessions.open', { cwd });
    const err = await failure(
      operator.request('browser.navigate', {
        sessionId: session.id,
        action: 'goto',
        url: 'http://localhost:9/',
      }),
    );
    expect(err?.code).toBe('UNAVAILABLE');
    expect(err?.data).toMatchObject({ reason: 'failed' });
    expect((await operator.request('browser.screen', { sessionId: session.id })).browser).toEqual({
      state: 'unavailable',
      reason: 'failed',
    });
    const { run } = await operator.request('runs.start', { sessionId: session.id, input: 'hola' });
    expect(run.status).toBeDefined();
  }, 60_000);

  it('con un run en marcha el navegador es del agente: BUSY', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const hold = gate();
    const cwd = t.project(
      'ocupado',
      [{ wait: hold.wait, then: makeTextRound('fin') }],
      withBrowser,
    );
    const operator = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    const { session } = await operator.request('sessions.open', { cwd });
    await operator.request('runs.start', { sessionId: session.id, input: 'trabaja' });
    const busy = await failure(
      operator.request('browser.navigate', {
        sessionId: session.id,
        action: 'goto',
        url: 'http://localhost:3000/',
      }),
    );
    expect(busy?.code).toBe('BUSY');
    // Mirar sí se puede.
    expect((await operator.request('browser.screen', { sessionId: session.id })).screen).toBeNull();
    hold.open();
  }, 60_000);

  it('sin navegador en la sesión: unavailable con su motivo (el companion no lo tiene)', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    const off = t.project('apagado', [makeTextRound('Hola.')], {
      tools: { browser: { enabled: false } },
    });
    const operator = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    const { session } = await operator.request('sessions.open', { cwd: off });
    expect((await operator.request('browser.screen', { sessionId: session.id })).browser).toEqual({
      state: 'unavailable',
      reason: 'disabled',
    });
    const err = await failure(
      operator.request('browser.navigate', {
        sessionId: session.id,
        action: 'goto',
        url: 'http://localhost/',
      }),
    );
    expect(err?.code).toBe('UNAVAILABLE');
    expect(err?.data).toMatchObject({ reason: 'disabled' });

    t.project(join('companion', 'workspace'), [], withBrowser);
    const dot = await t.connect(['operator'], 'stratum-dot', { kind: 'dot' });
    const { session: companion } = await dot.request('sessions.open', { agent: 'companion' });
    expect((await dot.request('browser.screen', { sessionId: companion.id })).browser).toEqual({
      state: 'unavailable',
      reason: 'not-supported',
    });
    expect((await failure(dot.request('browser.screen', { sessionId: 'ses_nada' })))?.code).toBe(
      'NOT_FOUND',
    );
  }, 60_000);

  it('una sesión par: el navegador vive en su proceso, UNAVAILABLE peer-hosted', async () => {
    const t = await startTestDaemon();
    daemons.push(t);
    mkdirSync(join(t.base, 'par'), { recursive: true });
    const peer = await startPeer(t, 'par', [makeTextRound('Hola desde el par.')]);
    peers.push(peer);
    const client = await t.connect(['operator'], 'desktop', { kind: 'desktop' });
    let err: ProtocolError | null = null;
    const t0 = Date.now();
    for (;;) {
      err = await failure(client.request('browser.screen', { sessionId: peer.sessionId }));
      if (err?.code !== 'NOT_FOUND' || Date.now() - t0 >= 10_000) break;
      await delay(25);
    }
    expect(err?.code).toBe('UNAVAILABLE');
    expect(err?.data).toMatchObject({ reason: 'peer-hosted' });
    const nav = await failure(
      client.request('browser.navigate', {
        sessionId: peer.sessionId,
        action: 'goto',
        url: 'http://localhost/',
      }),
    );
    expect(nav?.data).toMatchObject({ reason: 'peer-hosted' });
  }, 60_000);
});
