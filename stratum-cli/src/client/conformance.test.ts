import { describe, it, expect, afterEach, vi } from 'vitest';
import { connect as netConnect, type Socket } from 'net';
import { StratumClient, ServerUnavailableError, type ClientStatus } from './client.js';
import { staticDiscovery, type Endpoint } from './discovery.js';
import { ProtocolMismatchError, type ClientIdentity } from './handshake.js';
import { startFakeServer, type FakeServer, type FakeServerOptions } from './testing/fake-server.js';
import { ProtocolError, encodeMessage } from '../ipc/codec.js';
import { LineDecoder } from '../ipc/framing.js';
import { NotSentError, UnknownOutcomeError } from '../ipc/peer.js';
import {
  MAX_MESSAGE_BYTES,
  MAX_UNAUTHENTICATED_MESSAGE_BYTES,
  STRATUM_PROTOCOL_VERSION,
} from '../protocol/index.js';
import { sampleRun, sampleSession } from '../protocol/protocol.fixtures.js';

/**
 * Conformidad del cliente con el Stratum Protocol, contra un servidor de
 * pruebas que lo habla sobre un pipe real.
 */

vi.setConfig({ testTimeout: 20_000 });

const identity: ClientIdentity = {
  kind: 'cli',
  name: 'conformance',
  version: '0.0.0-test',
  roles: ['operator', 'approver'],
};

let server: FakeServer | null = null;
const clients: StratumClient[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.destroy();
  await server?.close();
  server = null;
});

async function setup(
  options: FakeServerOptions = {},
  client: Partial<ConstructorParameters<typeof StratumClient>[0]> = {},
): Promise<{ server: FakeServer; client: StratumClient; statuses: ClientStatus[] }> {
  server = await startFakeServer(options);
  const live = server;
  const statuses: ClientStatus[] = [];
  const c = new StratumClient({
    discovery: staticDiscovery(() => live.endpoint),
    identity,
    reconnect: { initialMs: 20, maxMs: 40, jitter: 0 },
    onStatus: (s) => statuses.push(s),
    ...client,
  });
  clients.push(c);
  return { server: live, client: c, statuses };
}

const caught = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Socket crudo, para hablar con el servidor sin pasar por el cliente. */
function rawSocket(endpoint: Endpoint): Promise<{ socket: Socket; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(endpoint.ipcPath);
    sockets.push(socket);
    const lines: string[] = [];
    const decoder = new LineDecoder(MAX_MESSAGE_BYTES * 2);
    socket.on('data', (chunk: Buffer) => lines.push(...decoder.push(chunk)));
    socket.on('error', reject);
    socket.once('connect', () => resolve({ socket, lines }));
  });
}

/** Respuesta a la petición `id`. Las respuestas no tienen por qué llegar en el orden de las peticiones. */
const replyTo = (lines: string[], id: number): Record<string, unknown> =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((m) => m.id === id) ?? {};

const helloLine = (endpoint: Endpoint, id = 1): string =>
  encodeMessage({
    id,
    method: 'core.hello',
    params: {
      protocol: STRATUM_PROTOCOL_VERSION,
      token: endpoint.token,
      client: { kind: 'cli', name: 'raw', version: '0' },
      roles: ['operator'],
    },
  });

describe('handshake y versión', () => {
  it('conecta, se identifica y recibe sus capacidades', async () => {
    const { server, client, statuses } = await setup();
    const hello = await client.connect();

    expect(hello.protocol).toBe(STRATUM_PROTOCOL_VERSION);
    expect(hello.capabilities).toEqual(['observe', 'control', 'approve']);
    expect(client.capabilities).toEqual(hello.capabilities);
    expect(statuses).toEqual(['connecting', 'ready']);
    expect(server.received[0]).toMatchObject({
      method: 'core.hello',
      params: {
        protocol: STRATUM_PROTOCOL_VERSION,
        client: { kind: 'cli', name: 'conformance', version: '0.0.0-test' },
        roles: ['operator', 'approver'],
      },
    });
  });

  it('versión incompatible: error claro y ningún método normal llega a enviarse', async () => {
    // El endpoint anuncia la v1, pero el servidor que hay detrás habla otra.
    const { server, client } = await setup({ protocol: 7 }, {});
    const live = server;
    const lying = new StratumClient({
      discovery: staticDiscovery({ ...live.endpoint, protocol: STRATUM_PROTOCOL_VERSION }),
      identity,
      reconnect: false,
    });
    clients.push(lying);

    const err = await caught(lying.connect());
    expect(err).toBeInstanceOf(ProtocolMismatchError);
    expect(err).toMatchObject({ clientProtocol: 1, serverProtocol: 7 });
    expect((err as Error).message).toContain('v7');
    expect(lying.status).toBe('closed');
    await expect(lying.request('sessions.list', {})).rejects.toBeInstanceOf(NotSentError);
    expect(live.received.map((r) => r.method)).toEqual(['core.hello']);

    // Y si ya el endpoint lo delata, ni se conecta.
    const err2 = await caught(client.connect());
    expect(err2).toBeInstanceOf(ProtocolMismatchError);
    expect(live.accepted).toBe(1);
  });

  it('un servidor que acepta pero dice hablar otra versión tampoco vale', async () => {
    const { client } = await setup({ reportProtocol: 2 });
    const err = await caught(client.connect());
    expect(err).toMatchObject({ name: 'ProtocolMismatchError', serverProtocol: 2 });
    expect(client.status).toBe('closed');
  });

  it('token incorrecto → UNAUTHORIZED, sin reintentos', async () => {
    const { server, client } = await setup();
    const bad = new StratumClient({
      discovery: staticDiscovery({ ...server.endpoint, token: 'x'.repeat(64) }),
      identity,
    });
    clients.push(bad);
    expect(await caught(bad.connect())).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(bad.status).toBe('closed');
    client.close();
  });

  it('antes del handshake no se atiende ningún método', async () => {
    const { server } = await setup({ handlers: { 'sessions.list': () => ({ sessions: [] }) } });
    const { socket, lines } = await rawSocket(server.endpoint);
    socket.write(encodeMessage({ id: 1, method: 'sessions.list', params: {} }));
    await until(() => lines.length === 1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 1, error: { code: 'UNAUTHORIZED' } });
    expect(server.received).toEqual([]);
  });

  it('sin servidor: ServerUnavailableError', async () => {
    const client = new StratumClient({ discovery: staticDiscovery(() => null), identity });
    clients.push(client);
    const err = await caught(client.connect());
    expect(err).toBeInstanceOf(ServerUnavailableError);
    expect(err).toMatchObject({ discovery: 'absent' });
  });
});

describe('peticiones', () => {
  const run = sampleRun();

  it('método desconocido → METHOD_NOT_FOUND', async () => {
    const { server, client } = await setup();
    await client.connect();
    // Un método del contrato que este servidor no atiende…
    expect(await caught(client.request('runs.list', {}))).toMatchObject({
      name: 'ProtocolError',
      code: 'METHOD_NOT_FOUND',
    });
    // …y uno que no existe en absoluto, enviado a mano.
    const { socket, lines } = await rawSocket(server.endpoint);
    socket.write(helloLine(server.endpoint));
    socket.write(encodeMessage({ id: 2, method: 'runs.explode', params: {} }));
    await until(() => lines.length === 2);
    expect(replyTo(lines, 2)).toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });
  });

  it('payload inválido → INVALID_PARAMS, y el handler no se ejecuta', async () => {
    const get = vi.fn(() => ({ run }));
    const { server } = await setup({ handlers: { 'runs.get': get } });
    const { socket, lines } = await rawSocket(server.endpoint);
    socket.write(helloLine(server.endpoint));
    socket.write(encodeMessage({ id: 2, method: 'runs.get', params: { runId: 42, extra: true } }));
    await until(() => lines.length === 2);

    const reply = replyTo(lines, 2) as { error: { code: string; data: { issues: unknown[] } } };
    expect(reply.error.code).toBe('INVALID_PARAMS');
    expect(reply.error.data.issues.length).toBeGreaterThan(0);
    expect(get).not.toHaveBeenCalled();
  });

  it('petición y respuesta correlacionadas', async () => {
    const { client } = await setup({
      handlers: { 'runs.get': ({ runId }) => ({ run: { ...run, id: runId } }) },
    });
    await client.connect();
    const ids = ['run_a', 'run_b', 'run_c', 'run_d'];
    const results = await Promise.all(ids.map((runId) => client.request('runs.get', { runId })));
    expect(results.map((r) => r.run.id)).toEqual(ids);
  });

  it('dos peticiones concurrentes cuyas respuestas llegan en orden inverso', async () => {
    const release: Array<() => void> = [];
    const { server, client } = await setup({
      handlers: {
        'runs.get': ({ runId }) =>
          new Promise((resolve) => {
            release.push(() => resolve({ run: { ...run, id: runId } }));
          }),
      },
    });
    await client.connect();
    const order: string[] = [];
    const slow = client.request('runs.get', { runId: 'primera' }).then((r) => {
      order.push(r.run.id);
      return r;
    });
    const fast = client.request('runs.get', { runId: 'segunda' }).then((r) => {
      order.push(r.run.id);
      return r;
    });
    await until(() => release.length === 2);
    expect(server.received.filter((r) => r.method === 'runs.get')).toHaveLength(2);

    release[1]!();
    expect((await fast).run.id).toBe('segunda');
    release[0]!();
    expect((await slow).run.id).toBe('primera');
    expect(order).toEqual(['segunda', 'primera']);
  });

  it('una notificación sin id no se toma por respuesta', async () => {
    const seen: string[] = [];
    const { server, client } = await setup(
      { silent: ['runs.get'] },
      { onNotification: (n) => seen.push(n.name) },
    );
    await client.connect();
    const pending = caught(client.request('runs.get', { runId: 'run_1' }));
    await until(() => server.received.some((r) => r.method === 'runs.get'));

    server.connections[0]!.peer.notify('goodbye', { reason: 'idle' });
    await until(() => seen.length === 1);
    expect(seen).toEqual(['goodbye']);

    // La petición sigue sin respuesta: solo la cierra el corte de la conexión.
    client.close();
    expect(await pending).toBeInstanceOf(UnknownOutcomeError);
  });

  it('un error del servidor no trae stack ni rutas', async () => {
    const { client } = await setup({
      handlers: {
        'core.status': () => {
          throw new Error('EACCES: C:\\Users\\javie\\.stratum\\daemon\\endpoint.json');
        },
      },
    });
    await client.connect();
    const err = (await caught(client.request('core.status', {}))) as ProtocolError;
    expect(err).toMatchObject({ name: 'ProtocolError', code: 'INTERNAL_ERROR' });
    expect(err.message).not.toContain('javie');
    expect(err.message).not.toContain('EACCES');
  });

  it('sin la capacidad del método → FORBIDDEN', async () => {
    const resolve = vi.fn(() => ({}));
    const { client } = await setup(
      { handlers: { 'approvals.resolve': resolve, 'runs.cancel': () => ({}) } },
      { identity: { ...identity, roles: ['operator'] } },
    );
    await client.connect();

    // Puede cancelar…
    await expect(client.request('runs.cancel', { sessionId: 's1' })).resolves.toEqual({});
    // …pero no aprobar.
    expect(
      await caught(client.request('approvals.resolve', { approvalId: 'a1', decision: 'approve' })),
    ).toMatchObject({ code: 'FORBIDDEN', data: { capability: 'approve' } });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('framing sobre el socket', () => {
  it('una petición demasiado grande no sale del cliente', async () => {
    const { server, client } = await setup({
      handlers: { 'runs.steer': () => ({ status: 'accepted' }) },
    });
    await client.connect();
    const err = await caught(
      client.request('runs.steer', { sessionId: 's1', text: 'x'.repeat(MAX_MESSAGE_BYTES) }),
    );
    expect(err).toMatchObject({ name: 'ProtocolError', code: 'FRAME_TOO_LARGE' });
    expect(server.received.some((r) => r.method === 'runs.steer')).toBe(false);
    // La conexión sigue sirviendo.
    await expect(client.request('runs.steer', { sessionId: 's1', text: 'ok' })).resolves.toEqual({
      status: 'accepted',
    });
  });

  it('el servidor corta a quien le manda una trama demasiado grande', async () => {
    const { server } = await setup();
    const { socket, lines } = await rawSocket(server.endpoint);
    let closed = false;
    socket.on('close', () => (closed = true));
    // Antes de autenticar el límite es pequeño: no hay que mandar 1 MiB para probarlo.
    socket.write('x'.repeat(MAX_UNAUTHENTICATED_MESSAGE_BYTES + 1));
    await until(() => closed);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: null, error: { code: 'FRAME_TOO_LARGE' } });
    expect(server.received).toEqual([]);
  });

  it('si el servidor manda una trama demasiado grande, el cliente corta sin procesarla', async () => {
    const seen: string[] = [];
    const { server, client, statuses } = await setup(
      {},
      { reconnect: false, onNotification: (n) => seen.push(n.name) },
    );
    await client.connect();
    const huge = JSON.stringify({
      method: 'goodbye',
      params: { reason: 'x'.repeat(MAX_MESSAGE_BYTES) },
    });
    server.connections[0]!.socket.write(huge + '\n');
    await until(() => client.status === 'closed');
    expect(seen).toEqual([]);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('desconexión a mitad de trama: la trama a medias no se entrega', async () => {
    const seen: string[] = [];
    const { server, client } = await setup(
      { silent: ['runs.get'] },
      { reconnect: false, onNotification: (n) => seen.push(n.name) },
    );
    await client.connect();
    const pending = caught(client.request('runs.get', { runId: 'run_1' }));
    await until(() => server.received.some((r) => r.method === 'runs.get'));

    // Una notificación entera y media respuesta, y se corta.
    const socket = server.connections[0]!.socket;
    socket.write(encodeMessage({ method: 'goodbye', params: { reason: 'shutdown' } }));
    socket.write('{"id":2,"result":{"run":{"id":"run_');
    socket.end();

    const err = await pending;
    expect(err).toBeInstanceOf(UnknownOutcomeError);
    expect(err).toMatchObject({ reason: 'connection-lost', method: 'runs.get' });
    expect(seen).toEqual(['goodbye']);
    expect(client.status).toBe('closed');
  });

  it('un cliente lento no rompe el decoder del servidor', async () => {
    const { server } = await setup({
      handlers: { 'runs.get': ({ runId }) => ({ run: { ...sampleRun(), id: runId } }) },
    });
    const { socket, lines } = await rawSocket(server.endpoint);
    const payload = Buffer.from(
      helloLine(server.endpoint) +
        encodeMessage({ id: 2, method: 'runs.get', params: { runId: 'señal-✓-日本' } }),
      'utf8',
    );
    // Gota a gota: trozos de 3 bytes, que parten los caracteres multibyte.
    for (let i = 0; i < payload.length; i += 3) {
      socket.write(payload.subarray(i, i + 3));
      if (i % 60 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    await until(() => lines.length === 2);
    expect(replyTo(lines, 2)).toMatchObject({ result: { run: { id: 'señal-✓-日本' } } });
  });
});

describe('reconexión', () => {
  it('reconecta sola y vuelve a quedar lista', async () => {
    const { server, client, statuses } = await setup({
      handlers: { 'sessions.list': () => ({ sessions: [sampleSession()] }) },
    });
    await client.connect();
    server.dropAll();
    await server.waitForAuthenticated(2);
    await until(() => client.status === 'ready');

    expect(statuses).toEqual(['connecting', 'ready', 'reconnecting', 'ready']);
    await expect(client.request('sessions.list', {})).resolves.toMatchObject({
      sessions: [{ id: sampleSession().id }],
    });
  });

  it('no reenvía una petición mutante cuya respuesta se perdió', async () => {
    const { server, client } = await setup({ silent: ['runs.start', 'approvals.resolve'] });
    await client.connect();

    const start = caught(client.request('runs.start', { sessionId: 's1', input: 'despliega' }));
    const approve = caught(
      client.request('approvals.resolve', { approvalId: 'a1', decision: 'approve' }),
    );
    await until(() => server.received.filter((r) => r.connectionId === 1).length === 3);

    // La conexión cae después de enviarlas y antes de recibir respuesta.
    server.dropAll();

    for (const [err, method] of [
      [await start, 'runs.start'],
      [await approve, 'approvals.resolve'],
    ] as const) {
      expect(err).toBeInstanceOf(UnknownOutcomeError);
      expect(err).toMatchObject({
        outcome: 'unknown',
        reason: 'connection-lost',
        mutating: true,
        method,
      });
    }

    // El cliente reconecta…
    await server.waitForAuthenticated(2);
    await until(() => client.status === 'ready');
    await new Promise((r) => setTimeout(r, 100));

    // …y en la conexión nueva no ha reenviado nada: solo el handshake.
    expect(server.received.filter((r) => r.connectionId === 2).map((r) => r.method)).toEqual([
      'core.hello',
    ]);
    expect(server.received.filter((r) => r.method === 'runs.start')).toHaveLength(1);
    expect(server.received.filter((r) => r.method === 'approvals.resolve')).toHaveLength(1);
  });

  it('mientras reconecta, una petición no se encola: NotSentError', async () => {
    const { server, client } = await setup({}, { reconnect: { initialMs: 300, jitter: 0 } });
    await client.connect();
    server.dropAll();
    await until(() => client.status === 'reconnecting');
    const err = await caught(client.request('runs.cancel', { sessionId: 's1' }));
    expect(err).toBeInstanceOf(NotSentError);
    expect(server.received.some((r) => r.method === 'runs.cancel')).toBe(false);
  });

  it('con reconexión desactivada, se queda cerrado', async () => {
    const { server, client } = await setup({}, { reconnect: false });
    await client.connect();
    server.dropAll();
    await until(() => client.status === 'closed');
    await new Promise((r) => setTimeout(r, 80));
    expect(server.accepted).toBe(1);
  });

  it('deja de reconectar si el servidor que vuelve habla otra versión', async () => {
    const first = await startFakeServer();
    let endpoint: Endpoint | null = first.endpoint;
    const statuses: ClientStatus[] = [];
    const client = new StratumClient({
      discovery: staticDiscovery(() => endpoint),
      identity,
      reconnect: { initialMs: 20, maxMs: 40, jitter: 0 },
      onStatus: (s) => statuses.push(s),
    });
    clients.push(client);
    await client.connect();

    // El servidor se reinicia actualizado a otra versión del protocolo.
    server = await startFakeServer({ protocol: 2 });
    endpoint = server.endpoint;
    await first.close();

    await until(() => client.status === 'closed');
    expect(client.closeReason).toBeInstanceOf(ProtocolMismatchError);
    expect(server.accepted).toBe(0);
  });

  it('close() corta la reconexión', async () => {
    const { server, client } = await setup({}, { reconnect: { initialMs: 50, jitter: 0 } });
    await client.connect();
    server.dropAll();
    await until(() => client.status === 'reconnecting');
    client.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(client.status).toBe('closed');
    expect(server.accepted).toBe(1);
  });
});
