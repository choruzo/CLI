import { describe, expect, it } from 'vitest';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { createHaWs, websocketUrl, type WebSocketCtor, type WebSocketLike } from './ws.js';

const TOKEN = 'tok-secreto-123';

type Script = (sock: FakeSocket, sent: Record<string, unknown>) => void;

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(
    readonly url: string,
    private readonly script: Script,
    hello = true,
  ) {
    FakeSocket.last = this;
    if (hello) queueMicrotask(() => this.emit({ type: 'auth_required', ha_version: '2026.11.2' }));
  }
  emit(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  send(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(m);
    queueMicrotask(() => this.script(this, m));
  }
  close(): void {
    this.closed = true;
  }
}

function ctor(script: Script, hello = true): WebSocketCtor {
  return class extends FakeSocket {
    constructor(url: string) {
      super(url, script, hello);
    }
  };
}

/** HA que acepta el token y contesta la orden con `reply(msg)`. */
function ha(reply: (m: Record<string, unknown>) => Record<string, unknown>): WebSocketCtor {
  return ctor((sock, m) => {
    if (m.type === 'auth') {
      sock.emit(m.access_token === TOKEN ? { type: 'auth_ok' } : { type: 'auth_invalid' });
      return;
    }
    sock.emit({ type: 'result', id: m.id, ...reply(m) });
  });
}

function client(WebSocket: WebSocketCtor, extra: { token?: string; timeoutMs?: number } = {}) {
  const c = createHaWs({
    WebSocket,
    url: 'http://ha.local:8123',
    token: extra.token ?? TOKEN,
    timeoutMs: extra.timeoutMs,
  });
  if (!c) throw new Error('sin cliente');
  return c;
}

async function failure(p: Promise<unknown>): Promise<ToolUserError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUserError);
    return err as ToolUserError;
  }
  throw new Error('no falló');
}

describe('websocketUrl', () => {
  it('pasa de http(s) a ws(s) y conserva la ruta base', () => {
    expect(websocketUrl('http://ha.local:8123')).toBe('ws://ha.local:8123/api/websocket');
    expect(websocketUrl('https://casa.example/ha/')).toBe('wss://casa.example/ha/api/websocket');
    expect(websocketUrl('ftp://x')).toBeNull();
    expect(websocketUrl(undefined)).toBeNull();
  });
});

describe('createHaWs', () => {
  it('sin URL, token o WebSocket no hay cliente', () => {
    const W = ha(() => ({ success: true, result: [] }));
    expect(createHaWs({ WebSocket: W, token: TOKEN })).toBeNull();
    expect(createHaWs({ WebSocket: W, url: 'http://h', token: ' ' })).toBeNull();
    expect(createHaWs({ WebSocket: undefined, url: 'http://h', token: TOKEN })).toBeNull();
  });

  it('autentica, manda la orden con id y devuelve el result', async () => {
    const W = ha((m) => ({ success: true, result: [{ run_id: 'a', echo: m.domain }] }));
    const result = await client(W).command({ type: 'trace/list', domain: 'automation' });
    expect(result).toEqual([{ run_id: 'a', echo: 'automation' }]);
    const sock = FakeSocket.last!;
    expect(sock.url).toBe('ws://ha.local:8123/api/websocket');
    expect(sock.sent).toEqual([
      { type: 'auth', access_token: TOKEN },
      { type: 'trace/list', domain: 'automation', id: 1 },
    ]);
    expect(sock.closed).toBe(true);
  });

  it('acepta mensajes coalescidos en una lista', async () => {
    const W = ctor((sock, m) => {
      if (m.type === 'auth') sock.emit({ type: 'auth_ok' });
      else
        sock.emit([
          { type: 'event', id: 9 },
          { type: 'result', id: m.id, success: true, result: 7 },
        ]);
    });
    expect(await client(W).command({ type: 'repairs/list_issues' })).toBe(7);
  });

  it('veta una orden que no es de lectura sin abrir la conexión', async () => {
    FakeSocket.last = null;
    const W = ha(() => ({ success: true, result: null }));
    const err = await failure(client(W).command({ type: 'config/automation/config/delete' }));
    expect(err.message).toMatch(/no permitida/);
    expect(FakeSocket.last).toBeNull();
  });

  it('un token rechazado es `auth` y no aparece en el mensaje', async () => {
    const W = ha(() => ({ success: true, result: [] }));
    const err = await failure(
      client(W, { token: 'otro-token' }).command({ type: 'trace/list', domain: 'automation' }),
    );
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/stratum connectors setup home-assistant/);
    expect(err.message).not.toContain('otro-token');
  });

  it('un error de la orden se enseña tapando el token, sin clasificar', async () => {
    const W = ha(() => ({
      success: false,
      error: { code: 'not_found', message: `no hay traza para ${TOKEN}` },
    }));
    const err = await failure(
      client(W).command({ type: 'trace/get', domain: 'automation', item_id: 'x', run_id: 'y' }),
    );
    expect(err.kind).toBeUndefined();
    expect(err.message).toContain('not_found');
    expect(err.message).not.toContain(TOKEN);
  });

  it('sin respuesta en el plazo es `unreachable`', async () => {
    const W = ctor(() => {}, false);
    const err = await failure(
      client(W, { timeoutMs: 20 }).command({ type: 'trace/list', domain: 'automation' }),
    );
    expect(err.kind).toBe('unreachable');
    expect(err.message).toMatch(/tiempo de espera/);
  });

  it('un error de conexión antes de autenticar es `unreachable`', async () => {
    const W = class extends FakeSocket {
      constructor(url: string) {
        super(url, () => {}, false);
        queueMicrotask(() => this.onerror?.({}));
      }
    };
    const err = await failure(client(W).command({ type: 'trace/list', domain: 'automation' }));
    expect(err.kind).toBe('unreachable');
  });

  it('un cierre tras autenticar no se toma por inalcanzable', async () => {
    const W = ctor((sock, m) => {
      if (m.type === 'auth') sock.emit({ type: 'auth_ok' });
      else sock.onclose?.({});
    });
    const err = await failure(client(W).command({ type: 'trace/list', domain: 'automation' }));
    expect(err.kind).toBeUndefined();
    expect(err.message).toMatch(/cerró la conexión/);
  });

  it('una cancelación no se clasifica', async () => {
    const W = ctor(() => {}, false);
    const ac = new AbortController();
    const p = client(W).command({ type: 'trace/list', domain: 'automation' }, ac.signal);
    ac.abort();
    const err = await failure(p);
    expect(err.kind).toBeUndefined();
    expect(err.message).toMatch(/cancelada/);
  });

  it('un constructor que lanza es `unreachable`', async () => {
    const W = class {
      constructor() {
        throw new Error('url rara');
      }
    } as unknown as WebSocketCtor;
    const err = await failure(client(W).command({ type: 'trace/list', domain: 'automation' }));
    expect(err.kind).toBe('unreachable');
  });
});
