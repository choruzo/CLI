import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeWebSocket } from './ws-node.js';

class NativeFake {
  static last: NativeFake | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    NativeFake.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  NativeFake.last = undefined;
});

describe('nodeWebSocket', () => {
  it('sin WebSocket global no hay constructor', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(nodeWebSocket()).toBeUndefined();
  });

  it('adapta los manejadores y reenvía send y close', () => {
    vi.stubGlobal('WebSocket', NativeFake);
    const Ctor = nodeWebSocket()!;
    const ws = new Ctor('ws://ha.casa/api/websocket');
    const native = NativeFake.last!;
    expect(native.url).toBe('ws://ha.casa/api/websocket');
    const got: unknown[] = [];
    ws.onmessage = (ev) => got.push(ev.data);
    native.onmessage?.({ data: '{"type":"auth_required"}' });
    expect(got).toEqual(['{"type":"auth_required"}']);
    ws.send('hola');
    expect(native.sent).toEqual(['hola']);
    ws.onmessage = null;
    expect(native.onmessage).toBeNull();
    ws.close();
    expect(native.closed).toBe(true);
  });
});
