import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { JsonRpcConnection, JsonRpcError } from './jsonrpc.js';

/** Deja correr los 'data' de los PassThrough (salen en el siguiente tick). */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Mensajes que ha escrito la conexión, ya desenmarcados. */
function frames(raw: Buffer): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let buffer = raw;
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n');
    if (separator === -1) return out;
    const header = buffer.subarray(0, separator).toString('ascii');
    const match = /content-length:\s*(\d+)/i.exec(header);
    expect(match).not.toBeNull();
    const length = Number(match![1]);
    const start = separator + 4;
    if (buffer.length < start + length) return out;
    out.push(JSON.parse(buffer.subarray(start, start + length).toString('utf8')));
    buffer = buffer.subarray(start + length);
  }
}

function connect() {
  const fromClient = new PassThrough(); // lo escribe la conexión, lo lee el test
  const toClient = new PassThrough(); // lo escribe el test, lo lee la conexión
  const written: Buffer[] = [];
  fromClient.on('data', (chunk: Buffer) => written.push(chunk));
  const connection = new JsonRpcConnection({ readable: toClient, writable: fromClient });
  return {
    connection,
    toClient,
    sent: () => frames(Buffer.concat(written)),
    rawSent: () => Buffer.concat(written),
  };
}

describe('JsonRpcConnection — framing', () => {
  it('escribe la cabecera Content-Length en bytes UTF-8', async () => {
    const { connection, rawSent, sent } = connect();
    connection.notify('textDocument/didOpen', { text: 'año' });
    await tick();

    const raw = rawSent().toString('binary');
    expect(raw.startsWith('Content-Length: ')).toBe(true);
    // "año" ocupa 4 bytes en UTF-8: el largo es en bytes, no en caracteres.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: { text: 'año' },
    });
    expect(raw).toContain(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`);
    expect(sent()).toEqual([
      { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { text: 'año' } },
    ]);
    connection.close();
  });

  it('resuelve una respuesta con las cabeceras partidas en trozos', async () => {
    const { connection, toClient, sent } = connect();
    const promise = connection.request('initialize', { processId: null });
    await tick();
    const id = sent()[0]!.id as number;
    expect(sent()[0]).toMatchObject({ jsonrpc: '2.0', method: 'initialize' });

    const response = frame({ jsonrpc: '2.0', id, result: { capabilities: {} } });
    toClient.write(response.subarray(0, 5));
    await tick();
    toClient.write(response.subarray(5, 21));
    await tick();
    toClient.write(response.subarray(21));
    await expect(promise).resolves.toEqual({ capabilities: {} });
    connection.close();
  });

  it('procesa varios mensajes en un chunk y tolera cabeceras con \\n solo', async () => {
    const { connection, toClient } = connect();
    const seen: string[] = [];
    connection.onNotification('window/logMessage', (params) => {
      seen.push((params as { message: string }).message);
    });

    const first = frame({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { message: 'uno' },
    });
    const second = frame({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: { message: 'dos' },
    });
    // Dos mensajes en un solo chunk, y el tercero con cabecera LF y partido.
    const thirdBody = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'tres' } }),
      'utf8',
    );
    const third = Buffer.concat([
      Buffer.from(`Content-Length: ${thirdBody.length}\n\n`, 'ascii'),
      thirdBody,
    ]);
    toClient.write(Buffer.concat([first, second, third.subarray(0, 8)]));
    await tick();
    expect(seen).toEqual(['uno', 'dos']);
    toClient.write(third.subarray(8));
    await tick();
    expect(seen).toEqual(['uno', 'dos', 'tres']);
    connection.close();
  });

  it('un Content-Length disparatado cierra el transporte en vez de reservarlo', async () => {
    const { connection, toClient } = connect();
    const pending = connection.request('quedó');
    // El rechazo llega al cerrar: se captura ya para que no quede sin manejar.
    const settled = pending.then(
      () => null,
      (error: Error) => error,
    );
    await tick();
    toClient.write(Buffer.from('Content-Length: 999999999\r\n\r\n{', 'ascii'));
    const error = await settled;
    expect(connection.isClosed).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exceeds the .* byte limit/);
  });

  it('basura sin framing no crece sin fin: se cierra al pasar del tope', async () => {
    const { connection, toClient } = connect();
    toClient.write(Buffer.from('x'.repeat(9000), 'ascii'));
    await tick();
    expect(connection.isClosed).toBe(true);
    // Y lo pendiente se rechaza con el motivo, no se queda colgado.
    await expect(connection.request('tarde')).rejects.toThrow(/closed/);
  });

  it('la desuscripción deja de entregar notificaciones', async () => {
    const { connection, toClient } = connect();
    let calls = 0;
    const off = connection.onNotification('window/logMessage', () => {
      calls++;
    });
    toClient.write(frame({ jsonrpc: '2.0', method: 'window/logMessage', params: {} }));
    await tick();
    off();
    toClient.write(frame({ jsonrpc: '2.0', method: 'window/logMessage', params: {} }));
    await tick();
    expect(calls).toBe(1);
    connection.close();
  });

  it('un mensaje corrupto no rompe el parser', async () => {
    const { connection, toClient } = connect();
    let calls = 0;
    connection.onNotification('window/logMessage', () => {
      calls++;
    });
    // Cuerpo con largo correcto pero JSON inválido.
    toClient.write(Buffer.from('Content-Length: 6\r\n\r\n{ no }', 'ascii'));
    await tick();
    toClient.write(frame({ jsonrpc: '2.0', method: 'window/logMessage', params: {} }));
    await tick();
    expect(calls).toBe(1);
    connection.close();
  });
});

describe('JsonRpcConnection — peticiones del servidor', () => {
  it('workspace/configuration recibe un null por cada ítem pedido', async () => {
    const { connection, toClient, sent } = connect();
    toClient.write(
      frame({
        jsonrpc: '2.0',
        id: 7,
        method: 'workspace/configuration',
        params: { items: [{ section: 'a' }, { section: 'b' }, { section: 'c' }] },
      }),
    );
    await tick();
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 7, result: [null, null, null] }]);
    connection.close();
  });

  it('responde null a registerCapability y workDoneProgress/create', async () => {
    const { connection, toClient, sent } = connect();
    toClient.write(
      frame({ jsonrpc: '2.0', id: 'r1', method: 'client/registerCapability', params: {} }),
    );
    await tick();
    toClient.write(frame({ jsonrpc: '2.0', id: 'r2', method: 'window/workDoneProgress/create' }));
    await tick();
    expect(sent()).toEqual([
      { jsonrpc: '2.0', id: 'r1', result: null },
      { jsonrpc: '2.0', id: 'r2', result: null },
    ]);
    connection.close();
  });

  it('un método desconocido se contesta con -32601 en vez de colgarse', async () => {
    const { connection, toClient, sent } = connect();
    toClient.write(frame({ jsonrpc: '2.0', id: 3, method: 'window/showMessageRequest' }));
    await tick();
    expect(sent()).toEqual([
      {
        jsonrpc: '2.0',
        id: 3,
        error: { code: -32601, message: 'method not found: window/showMessageRequest' },
      },
    ]);
    connection.close();
  });

  it('un handler propio gana a los valores por defecto', async () => {
    const { connection, toClient, sent } = connect();
    connection.onRequest('mío/favorito', (params) => ({ echo: params }));
    toClient.write(frame({ jsonrpc: '2.0', id: 1, method: 'mío/favorito', params: 42 }));
    await tick();
    expect(sent()).toEqual([{ jsonrpc: '2.0', id: 1, result: { echo: 42 } }]);
    connection.close();
  });
});

describe('JsonRpcConnection — errores y cancelación', () => {
  it('una petición sin respuesta vence con timeout', async () => {
    const { connection } = connect();
    await expect(connection.request('slow', {}, { timeoutMs: 10 })).rejects.toThrow(
      /"slow" timed out after 10 ms/,
    );
    connection.close();
  });

  it('respeta el AbortSignal', async () => {
    const { connection } = connect();
    const controller = new AbortController();
    const promise = connection.request('cancelable', {}, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    connection.close();
  });

  it('una señal ya abortada no llega a escribir', async () => {
    const { connection, sent } = connect();
    const controller = new AbortController();
    controller.abort();
    await expect(connection.request('nada', {}, { signal: controller.signal })).rejects.toThrow(
      /aborted/,
    );
    await tick();
    expect(sent()).toEqual([]);
    connection.close();
  });

  it('una respuesta de error llega como JsonRpcError', async () => {
    const { connection, toClient, sent } = connect();
    const promise = connection.request('boom');
    await tick();
    const id = sent()[0]!.id as number;
    toClient.write(
      frame({ jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params' } }),
    );
    const error = await promise.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(JsonRpcError);
    expect(error).toMatchObject({ code: -32602, message: 'invalid params' });
    connection.close();
  });

  it('cerrar rechaza lo pendiente y bloquea nuevas peticiones', async () => {
    const { connection } = connect();
    const pending = connection.request('quedó');
    await tick();
    connection.close();
    await expect(pending).rejects.toThrow(/closed/);
    await expect(connection.request('otra')).rejects.toThrow(/closed/);
    expect(connection.isClosed).toBe(true);
  });

  it('un stream que se cierra rechaza lo pendiente', async () => {
    const { connection, toClient } = connect();
    const pending = connection.request('quedó');
    await tick();
    toClient.end();
    await expect(pending).rejects.toThrow(/transport closed/);
  });
});
