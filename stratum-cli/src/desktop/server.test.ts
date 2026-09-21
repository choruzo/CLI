import { describe, it, expect, afterEach } from 'vitest';
import { connect, type Socket } from 'net';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  startDesktopServer,
  tokensMatch,
  type ConversationSink,
  type DesktopServer,
} from './server.js';
import {
  DESKTOP_PROTOCOL_VERSION,
  type ConversationFrame,
  type CoreInfo,
  type SidecarErrorFrame,
} from './protocol.js';

const TOKEN = randomBytes(32).toString('hex');

const CORE: CoreInfo = {
  version: '0.0.0-test',
  protocolVersion: DESKTOP_PROTOCOL_VERSION,
  configSchemaVersion: 1,
  sessionSchemaVersion: 1,
  platform: process.platform,
  node: process.versions.node,
  sea: false,
};

function ipcPath(): string {
  const name = `stratum-test-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

/** Cliente de pruebas: acumula las tramas recibidas y sabe esperar a la N-ésima o al cierre. */
class Client {
  readonly frames: Array<Record<string, unknown>> = [];
  closed = false;
  private buffer = '';
  private waiters: Array<() => void> = [];

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        this.frames.push(JSON.parse(this.buffer.slice(0, nl)) as Record<string, unknown>);
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.notify();
    });
    socket.on('close', () => {
      this.closed = true;
      this.notify();
    });
    socket.on('error', () => undefined);
  }

  static open(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const s = connect(path, () => resolve(new Client(s)));
      s.once('error', reject);
    });
  }

  send(frame: unknown): void {
    this.socket.write(JSON.stringify(frame) + '\n');
  }

  raw(data: string | Buffer): void {
    this.socket.write(data);
  }

  async waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timeout; frames=${JSON.stringify(this.frames)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  frameCount(n: number): Promise<void> {
    return this.waitFor(() => this.frames.length >= n);
  }

  whenClosed(): Promise<void> {
    return this.waitFor(() => this.closed);
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

describe('servidor IPC del sidecar', () => {
  let server: DesktopServer | null = null;
  const clients: Client[] = [];

  async function start(
    extra: { startupError?: SidecarErrorFrame; handshakeTimeoutMs?: number } = {},
  ): Promise<string> {
    const path = ipcPath();
    server = await startDesktopServer({
      ipcPath: path,
      token: TOKEN,
      core: CORE,
      natives: async () => [{ module: 'better-sqlite3', ok: true }],
      ...extra,
    });
    return path;
  }

  async function open(path: string): Promise<Client> {
    const c = await Client.open(path);
    clients.push(c);
    return c;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.destroy();
    await server?.close();
    server = null;
  });

  it('acepta el token correcto y responde al ping con el mismo id', async () => {
    const c = await open(await start());
    c.send({ type: 'handshake', token: TOKEN });
    c.send({ type: 'ping', id: 'p1' });
    await c.frameCount(2);

    expect(c.frames[0]).toMatchObject({
      type: 'handshake_ok',
      core: { protocolVersion: DESKTOP_PROTOCOL_VERSION },
      natives: [{ module: 'better-sqlite3', ok: true }],
    });
    expect(c.frames[1]).toMatchObject({ type: 'pong', id: 'p1' });
    expect(typeof c.frames[1].ts).toBe('number');
  });

  it('rechaza un token incorrecto, cierra la conexión y no procesa nada más', async () => {
    const c = await open(await start());
    c.send({ type: 'handshake', token: 'x'.repeat(64) });
    c.send({ type: 'ping', id: 'p1' });
    await c.whenClosed();

    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'bad_token' }]);
  });

  it('rechaza una conexión cuya primera trama no es el handshake', async () => {
    const c = await open(await start());
    c.send({ type: 'ping' });
    await c.whenClosed();
    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'expected_handshake' }]);
  });

  it('rechaza JSON malformado antes de autenticar', async () => {
    const c = await open(await start());
    c.raw('{no es json\n');
    await c.whenClosed();
    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'malformed' }]);
  });

  it('cierra una conexión que no se autentica a tiempo', async () => {
    const c = await open(await start({ handshakeTimeoutMs: 100 }));
    await c.whenClosed();
    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'timeout' }]);
  });

  it('limita el tamaño de trama antes de autenticar (un cliente anónimo no llena la memoria)', async () => {
    const c = await open(await start());
    c.raw('x'.repeat(8 * 1024));
    await c.whenClosed();
    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'frame_too_large' }]);
  });

  it('reconstruye tramas partidas entre chunks y separa varias en un mismo chunk', async () => {
    const c = await open(await start());
    const hs = JSON.stringify({ type: 'handshake', token: TOKEN }) + '\n';
    c.raw(hs.slice(0, 10));
    await new Promise((r) => setTimeout(r, 30));
    c.raw(hs.slice(10) + '{"type":"ping","id":"a"}\n{"type":"ping","id":"b"}\n');
    await c.frameCount(3);
    expect(c.frames.map((f) => f.id ?? f.type)).toEqual(['handshake_ok', 'a', 'b']);
  });

  it('tras el handshake envía el error de arranque (config incompatible) sin morir', async () => {
    const startupError: SidecarErrorFrame = {
      type: 'sidecar_error',
      fatal: true,
      code: 'schema_incompatible',
      message: 'schemaVersion 2',
    };
    const c = await open(await start({ startupError }));
    c.send({ type: 'handshake', token: TOKEN });
    c.send({ type: 'ping' });
    await c.frameCount(3);
    expect(c.frames[1]).toEqual(startupError);
    expect(c.frames[2]).toMatchObject({ type: 'pong' });
  });

  it('una trama desconocida tras autenticar es un error recuperable, no un cierre', async () => {
    const c = await open(await start());
    c.send({ type: 'handshake', token: TOKEN });
    c.send({ type: 'chat', message: 'todavía no existe en D0' });
    c.send({ type: 'ping', id: 'vivo' });
    await c.frameCount(3);
    expect(c.frames[1]).toMatchObject({ type: 'sidecar_error', fatal: false, code: 'protocol' });
    expect(c.frames[2]).toMatchObject({ type: 'pong', id: 'vivo' });
  });

  it('close() corta las conexiones abiertas', async () => {
    const c = await open(await start());
    c.send({ type: 'handshake', token: TOKEN });
    await c.frameCount(1);
    expect(server!.connectionCount()).toBe(1);
    await server!.close();
    server = null;
    await c.whenClosed();
  });
});

describe('tokensMatch', () => {
  it('compara en tiempo constante también con longitudes distintas', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(tokensMatch(TOKEN, '')).toBe(false);
  });
});

describe('servidor IPC — conversaciones (D1, 15.1)', () => {
  const CID = '6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e';
  const CHAT = { type: 'chat', conversationId: CID, turnId: 't1', text: 'hola' };
  let server: DesktopServer | null = null;
  const clients: Client[] = [];

  function sink() {
    const calls = {
      handled: [] as ConversationFrame[],
      attached: [] as number[],
      detached: [] as number[],
    };
    const conversations: ConversationSink = {
      attach: (id) => void calls.attached.push(id),
      detach: (id) => void calls.detached.push(id),
      handle: (frame) => void calls.handled.push(frame),
    };
    return { calls, conversations };
  }

  async function start(conversations: ConversationSink): Promise<string> {
    const path = ipcPath();
    server = await startDesktopServer({
      ipcPath: path,
      token: TOKEN,
      core: CORE,
      natives: async () => [],
      conversations,
    });
    return path;
  }

  async function open(path: string): Promise<Client> {
    const c = await Client.open(path);
    clients.push(c);
    return c;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.destroy();
    await server?.close();
    server = null;
  });

  it('un chat sin handshake se rechaza y nunca llega a las conversaciones', async () => {
    const { calls, conversations } = sink();
    const c = await open(await start(conversations));
    c.send(CHAT);
    await c.whenClosed();
    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'expected_handshake' }]);
    expect(calls.handled).toEqual([]);
    expect(calls.attached).toEqual([]);
  });

  it('un token incorrecto seguido de un chat en el mismo chunk tampoco llega', async () => {
    const { calls, conversations } = sink();
    const c = await open(await start(conversations));
    c.raw(
      JSON.stringify({ type: 'handshake', token: 'y'.repeat(64) }) +
        '\n' +
        JSON.stringify(CHAT) +
        '\n',
    );
    await c.whenClosed();
    expect(c.frames).toEqual([{ type: 'handshake_error', reason: 'bad_token' }]);
    expect(calls.handled).toEqual([]);
  });

  it('con token, las tramas de conversación llegan en orden tras el handshake_ok', async () => {
    const { calls, conversations } = sink();
    const c = await open(await start(conversations));
    // El chat viaja pegado al handshake: se encola mientras se sondean los nativos.
    c.raw(JSON.stringify({ type: 'handshake', token: TOKEN }) + '\n' + JSON.stringify(CHAT) + '\n');
    c.send({ type: 'cancel', conversationId: CID, turnId: 't1' });
    await c.waitFor(() => calls.handled.length === 2);
    expect(c.frames[0]).toMatchObject({ type: 'handshake_ok' });
    expect(calls.handled.map((f) => f.type)).toEqual(['chat', 'cancel']);
    expect(calls.attached).toHaveLength(1);
  });

  it('una trama de conversación inválida se contesta con error de protocolo', async () => {
    const { calls, conversations } = sink();
    const c = await open(await start(conversations));
    c.send({ type: 'handshake', token: TOKEN });
    c.send({ ...CHAT, conversationId: '../x' });
    await c.frameCount(2);
    expect(c.frames[1]).toMatchObject({ type: 'sidecar_error', code: 'protocol' });
    expect(calls.handled).toEqual([]);
  });

  it('un cliente nuevo sustituye al anterior sin que el cierre del viejo lo desconecte', async () => {
    const { calls, conversations } = sink();
    const path = await start(conversations);
    const a = await open(path);
    a.send({ type: 'handshake', token: TOKEN });
    await a.frameCount(1);
    const b = await open(path);
    b.send({ type: 'handshake', token: TOKEN });
    await b.frameCount(1);
    await a.whenClosed();

    expect(calls.attached).toHaveLength(2);
    // El cierre de `a` llega cuando `b` ya tiene el lease: no hay detach.
    expect(calls.detached).toEqual([]);
    b.send(CHAT);
    await b.waitFor(() => calls.handled.length === 1);

    b.socket.destroy();
    await b.whenClosed();
    await b.waitFor(() => calls.detached.length === 1);
    expect(calls.detached).toEqual([calls.attached[1]]);
  });
});
