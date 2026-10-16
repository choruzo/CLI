import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeTextRound, makeToolCallRound } from '../providers/mock.js';
import {
  HANDOFF_LIMITS,
  splitHandoff,
  type ProtocolEvent,
  type ProtocolSessionSnapshot,
} from '../protocol/index.js';
import { handoffContextSchema } from '../protocol/schemas.js';
import { startPeer, textRound, type TestPeer } from '../daemon/daemon.fixtures.js';
import {
  captureHandoff,
  handoffAgentOptions,
  prepareHandoff,
  SessionOwnership,
} from './handoff.js';
import { SessionHost } from './session-host.js';
import { SessionPublisher } from './session-publisher.js';
import { createSessionEnv } from '../runtime/session-env.js';

/**
 * M10 — lo que se captura de una sesión par para traspasarla, cuándo no se
 * puede, y cómo continúa su publicador en el daemon. Sin daemon: el puente de
 * estos pares no encuentra ninguno y la sesión trabaja sola.
 */

const peers: TestPeer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const p of peers.splice(0)) await p.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function lonePeer(rounds: Parameters<typeof startPeer>[2]): Promise<TestPeer> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-')));
  dirs.push(base);
  const p = await startPeer({ base, dir: join(base, 'sin-daemon') }, 'proj', rounds);
  peers.push(p);
  return p;
}

describe('splitHandoff', () => {
  it('trocea y se une igual, sin partir un par de surrogates', () => {
    const text = `${'a'.repeat(5)}😀${'b'.repeat(4)}😀`;
    for (const size of [2, 3, 6, 7, 8, 100]) {
      const parts = splitHandoff(text, size);
      expect(parts.join('')).toBe(text);
      for (const part of parts) {
        expect(part.length).toBeLessThanOrEqual(size);
        const last = part.charCodeAt(part.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff, `size ${size}: ${JSON.stringify(parts)}`).toBe(
          false,
        );
      }
    }
    expect(splitHandoff('')).toEqual([]);
    expect(() => splitHandoff('abc', 1)).toThrow();
  });

  it('un trozo del tamaño por defecto cabe en un mensaje aun con el peor escape', () => {
    const worst = '\u0001'.repeat(HANDOFF_LIMITS.chunkChars);
    const line = JSON.stringify({ data: worst });
    expect(Buffer.byteLength(line)).toBeLessThan(1024 * 1024 - 1024);
  });
});

describe('SessionOwnership', () => {
  it('un turno y un traspaso no conviven; handed-off es definitivo', () => {
    const o = new SessionOwnership();
    const seen: string[] = [];
    o.subscribe((s) => seen.push(s));
    const end = o.tryBeginTurn()!;
    expect(o.beginHandoff()).toBe(false);
    end();
    end(); // cerrar dos veces no descuenta dos
    expect(o.turnsInFlight).toBe(0);
    expect(o.beginHandoff()).toBe(true);
    expect(o.tryBeginTurn()).toBeNull();
    o.abortHandoff();
    expect(o.state).toBe('owner');
    expect(o.beginHandoff()).toBe(true);
    o.completeHandoff();
    expect(o.tryBeginTurn()).toBeNull();
    expect(o.beginHandoff()).toBe(false);
    o.abortHandoff();
    expect(o.state).toBe('handed-off');
    expect(seen).toEqual(['detaching', 'owner', 'detaching', 'handed-off']);
  });
});

describe('captureHandoff', () => {
  it('lleva el historial completo y los ajustes; vuelve igual al rehidratar', async () => {
    const p = await lonePeer([
      makeToolCallRound('c1', 'write_file', { path: 'nota.txt', content: 'hola' }),
      textRound(['Hecho.']),
    ]);
    await p.run('Escribe una nota. La clave es kiwi.');
    p.host.agent.setReadOnly(true);
    const captured = captureHandoff(p.host);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const { context } = captured;
    expect(context.sessionId).toBe(p.sessionId);
    expect(context.cwd).toBe(p.host.env.cwd);
    expect(context.provider).toBe('test');
    expect(context.model).toBe('test-model');
    expect(context.readOnly).toBe(true);
    expect(context.usage.toolCalls).toBe(1);
    // Mismo historial, con la llamada a la tool y su resultado.
    expect(context.messages).toHaveLength(p.host.agent.getMessages().length);
    expect(context.messages[0]!.role).toBe('system');
    expect(JSON.stringify(context.messages)).toContain('kiwi');
    expect(context.messages.some((m) => m.toolCalls?.[0]?.name === 'write_file')).toBe(true);
    expect(context.messages.some((m) => m.role === 'tool' && m.toolCallId === 'c1')).toBe(true);
    // Es exactamente lo que valida el daemon.
    expect(handoffContextSchema.safeParse(JSON.parse(JSON.stringify(context))).success).toBe(true);
    // Y vuelve al formato del agente sin perder nada.
    expect(handoffAgentOptions(context).initialMessages).toEqual(p.host.agent.getMessages());
    // Nada del entorno ni de la config.
    const text = JSON.stringify(context);
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('baseUrl');
    expect(text).not.toContain('127.0.0.1');
  });

  it('el agente rehidratado tiene el mismo contexto y los mismos ajustes', async () => {
    const p = await lonePeer([textRound(['vale'])]);
    await p.run('Mi código secreto de prueba es kiwi');
    const captured = captureHandoff(p.host);
    if (!captured.ok) throw new Error('not captured');
    const other = await SessionHost.create({
      env: createSessionEnv({ cwd: p.host.env.cwd, env: {} }),
      config: p.host.config,
      router: p.host.router,
      sessionId: p.sessionId,
      mcp: 'none',
      agent: handoffAgentOptions(captured.context),
    });
    try {
      expect(other.agent.getMessages()).toEqual(p.host.agent.getMessages());
      expect(other.agent.toolCallCount).toBe(p.host.agent.toolCallCount);
      expect(other.agent.isReadOnly()).toBe(p.host.agent.isReadOnly());
      expect(other.agent.getSessionProfileRequest()).toBe(p.host.agent.getSessionProfileRequest());
    } finally {
      await other.dispose();
    }
  });

  it('prepareHandoff cierra la puerta de turnos; si no se puede, la vuelve a abrir', async () => {
    const p = await lonePeer([makeTextRound('uno')]);
    const o = new SessionOwnership();
    const end = o.tryBeginTurn()!;
    expect(prepareHandoff(p.host, o)).toMatchObject({ ok: false, reason: 'run-active' });
    end();
    const prep = prepareHandoff(p.host, o);
    expect(prep.ok).toBe(true);
    expect(o.state).toBe('detaching');
    expect(prepareHandoff(p.host, o)).toMatchObject({ ok: false, reason: 'handoff-in-progress' });
    if (prep.ok) prep.settle('kept');
    expect(o.state).toBe('owner');
    // Bloqueado por el runtime (un mensaje del usuario sin entregar): la puerta no se queda cerrada.
    p.host.agent.inbox.beginTurn();
    p.host.agent.enqueueUserMessage('pendiente');
    p.host.agent.inbox.endTurn();
    expect(prepareHandoff(p.host, o)).toMatchObject({ ok: false, reason: 'inbox-pending' });
    expect(o.state).toBe('owner');
  });
});

describe('SessionPublisher — continuar una sesión traspasada', () => {
  it('sigue la numeración, no reabre la sesión y su foto es la misma salvo el anfitrión', async () => {
    const p = await lonePeer([
      makeToolCallRound('c1', 'write_file', { path: 'a.txt', content: 'x' }),
      textRound(['uno']),
      textRound(['dos']),
    ]);
    await p.run('primero');
    await p.run('segundo');
    const before = p.bridge.publisher.snapshot();
    expect(before.messages.length).toBeGreaterThan(2);

    const events: ProtocolEvent[] = [];
    const next = new SessionPublisher({
      host: p.host,
      hostInfo: { kind: 'daemon', client: 'daemon', connected: true },
      sink: { onEvents: (e) => events.push(...e), onOverflow: () => undefined },
      continueFrom: before,
    });
    expect(next.seq).toBe(before.seq);
    next.start();
    next.flush();
    expect(events.map((e) => e.type)).toEqual(['session.updated']);
    expect((events[0] as { seq: number }).seq).toBe(before.seq + 1);
    const after = next.snapshot();
    const strip = (s: ProtocolSessionSnapshot) => ({
      ...s,
      seq: 0,
      session: { ...s.session, host: null, seq: 0, updatedAt: 0, context: null },
    });
    expect(strip(after)).toEqual(strip(before));
    expect(after.session.host.kind).toBe('daemon');
    expect(
      () =>
        new SessionPublisher({
          host: p.host,
          hostInfo: { kind: 'daemon', client: 'daemon', connected: true },
          sink: { onEvents: () => undefined, onOverflow: () => undefined },
          continueFrom: { ...before, session: { ...before.session, id: 'sess_otra' } },
        }),
    ).toThrow();
  });

  it('release(): deja de publicar sin cerrar la sesión', async () => {
    const p = await lonePeer([textRound(['uno']), textRound(['dos'])]);
    await p.run('uno');
    const events: ProtocolEvent[] = [];
    const pub = new SessionPublisher({
      host: p.host,
      hostInfo: { kind: 'peer', client: 'cli', connected: true },
      sink: { onEvents: (e) => events.push(...e), onOverflow: () => undefined },
    });
    pub.start();
    pub.flush();
    const seq = pub.seq;
    pub.release();
    for await (const ev of p.host.run('dos')) void ev;
    pub.sessionChanged();
    pub.close('closed');
    pub.flush();
    expect(pub.seq).toBe(seq);
    expect(events.some((e) => e.type === 'session.closed')).toBe(false);
  });
});

describe('handoffContextSchema', () => {
  it('un nombre de tool vacío (inventado por el modelo) no impide traspasar', () => {
    const context = {
      format: 1,
      sessionId: 'sess_x',
      cwd: '/tmp/x',
      provider: 'p',
      model: 'm',
      agent: null,
      readOnly: false,
      sessionProfile: 'auto',
      planRef: null,
      usage: { toolCalls: 0, tokens: null, tokenStatus: 'unavailable' },
      messages: [
        { role: 'system', content: 's' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: '', arguments: '{}' }] },
        { role: 'tool', content: 'error', toolCallId: 'c1', name: '' },
      ],
    };
    expect(handoffContextSchema.safeParse(context).success).toBe(true);
    expect(handoffContextSchema.safeParse({ ...context, env: { A: '1' } }).success).toBe(false);
  });
});
