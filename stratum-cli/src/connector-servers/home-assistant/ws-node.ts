/**
 * Adaptador del `WebSocket` global de Node 24 a `WebSocketLike` (`ws.ts`). El
 * tipo del global declara sus manejadores con `Event`/`MessageEvent`, y
 * `WebSocketLike` los pide con lo mínimo (`unknown`, `{ data }`), así que no
 * encajan sin un envoltorio. `undefined` si el entorno no trae `WebSocket`
 * (entonces `ha_trazas` y `ha_avisos` dicen que falta).
 */
import type { WebSocketCtor, WebSocketLike } from './ws.js';

export function nodeWebSocket(): WebSocketCtor | undefined {
  const Native: typeof WebSocket | undefined = globalThis.WebSocket;
  if (typeof Native !== 'function') return undefined;
  const Ctor: typeof WebSocket = Native;
  return class NodeWebSocket implements WebSocketLike {
    private readonly socket: WebSocket;
    private open: ((ev: unknown) => void) | null = null;
    private message: ((ev: { data: unknown }) => void) | null = null;
    private error: ((ev: unknown) => void) | null = null;
    private close_: ((ev: unknown) => void) | null = null;

    constructor(url: string) {
      this.socket = new Ctor(url);
    }

    get onopen(): ((ev: unknown) => void) | null {
      return this.open;
    }
    set onopen(h: ((ev: unknown) => void) | null) {
      this.open = h;
      this.socket.onopen = h ? (ev) => h(ev) : null;
    }
    get onmessage(): ((ev: { data: unknown }) => void) | null {
      return this.message;
    }
    set onmessage(h: ((ev: { data: unknown }) => void) | null) {
      this.message = h;
      this.socket.onmessage = h ? (ev) => h({ data: ev.data }) : null;
    }
    get onerror(): ((ev: unknown) => void) | null {
      return this.error;
    }
    set onerror(h: ((ev: unknown) => void) | null) {
      this.error = h;
      this.socket.onerror = h ? (ev) => h(ev) : null;
    }
    get onclose(): ((ev: unknown) => void) | null {
      return this.close_;
    }
    set onclose(h: ((ev: unknown) => void) | null) {
      this.close_ = h;
      this.socket.onclose = h ? (ev) => h(ev) : null;
    }

    send(data: string): void {
      this.socket.send(data);
    }
    close(): void {
      this.socket.close();
    }
  };
}
