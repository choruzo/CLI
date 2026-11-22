/**
 * Cliente mínimo de la API WebSocket de Home Assistant (M27 fase 1), para lo que
 * la API REST no da: trazas de automatizaciones y avisos de *Repairs*.
 *
 * - **Solo lectura por construcción**: `command` solo manda los tipos de
 *   `READ_COMMANDS`; cualquier otro es veto sin abrir la conexión.
 * - Una conexión por orden: abrir, autenticar, una orden, cerrar. Sin estado ni
 *   reconexión; plazo de 15 s para todo.
 * - El token solo viaja en el mensaje `auth` y se tapa en cualquier texto.
 * - `WebSocket` inyectable para tests; en la caja, el global de Node 24.
 * - Los fallos se clasifican aquí (M23): `auth` si HA rechaza el token,
 *   `unreachable` si no se llega o no contesta a tiempo. Nunca por el texto.
 */
import { ToolUserError } from '../lib/mcp-stdio.js';
import { isRecord, parseBaseUrl } from './client.js';

const TIMEOUT_MS = 15_000;
const SETUP_COMMAND = 'stratum connectors setup home-assistant';

/** Las únicas órdenes que este cliente sabe mandar. Todas leen. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  'trace/list',
  'trace/get',
  'repairs/list_issues',
]);

/** Lo que este cliente usa de un `WebSocket` (el de Node 24 lo cumple). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

/** HA no aceptó la orden (`success: false`): las tools miran `code`, nunca el texto. */
export class HaWsCommandError extends ToolUserError {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface HaWsOptions {
  WebSocket: WebSocketCtor | undefined;
  url?: string;
  token?: string;
  timeoutMs?: number;
}

export interface HaWs {
  readonly host: string;
  /** Manda una orden de `READ_COMMANDS` y devuelve su `result`. */
  command(msg: { type: string } & Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

/** `ws(s)://…/api/websocket` a partir de `HA_URL`. `null` si no vale. */
export function websocketUrl(raw: string | undefined): string | null {
  const base = parseBaseUrl(raw);
  if (!base) return null;
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${base.host}${base.pathname.replace(/\/+$/, '')}/api/websocket`;
}

/** Los mensajes de HA llegan de uno en uno o, coalescidos, en una lista. */
function messagesOf(data: unknown): Record<string, unknown>[] {
  let text: string | null = null;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(isRecord);
}

/** `null` si falta la URL, el token o no hay `WebSocket`. */
export function createHaWs(opts: HaWsOptions): HaWs | null {
  const url = websocketUrl(opts.url);
  const token = opts.token?.trim();
  const Ctor = opts.WebSocket;
  if (!url || !token || !Ctor) return null;
  const host = new URL(url).host;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const scrub = (text: string): string => text.split(token).join('***');

  return {
    host,
    command(msg, signal) {
      if (!READ_COMMANDS.has(msg.type)) {
        return Promise.reject(new ToolUserError('Orden de Home Assistant no permitida.'));
      }
      if (signal?.aborted) {
        return Promise.reject(new ToolUserError('Consulta a Home Assistant cancelada.'));
      }
      return new Promise<unknown>((resolve, reject) => {
        let ws: WebSocketLike | undefined;
        let settled = false;
        let authed = false;
        const ID = 1;

        const finish = (err: ToolUserError | null, value?: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          try {
            if (ws) {
              ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
              ws.close();
            }
          } catch {
            // ya cerrada
          }
          if (err) reject(err);
          else resolve(value);
        };
        const unreachable = (why: string): ToolUserError =>
          new ToolUserError(`No se llega a Home Assistant en ${host}${why}.`, 'unreachable');
        const onAbort = (): void =>
          finish(new ToolUserError('Consulta a Home Assistant cancelada.'));

        const timer = setTimeout(
          () => finish(unreachable(' (tiempo de espera agotado)')),
          timeoutMs,
        );
        signal?.addEventListener('abort', onAbort, { once: true });

        let socket: WebSocketLike;
        try {
          socket = new Ctor(url);
        } catch {
          finish(unreachable(''));
          return;
        }
        ws = socket;

        socket.onerror = () => finish(unreachable(''));
        socket.onclose = () =>
          finish(
            authed
              ? new ToolUserError(`Home Assistant en ${host} cerró la conexión sin responder.`)
              : unreachable(''),
          );
        socket.onmessage = (ev) => {
          for (const m of messagesOf(ev.data)) {
            if (settled) return;
            if (m.type === 'auth_required') {
              socket.send(JSON.stringify({ type: 'auth', access_token: token }));
            } else if (m.type === 'auth_invalid') {
              finish(
                new ToolUserError(
                  `Home Assistant rechazó el token: la persona debe renovarlo con \`${SETUP_COMMAND}\`.`,
                  'auth',
                ),
              );
            } else if (m.type === 'auth_ok') {
              authed = true;
              socket.send(JSON.stringify({ ...msg, id: ID }));
            } else if (m.type === 'result' && m.id === ID) {
              if (m.success === true) {
                finish(null, m.result);
              } else {
                const e = isRecord(m.error) ? m.error : {};
                const code = typeof e.code === 'string' ? scrub(e.code).slice(0, 60) : '';
                const text = typeof e.message === 'string' ? scrub(e.message).slice(0, 200) : '';
                const detail = [code, text].filter(Boolean).join(': ');
                finish(
                  new HaWsCommandError(
                    `Home Assistant no aceptó la consulta${detail ? ` (${detail})` : ''}.`,
                    typeof e.code === 'string' ? e.code : null,
                  ),
                );
              }
            }
          }
        };
      });
    },
  };
}
