import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CdpClosedError,
  CdpConnection,
  CdpError,
  CdpTimeoutError,
  browserArgs,
  launchBrowser,
  liveBrowsers,
} from './cdp.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-browser.mjs', import.meta.url));

/** Una conexión sobre dos `PassThrough`: lo que escribe Stratum y lo que «manda el navegador». */
function pipePair(options: ConstructorParameters<typeof CdpConnection>[2] = {}) {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  let pending = '';
  toBrowser.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8');
    let end: number;
    while ((end = pending.indexOf('\0')) !== -1) {
      sent.push(JSON.parse(pending.slice(0, end)) as Record<string, unknown>);
      pending = pending.slice(end + 1);
    }
  });
  const conn = new CdpConnection(fromBrowser, toBrowser, options);
  const reply = (message: Record<string, unknown>) =>
    fromBrowser.write(`${JSON.stringify(message)}\0`);
  return { conn, sent, reply, fromBrowser };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('CdpConnection', () => {
  it('correla respuestas y reparte eventos con su sesión', async () => {
    const { conn, sent, reply } = pipePair();
    const events: Array<[unknown, string | undefined]> = [];
    conn.on('Page.loadEventFired', (params, sessionId) =>
      events.push([params.timestamp, sessionId]),
    );
    const a = conn.send('Page.enable', {}, { sessionId: 'S1' });
    const b = conn.send('Runtime.evaluate', { expression: '1' });
    await tick();
    expect(sent.map((m) => [m.method, m.sessionId])).toEqual([
      ['Page.enable', 'S1'],
      ['Runtime.evaluate', undefined],
    ]);
    reply({ id: sent[1]!.id, result: { value: 2 } });
    reply({ method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: 'S1' });
    reply({ id: sent[0]!.id, result: {} });
    await expect(b).resolves.toEqual({ value: 2 });
    await expect(a).resolves.toEqual({});
    expect(events).toEqual([[7, 'S1']]);
  });

  it('un mensaje partido en trozos, y varios en un trozo', async () => {
    const { conn, sent, fromBrowser } = pipePair();
    const p1 = conn.send('A');
    const p2 = conn.send('B');
    await tick();
    const text = `${JSON.stringify({ id: sent[0]!.id, result: { x: 'hola' } })}\0${JSON.stringify({ id: sent[1]!.id, result: {} })}\0`;
    const bytes = Buffer.from(text, 'utf8');
    fromBrowser.write(bytes.subarray(0, 5));
    fromBrowser.write(bytes.subarray(5, 17));
    fromBrowser.write(bytes.subarray(17));
    await expect(p1).resolves.toEqual({ x: 'hola' });
    await expect(p2).resolves.toEqual({});
  });

  it('un error de protocolo rechaza con CdpError', async () => {
    const { conn, sent, reply } = pipePair();
    const p = conn.send('Page.navigate', { url: 'x' });
    await tick();
    reply({ id: sent[0]!.id, error: { code: -32000, message: 'Cannot navigate' } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect((err as CdpError).code).toBe(-32000);
  });

  it('una orden que caduca no deja la promesa colgada y su respuesta tardía se ignora', async () => {
    const { conn, sent, reply } = pipePair({ timeoutMs: 50 });
    const p = conn.send('Slow.method');
    await expect(p).rejects.toBeInstanceOf(CdpTimeoutError);
    reply({ id: sent[0]!.id, result: {} });
    await tick();
    expect(conn.closed).toBeNull();
    // La conexión sigue sirviendo.
    const q = conn.send('Next');
    await tick();
    reply({ id: sent[1]!.id, result: { ok: true } });
    await expect(q).resolves.toEqual({ ok: true });
  });

  it('pasarse del tope de mensaje cierra la conexión y rechaza lo pendiente', async () => {
    let closedWith = '';
    const { conn, fromBrowser } = pipePair({
      maxMessageBytes: 1024,
      onClose: (r) => (closedWith = r),
    });
    const p = conn.send('Page.captureScreenshot');
    fromBrowser.write('{"id":1,"result":{"data":"' + 'x'.repeat(2000));
    await expect(p).rejects.toBeInstanceOf(CdpClosedError);
    expect(conn.closed).toMatch(/exceeded 1024 bytes/);
    expect(closedWith).toMatch(/exceeded/);
    await expect(conn.send('Other')).rejects.toBeInstanceOf(CdpClosedError);
  });

  it('el tope cuenta también un mensaje completo en un solo trozo', async () => {
    const { conn, fromBrowser } = pipePair({ maxMessageBytes: 100 });
    fromBrowser.write(`${JSON.stringify({ method: 'X', params: { v: 'y'.repeat(200) } })}\0`);
    await tick();
    expect(conn.closed).toMatch(/exceeded/);
  });

  it('cancelar con la señal rechaza sin cerrar la conexión', async () => {
    const { conn } = pipePair();
    const abort = new AbortController();
    const p = conn.send('Runtime.evaluate', {}, { signal: abort.signal });
    abort.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(conn.closed).toBeNull();
  });

  it('el fin del pipe cierra y rechaza', async () => {
    const { conn, fromBrowser } = pipePair();
    const p = conn.send('A');
    fromBrowser.end();
    await expect(p).rejects.toBeInstanceOf(CdpClosedError);
  });
});

describe('launchBrowser', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('los argumentos son fijos y no abren ningún puerto', () => {
    const args = browserArgs('/tmp/profile');
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
    expect(args.at(-1)).toBe('about:blank');
  });

  it('habla con el navegador por los fd 3 y 4, y kill() lo termina', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratum-cdp-'));
    dirs.push(dir);
    const browser = launchBrowser({
      executable: process.execPath,
      argsPrefix: [FIXTURE],
      userDataDir: dir,
    });
    expect(liveBrowsers()).toBeGreaterThan(0);
    await expect(browser.connection.send('Browser.getVersion')).resolves.toEqual({});
    await browser.kill();
    await browser.exited;
    expect(browser.connection.closed).not.toBeNull();
  });
});
