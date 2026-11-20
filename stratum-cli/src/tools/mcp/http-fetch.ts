/**
 * `fetch` del transporte Streamable HTTP de MCP (M22 parte 3).
 *
 * Solo lo usan los servers con `url` de `companion.mcp.servers` (config
 * global). El SDK de MCP hace todas sus peticiones (POST de mensajes, GET del
 * stream SSE, DELETE de la sesión) por esta función, así que aquí se aplica la
 * política entera, sin depender de cómo las arme el SDK:
 *
 * - **Un solo origen**: el de la `url` declarada. Cualquier petición a otro
 *   (un endpoint que anuncie el server, un descubrimiento OAuth) se rechaza.
 * - **Sin redirecciones**: un 3xx es un error, nunca se sigue, ni al mismo
 *   origen. La cabecera de autenticación no puede acabar en otra parte.
 * - **IP comprobada al conectar** (`lookup` del socket, como `web_fetch`): sin
 *   ventana para DNS rebinding. Lo público se alcanza por `https`; lo local
 *   (loopback, LAN, CGNAT, IPv6 de sitio único) solo con `allowPrivate`, y
 *   entonces también por `http`; lo vetado (link-local y metadatos, multicast,
 *   reservado) nunca. Un `http` que resuelve a una IP pública se rechaza: la
 *   cabecera viajaría en claro por internet.
 * - **Tope por respuesta** (16 MB): un server que no para de mandar no llena la
 *   memoria del daemon.
 * - La cabecera de autenticación la pone esta función, no el SDK, y nunca
 *   aparece en un mensaje de error.
 *
 * Sin dependencias: `node:http`/`node:https`. El `fetch` global no sirve: sigue
 * redirecciones y resuelve el DNS por su cuenta.
 */

import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Readable, Transform, pipeline } from 'node:stream';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { addressScope, blockedAddressReason } from '../web/safe-fetch.js';

/** Tope de bytes de una respuesta (JSON o stream SSE entero). */
export const MCP_HTTP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class McpHttpBlockedError extends Error {
  override readonly name = 'McpHttpBlockedError';
}

export interface McpHttpPolicy {
  /** La `url` declarada del server: fija el origen. */
  url: URL;
  /** El server declara que vive en la red local (`allowPrivate`). */
  allowPrivate: boolean;
  /** Cabecera de autenticación ya resuelta del entorno, si la hay. */
  authHeader?: { name: string; value: string };
  maxResponseBytes?: number;
  /** Resolución DNS; inyectable para tests (DNS rebinding). */
  lookup?: typeof dnsLookup;
}

/**
 * Por qué no se puede conectar a `ip` con esta política, o `null` si se puede.
 * `mustBeLocal`: el nombre es `localhost` (RFC 6761: nunca sale de la máquina).
 */
export function mcpAddressProblem(
  ip: string,
  protocol: string,
  allowPrivate: boolean,
  mustBeLocal = false,
): string | null {
  const scope = addressScope(ip);
  if (scope === 'forbidden') return blockedAddressReason(ip) ?? 'forbidden address';
  if (scope === 'local') {
    return allowPrivate ? null : 'local address; declare "allowPrivate": true to reach it';
  }
  if (mustBeLocal) return 'localhost resolved to a public address';
  if (protocol === 'http:') return 'plain http only reaches a local address; use https';
  return null;
}

function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

function guardedLookup(
  host: string,
  protocol: string,
  allowPrivate: boolean,
  resolve: typeof dnsLookup,
): LookupFunction {
  const mustBeLocal = isLocalhostName(host);
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const list = addresses as unknown as LookupAddress[];
      // Todas: con `autoSelectFamily` Node prueba varias.
      for (const a of list) {
        const problem = mcpAddressProblem(a.address, protocol, allowPrivate, mustBeLocal);
        if (problem) {
          callback(
            new McpHttpBlockedError(`blocked: ${host} resolves to ${a.address} (${problem})`),
            '',
            0,
          );
          return;
        }
      }
      if (options.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
        return;
      }
      const first = list[0];
      if (!first) {
        callback(
          Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }),
          '',
          0,
        );
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

function byteLimit(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.byteLength;
      if (total > max) cb(new McpHttpBlockedError(`response larger than ${max} bytes`));
      else cb(null, chunk);
    },
  });
}

function bodyOf(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new McpHttpBlockedError('unsupported request body');
}

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/** Comprueba el origen y, si el host es una IP literal, la IP (no pasa por `lookup`). */
function preCheck(url: URL, policy: McpHttpPolicy): void {
  if (url.origin !== policy.url.origin) {
    throw new McpHttpBlockedError(
      `request to another origin refused (${url.origin}); this server only reaches ${policy.url.origin}`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const problem = mcpAddressProblem(host, url.protocol, policy.allowPrivate);
    if (problem) throw new McpHttpBlockedError(`blocked: ${host} (${problem})`);
  } else if (isLocalhostName(host) && !policy.allowPrivate) {
    throw new McpHttpBlockedError(
      `blocked: ${host} (local address; declare "allowPrivate": true to reach it)`,
    );
  }
}

export function createMcpHttpFetch(policy: McpHttpPolicy): FetchLike {
  const maxBytes = policy.maxResponseBytes ?? MCP_HTTP_MAX_RESPONSE_BYTES;
  return async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : String(input));
    preCheck(url, policy);

    const headers = new Headers(init.headers);
    // Sin compresión: el tope cuenta lo que llega y no hay que descomprimir.
    headers.delete('accept-encoding');
    if (policy.authHeader) headers.set(policy.authHeader.name, policy.authHeader.value);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = bodyOf(init.body);
    const mod = url.protocol === 'https:' ? https : http;

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          ...(init.signal ? { signal: init.signal } : {}),
          lookup: guardedLookup(
            url.hostname,
            url.protocol,
            policy.allowPrivate,
            policy.lookup ?? dnsLookup,
          ),
          // Sin pool compartido: un socket reutilizado saltaría el `lookup`.
          agent: false,
        },
        resolve,
      );
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      res.resume();
      throw new McpHttpBlockedError(
        `redirect refused (HTTP ${status}): MCP over HTTP never follows redirects`,
      );
    }

    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) responseHeaders.append(name, v);
      else responseHeaders.set(name, String(value));
    }
    const statusText = res.statusMessage ?? '';
    if (NULL_BODY_STATUS.has(status) || method === 'HEAD') {
      res.resume();
      return new Response(null, { status, statusText, headers: responseHeaders });
    }
    // `pipeline` propaga el error de cualquiera de los dos (abortar, tope).
    const limited = pipeline(res, byteLimit(maxBytes), () => {});
    return new Response(Readable.toWeb(limited) as unknown as ReadableStream<Uint8Array>, {
      status,
      statusText,
      headers: responseHeaders,
    });
  };
}
