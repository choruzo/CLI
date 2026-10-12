import { describe, it, expect, vi } from 'vitest';
import { ProtocolError } from './codec.js';
import {
  NotSentError,
  ProtocolViolationError,
  RpcPeer,
  UnknownOutcomeError,
  type RequestHandlers,
  type RpcPeerOptions,
} from './peer.js';
import { sampleRun, sampleSnapshot } from '../protocol/protocol.fixtures.js';
import type { ValidatedNotification } from './codec.js';

/**
 * Dos peers unidos en memoria. Las líneas no se entregan solas: `flush()` las
 * reparte, de modo que cada test decide cuándo y en qué orden llega cada cosa.
 */
function pair(
  server: Partial<RpcPeerOptions> = {},
  client: Partial<RpcPeerOptions> = {},
): {
  client: RpcPeer;
  server: RpcPeer;
  toServer: string[];
  toClient: string[];
  flush: () => Promise<void>;
} {
  const toServer: string[] = [];
  const toClient: string[] = [];
  const clientPeer = new RpcPeer({ send: (line) => (toServer.push(line), true), ...client });
  const serverPeer = new RpcPeer({ send: (line) => (toClient.push(line), true), ...server });
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20 && (toServer.length > 0 || toClient.length > 0); i++) {
      for (const line of toServer.splice(0)) serverPeer.handleLine(line);
      await new Promise((r) => setImmediate(r));
      for (const line of toClient.splice(0)) clientPeer.handleLine(line);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { client: clientPeer, server: serverPeer, toServer, toClient, flush };
}

/** Captura el rechazo en el acto, para que no quede sin manejar mientras se reparte el canal. */
const caught = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

const run = sampleRun();
const handlers: RequestHandlers = {
  'runs.get': ({ runId }) => ({ run: { ...run, id: runId } }),
  'core.status': () => {
    throw new Error('ENOENT /home/user/.stratum/daemon/endpoint.json');
  },
  'runs.start': () => {
    throw new ProtocolError('BUSY', 'Session has a run in progress.');
  },
};

describe('RpcPeer — petición y respuesta', () => {
  it('correlaciona cada respuesta con su petición', async () => {
    const { client, flush } = pair({ handlers });
    const a = client.request('runs.get', { runId: 'run_a' });
    const b = client.request('runs.get', { runId: 'run_b' });
    await flush();
    expect((await a).run.id).toBe('run_a');
    expect((await b).run.id).toBe('run_b');
    expect(client.pendingCount).toBe(0);
  });

  it('dos peticiones concurrentes con las respuestas en orden inverso', async () => {
    const { client, toServer, toClient } = pair();
    const first = client.request('runs.get', { runId: 'run_1' });
    const second = client.request('runs.get', { runId: 'run_2' });
    const [idFirst, idSecond] = toServer.map((l) => (JSON.parse(l) as { id: number }).id);
    expect(idFirst).not.toBe(idSecond);

    // El servidor contesta primero a la segunda.
    client.handleLine(JSON.stringify({ id: idSecond, result: { run: { ...run, id: 'run_2' } } }));
    client.handleLine(JSON.stringify({ id: idFirst, result: { run: { ...run, id: 'run_1' } } }));

    expect((await first).run.id).toBe('run_1');
    expect((await second).run.id).toBe('run_2');
    expect(toClient).toEqual([]);
  });

  it('un error del otro extremo llega como ProtocolError con su código', async () => {
    const { client, flush } = pair({ handlers });
    const failure = caught(client.request('runs.start', { sessionId: 's1', input: 'hola' }));
    await flush();
    expect(await failure).toMatchObject({ name: 'ProtocolError', code: 'BUSY' });
  });

  it('método desconocido → METHOD_NOT_FOUND', async () => {
    const { server, toClient } = pair({ handlers });
    server.handleLine(JSON.stringify({ id: 1, method: 'runs.explode', params: {} }));
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(toClient[0]!)).toMatchObject({ id: 1, error: { code: 'METHOD_NOT_FOUND' } });
  });

  it('método del contrato que este extremo no atiende → METHOD_NOT_FOUND', async () => {
    const { client, flush } = pair({ handlers });
    const failure = caught(client.request('sessions.list', {}));
    await flush();
    expect(await failure).toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('payload inválido → INVALID_PARAMS, y el handler no se ejecuta', async () => {
    const get = vi.fn(() => ({ run }));
    const { server, toClient } = pair({ handlers: { 'runs.get': get } });
    server.handleLine(JSON.stringify({ id: 4, method: 'runs.get', params: { runId: 7, x: 1 } }));
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(toClient[0]!)).toMatchObject({ id: 4, error: { code: 'INVALID_PARAMS' } });
    expect(get).not.toHaveBeenCalled();
  });

  it('una excepción del handler no filtra stack ni rutas', async () => {
    const wire: string[] = [];
    const { client, toClient, flush } = pair({ handlers });
    const failure = caught(client.request('core.status', {}));
    // Se apunta lo que viaja por el canal, además de lo que recibe quien llama.
    const push = toClient.push.bind(toClient);
    toClient.push = (...lines: string[]) => (wire.push(...lines), push(...lines));
    await flush();
    const err = (await failure) as ProtocolError;
    expect(wire).toHaveLength(1);
    expect(wire[0]).not.toContain('/home/user');
    expect(wire[0]).not.toContain('ENOENT');
    expect(wire[0]).not.toContain('stack');
    expect(err).toMatchObject({ name: 'ProtocolError', code: 'INTERNAL_ERROR' });
    expect(err.message).not.toContain('/home/user');
    expect(err.message).not.toContain('ENOENT');
  });

  it('el guard rechaza antes de llegar al handler', async () => {
    const get = vi.fn(() => ({ run }));
    const { client, flush } = pair({
      handlers: { 'runs.get': get },
      guard: () => ({ code: 'UNAUTHORIZED', message: 'Handshake required.' }),
    });
    const failure = caught(client.request('runs.get', { runId: 'run_1' }));
    await flush();
    expect(await failure).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(get).not.toHaveBeenCalled();
  });

  it('una respuesta que no cumple el contrato es una violación del protocolo', async () => {
    const { client, toServer } = pair();
    const pending = client.request('runs.get', { runId: 'run_1' });
    const { id } = JSON.parse(toServer[0]!) as { id: number };
    client.handleLine(JSON.stringify({ id, result: { run: { id: 'run_1' } } }));
    await expect(pending).rejects.toBeInstanceOf(ProtocolViolationError);
  });
});

describe('RpcPeer — tamaño', () => {
  it('una petición mayor que el límite no se envía: FRAME_TOO_LARGE local', async () => {
    const sent: string[] = [];
    const peer = new RpcPeer({ send: (l) => (sent.push(l), true), maxMessageBytes: 256 });
    const failure = caught(peer.request('runs.steer', { sessionId: 's1', text: 'x'.repeat(400) }));
    expect(await failure).toMatchObject({ code: 'FRAME_TOO_LARGE', data: { limit: 256 } });
    expect(sent).toEqual([]);
    expect(peer.pendingCount).toBe(0);

    void caught(peer.request('runs.steer', { sessionId: 's1', text: 'corto' }));
    expect(sent).toHaveLength(1);
  });
});

describe('RpcPeer — notificaciones', () => {
  it('una notificación (sin id) va a su manejador y no se confunde con una respuesta', async () => {
    const seen: ValidatedNotification[] = [];
    const { client, server, toServer, flush } = pair({}, { onNotification: (n) => seen.push(n) });
    const pending = client.request('runs.get', { runId: 'run_1' });
    const { id } = JSON.parse(toServer.splice(0)[0]!) as { id: number };

    server.notify('snapshot', { subscriptionId: 'sub1', snapshot: sampleSnapshot() });
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ name: 'snapshot', params: { subscriptionId: 'sub1' } });
    // La petición sigue esperando: la notificación no la resolvió.
    expect(client.pendingCount).toBe(1);

    client.handleLine(JSON.stringify({ id, result: { run } }));
    expect((await pending).run.id).toBe(run.id);
  });

  it('una notificación no genera respuesta', async () => {
    const { server, toClient } = pair();
    server.handleLine(JSON.stringify({ method: 'goodbye', params: { reason: 'shutdown' } }));
    await new Promise((r) => setImmediate(r));
    expect(toClient).toEqual([]);
  });

  it('una notificación desconocida se ignora sin romper nada', async () => {
    const problems: string[] = [];
    const seen: ValidatedNotification[] = [];
    const { client } = pair(
      {},
      { onNotification: (n) => seen.push(n), onProtocolError: (d) => problems.push(d) },
    );
    client.handleLine(JSON.stringify({ method: 'future.thing', params: { a: 1 } }));
    client.handleLine(JSON.stringify({ method: 'goodbye', params: { reason: 'idle' } }));
    expect(seen.map((n) => n.name)).toEqual(['goodbye']);
    expect(problems).toHaveLength(1);
  });
});

describe('RpcPeer — líneas mal formadas', () => {
  it('basura no tumba el peer; una petición mal formada con id recibe respuesta', async () => {
    const problems: string[] = [];
    const { server, toClient } = pair({ handlers, onProtocolError: (d) => problems.push(d) });
    server.handleLine('esto no es json');
    server.handleLine('{"id":3,"method":"runs.get","params":{},"extra":1}');
    server.handleLine(JSON.stringify({ id: 5, method: 'runs.get', params: { runId: 'run_9' } }));
    await new Promise((r) => setImmediate(r));

    const replies = toClient.map((l) => JSON.parse(l) as { id: number | null });
    expect(replies).toEqual([
      expect.objectContaining({
        id: 3,
        error: expect.objectContaining({ code: 'INVALID_REQUEST' }),
      }),
      expect.objectContaining({ id: 5, result: expect.anything() }),
    ]);
    expect(problems.length).toBe(2);
  });

  it('una respuesta que nadie esperaba se descarta', () => {
    const problems: string[] = [];
    const { client } = pair({}, { onProtocolError: (d) => problems.push(d) });
    client.handleLine(JSON.stringify({ id: 99, result: {} }));
    expect(problems).toEqual(['response without a pending request']);
  });
});

describe('RpcPeer — resultado desconocido', () => {
  it('si la conexión cae con la petición enviada, el resultado es desconocido', async () => {
    const { client } = pair();
    const mutating = client.request('approvals.resolve', { approvalId: 'a1', decision: 'approve' });
    const reading = client.request('sessions.list', {});
    client.close();

    const errMutating = (await mutating.catch((e: unknown) => e)) as UnknownOutcomeError;
    expect(errMutating).toBeInstanceOf(UnknownOutcomeError);
    expect(errMutating).toMatchObject({
      outcome: 'unknown',
      reason: 'connection-lost',
      method: 'approvals.resolve',
      mutating: true,
    });
    const errReading = (await reading.catch((e: unknown) => e)) as UnknownOutcomeError;
    expect(errReading.mutating).toBe(false);
  });

  it('el peer no reenvía nada por su cuenta: cada petición sale una vez', async () => {
    const { client, toServer } = pair();
    const pending = client.request('runs.start', { sessionId: 's1', input: 'hola' });
    client.close();
    await pending.catch(() => undefined);
    expect(toServer).toHaveLength(1);
  });

  it('vencido el plazo, el resultado es desconocido y la respuesta tardía se ignora', async () => {
    const problems: string[] = [];
    const { client, toServer } = pair({}, { onProtocolError: (d) => problems.push(d) });
    const pending = client.request('runs.cancel', { sessionId: 's1' }, { timeoutMs: 20 });
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown', reason: 'timeout' });

    const { id } = JSON.parse(toServer[0]!) as { id: number };
    client.handleLine(JSON.stringify({ id, result: {} }));
    expect(problems).toEqual(['response without a pending request']);
  });

  it('abortar deja de esperar, pero la petición ya salió', async () => {
    const { client, toServer } = pair();
    const controller = new AbortController();
    const pending = client.request(
      'runs.pause',
      { sessionId: 's1' },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown', reason: 'aborted' });
    expect(toServer).toHaveLength(1);
  });

  it('sin conexión la petición no sale: se puede reenviar', async () => {
    const sent: string[] = [];
    const offline = new RpcPeer({ send: () => false });
    await expect(
      offline.request('runs.start', { sessionId: 's', input: 'x' }),
    ).rejects.toMatchObject({ name: 'NotSentError', outcome: 'not-sent' });

    const closed = new RpcPeer({ send: (l) => (sent.push(l), true) });
    closed.close();
    await expect(closed.request('sessions.list', {})).rejects.toBeInstanceOf(NotSentError);
    expect(sent).toEqual([]);

    const aborted = new RpcPeer({ send: (l) => (sent.push(l), true) });
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.request('sessions.list', {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'NotSentError', reason: 'aborted' });
    expect(sent).toEqual([]);
  });
});
