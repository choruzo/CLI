import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

/**
 * GET con protección SSRF para `web_fetch`.
 *
 * El `fetch` global no sirve aquí: sigue redirecciones sin preguntar y resuelve
 * el DNS por su cuenta, así que cualquier comprobación previa de la IP es
 * burlable con una redirección a `http://169.254.169.254/` o con DNS
 * rebinding (el nombre resuelve a una IP pública al comprobar y a `127.0.0.1`
 * al conectar). Por eso:
 *
 * - La IP se valida **en el `lookup` del socket**, es decir, la que de verdad
 *   se usa para conectar. No hay ventana entre comprobar y usar.
 * - Un host que ya es una IP literal no pasa por `lookup`: se valida antes.
 * - Las redirecciones se siguen a mano (máx. 5) y cada salto pasa otra vez por
 *   todo lo anterior.
 * - `allowHosts` (config `tools.webFetch.allowHosts`) exime hosts concretos —
 *   un servidor de desarrollo en `localhost:3000`, una wiki interna —: la
 *   excepción es explícita y por nombre, nunca un «permitir red privada».
 *
 * Sin dependencias: `node:http`/`node:https` y `zlib` para descomprimir (el
 * límite de tamaño cuenta bytes descomprimidos, así que una bomba gzip no pasa).
 */

export class BlockedHostError extends Error {
  override readonly name = 'BlockedHostError';
  constructor(
    readonly host: string,
    readonly address: string,
    readonly reason: string,
  ) {
    super(
      `blocked: ${host}${address !== host ? ` resolves to ${address}` : ''} (${reason}). ` +
        'web_fetch only reaches public addresses; add the host to tools.webFetch.allowHosts to allow it.',
    );
  }
}

export class TooManyRedirectsError extends Error {
  override readonly name = 'TooManyRedirectsError';
}

// ---------------------------------------------------------------------------
// Clasificación de direcciones
// ---------------------------------------------------------------------------

const V4_RANGES: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private network'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local / cloud metadata'],
  ['172.16.0.0', 12, 'private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private network'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const V6_RANGES: Array<[string, number, string]> = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['100::', 64, 'discard'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique local'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local'],
  ['ff00::', 8, 'multicast'],
];

const v4List = V4_RANGES.map(([net, prefix, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, 'ipv4');
  return { list, reason };
});
const v6List = V6_RANGES.map(([net, prefix, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, 'ipv6');
  return { list, reason };
});

/** Expande una IPv6 a sus 8 grupos de 16 bits (admite `::` y cola IPv4). */
function ipv6Groups(ip: string): number[] | null {
  let addr = ip.replace(/^\[|\]$/g, '').split('%')[0]!;
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Tail) {
    const parts = v4Tail[1]!.split('.').map(Number);
    addr =
      addr.slice(0, -v4Tail[1]!.length) +
      `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Motivo por el que `ip` no es alcanzable desde `web_fetch`, o `null` si es
 * una dirección pública. Una IPv6 que envuelve una IPv4 (mapeada `::ffff:`,
 * NAT64 `64:ff9b::`, 6to4 `2002:`, compatible `::a.b.c.d`) se juzga por la
 * IPv4 que lleva dentro: `[::ffff:127.0.0.1]` es loopback.
 */
export function blockedAddressReason(ip: string): string | null {
  const family = isIP(ip.replace(/^\[|\]$/g, '').split('%')[0]!);
  if (family === 4) {
    if (ip === '255.255.255.255') return 'broadcast';
    for (const { list, reason } of v4List) if (list.check(ip, 'ipv4')) return reason;
    return null;
  }
  if (family !== 6) return 'not an IP address';
  const g = ipv6Groups(ip);
  if (!g) return 'unparseable IPv6 address';
  const embedded =
    // ::ffff:a.b.c.d (mapeada) y ::a.b.c.d (compatible, obsoleta)
    g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)
      ? v4FromGroups(g[6]!, g[7]!)
      : // 64:ff9b::a.b.c.d (NAT64)
        g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)
        ? v4FromGroups(g[6]!, g[7]!)
        : // 2002:AABB:CCDD::/48 (6to4)
          g[0] === 0x2002
          ? v4FromGroups(g[1]!, g[2]!)
          : null;
  // `::` y `::1` también encajan en «compatible»: se juzgan como IPv6.
  const isUnspecOrLoop = g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1);
  if (embedded && !isUnspecOrLoop) {
    const inner = blockedAddressReason(embedded);
    return inner ? `${inner} (IPv4 embedded in IPv6)` : null;
  }
  const canonical = g.map((x) => x.toString(16)).join(':');
  for (const { list, reason } of v6List) if (list.check(canonical, 'ipv6')) return reason;
  return null;
}

// ---------------------------------------------------------------------------
// allowHosts
// ---------------------------------------------------------------------------

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * ¿Está `url` en la allowlist? Cada entrada es `host` o `host:puerto`, con
 * `*.` como comodín de subdominio (`*.corp.example` casa con `wiki.corp.example`,
 * no con `corp.example`). Sin puerto, casa con cualquiera.
 */
export function isAllowedHost(url: URL, allowHosts: readonly string[]): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = url.port || defaultPort(url.protocol);
  return allowHosts.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    // `[::1]:8080`, `[::1]`, `host:8080`, `host`
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry) ?? /^([^:]+)(?::(\d+))?$/.exec(entry);
    if (!m) return false;
    const [, pattern, entryPort] = m;
    if (entryPort && entryPort !== port) return false;
    if (pattern!.startsWith('*.')) return host.endsWith(pattern!.slice(1));
    return host === pattern;
  });
}

// ---------------------------------------------------------------------------
// Petición
// ---------------------------------------------------------------------------

export interface SafeFetchOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Bytes (descomprimidos) que se leen como mucho; el resto se descarta. */
  maxBytes: number;
  maxRedirects?: number;
  allowHosts?: readonly string[];
  /** Resolución DNS; inyectable para tests (DNS rebinding). */
  lookup?: typeof dnsLookup;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
  /** URL final tras las redirecciones. */
  url: string;
  body: string;
  truncated: boolean;
}

/** `lookup` que rechaza cualquier dirección bloqueada: la comprobación ocurre al conectar. */
function guardedLookup(host: string, resolve: typeof dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }
      const list = addresses as unknown as LookupAddress[];
      // Todas, no solo la primera: con `autoSelectFamily` Node prueba varias.
      for (const a of list) {
        const reason = blockedAddressReason(a.address);
        if (reason) {
          callback(new BlockedHostError(host, a.address, reason), '', 0);
          return;
        }
      }
      if (options.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      } else {
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
      }
    });
  };
}

function decode(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '')
    .toLowerCase()
    .trim();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  return res;
}

async function readLimited(
  stream: Readable,
  maxBytes: number,
): Promise<{ buf: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const b = chunk as Buffer;
    if (total + b.byteLength > maxBytes) {
      chunks.push(b.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(b);
    total += b.byteLength;
  }
  if (truncated) stream.destroy();
  return { buf: Buffer.concat(chunks, total), truncated };
}

function requestOnce(
  url: URL,
  opts: SafeFetchOptions,
  allowed: boolean,
): Promise<http.IncomingMessage> {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: { 'Accept-Encoding': 'gzip, deflate, br', ...opts.headers },
        signal: opts.signal,
        // Un host de la allowlist no se comprueba: la excepción es por nombre.
        lookup: allowed ? undefined : guardedLookup(url.hostname, opts.lookup ?? dnsLookup),
        // Sin agent compartido: un socket reutilizado del pool saltaría el lookup.
        agent: false,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/** Comprueba protocolo e IP literal antes de abrir el socket. */
function preCheck(url: URL, allowHosts: readonly string[]): boolean {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${url.protocol}" — only http/https.`);
  }
  if (isAllowedHost(url, allowHosts)) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const reason = blockedAddressReason(host);
    if (reason) throw new BlockedHostError(host, host, reason);
  } else if (host === 'localhost' || host.endsWith('.localhost')) {
    // RFC 6761: nunca sale de la máquina, aunque un resolver lo mande fuera.
    throw new BlockedHostError(host, host, 'loopback');
  }
  return false;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(input: string, opts: SafeFetchOptions): Promise<SafeFetchResponse> {
  const allowHosts = opts.allowHosts ?? [];
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = new URL(input);

  for (let hop = 0; ; hop++) {
    const allowed = preCheck(url, allowHosts);
    const res = await requestOnce(url, opts, allowed);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (REDIRECT_STATUS.has(status) && location) {
      res.resume();
      if (hop >= maxRedirects) {
        throw new TooManyRedirectsError(
          `too many redirects (>${maxRedirects}) starting at ${input}`,
        );
      }
      url = new URL(location, url);
      continue;
    }

    const { buf, truncated } = await readLimited(decode(res), opts.maxBytes);
    return {
      status,
      statusText: res.statusMessage ?? '',
      headers: res.headers,
      url: url.toString(),
      body: new TextDecoder('utf-8').decode(buf),
      truncated,
    };
  }
}
