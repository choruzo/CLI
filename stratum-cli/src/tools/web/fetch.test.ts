import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { gzipSync } from 'node:zlib';
import { webFetchTool } from './fetch.js';
import {
  safeFetch,
  blockedAddressReason,
  isAllowedHost,
  BlockedHostError,
  TooManyRedirectsError,
} from './safe-fetch.js';
import type { ToolContext } from '../../agent/types.js';
import { StratumConfigSchema } from '../../config/schema.js';

// Servidores reales en 127.0.0.1: justo lo que web_fetch bloquea, así que los
// tests que necesitan llegar a ellos los declaran en `allowHosts` por puerto.

const servers: Server[] = [];

async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

function ctx(allowHosts: string[] = []): ToolContext {
  const config = StratumConfigSchema.parse({ tools: { webFetch: { allowHosts } } });
  return { signal: new AbortController().signal, cwd: process.cwd(), config };
}

describe('blockedAddressReason', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private network'],
    ['172.31.255.255', 'private network'],
    ['192.168.1.34', 'private network'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'unique local'],
    ['fe80::1%eth0', 'link-local'],
    ['ff02::1', 'multicast'],
  ])('%s → %s', (ip, reason) => {
    expect(blockedAddressReason(ip)).toBe(reason);
  });

  it.each([
    ['::ffff:127.0.0.1'],
    ['::ffff:7f00:1'],
    ['::ffff:a9fe:a9fe'],
    ['64:ff9b::a9fe:a9fe'],
    ['2002:c0a8:0101::1'],
    ['::127.0.0.1'],
  ])('una IPv4 privada envuelta en IPv6 (%s) también se bloquea', (ip) => {
    expect(blockedAddressReason(ip)).toMatch(/IPv4 embedded in IPv6/);
  });

  it.each([['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['2606:4700::1111'], ['::ffff:8.8.8.8']])(
    '%s es pública',
    (ip) => {
      expect(blockedAddressReason(ip)).toBeNull();
    },
  );
});

describe('isAllowedHost', () => {
  it('host, host:puerto y comodín de subdominio', () => {
    const allow = ['localhost:3000', '*.corp.example', '10.0.0.5', '[::1]:8080'];
    expect(isAllowedHost(new URL('http://localhost:3000/x'), allow)).toBe(true);
    expect(isAllowedHost(new URL('http://localhost:3001/x'), allow)).toBe(false);
    expect(isAllowedHost(new URL('https://wiki.corp.example/'), allow)).toBe(true);
    expect(isAllowedHost(new URL('https://corp.example/'), allow)).toBe(false);
    expect(isAllowedHost(new URL('http://10.0.0.5:9999/'), allow)).toBe(true);
    expect(isAllowedHost(new URL('http://[::1]:8080/'), allow)).toBe(true);
    expect(isAllowedHost(new URL('http://[::1]:8081/'), allow)).toBe(false);
  });
});

describe('safeFetch — SSRF', () => {
  it.each([
    ['http://127.0.0.1:1/'],
    ['http://localhost:1/'],
    ['http://app.localhost/'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[::1]/'],
    ['http://[::ffff:127.0.0.1]/'],
    // Notaciones alternativas que el parser WHATWG normaliza a 127.0.0.1.
    ['http://2130706433/'],
    ['http://0x7f.1/'],
    ['http://127.1/'],
  ])('%s se rechaza sin abrir conexión', async (url) => {
    await expect(safeFetch(url, { maxBytes: 1024 })).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('un nombre que resuelve a una IP privada se rechaza al conectar (DNS rebinding)', async () => {
    const port = await serve((_req, res) => res.end('secreto interno'));
    const lookup = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }])) as never;
    const err = await safeFetch(`http://rebind.example:${port}/`, { maxBytes: 1024, lookup }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BlockedHostError);
    expect((err as Error).message).toMatch(/rebind\.example resolves to 127\.0\.0\.1 \(loopback\)/);
  });

  it('se rechaza si cualquiera de las direcciones resueltas es privada', async () => {
    const lookup = ((_h: string, _o: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
      cb(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ])) as never;
    await expect(
      safeFetch('http://mixto.example/', { maxBytes: 1024, lookup }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('una redirección desde un host permitido hacia uno privado se rechaza', async () => {
    const target = await serve((_req, res) => res.end('metadatos'));
    const entry = await serve((_req, res) => {
      res.writeHead(302, { Location: `http://localhost:${target}/` });
      res.end();
    });
    await expect(
      safeFetch(`http://127.0.0.1:${entry}/`, {
        maxBytes: 1024,
        allowHosts: [`127.0.0.1:${entry}`],
      }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('sigue redirecciones relativas entre hosts permitidos y devuelve la URL final', async () => {
    const port = await serve((req, res) => {
      if (req.url === '/a') {
        res.writeHead(301, { Location: '/b' });
        res.end();
      } else {
        res.end('final');
      }
    });
    const res = await safeFetch(`http://127.0.0.1:${port}/a`, {
      maxBytes: 1024,
      allowHosts: [`127.0.0.1:${port}`],
    });
    expect(res.body).toBe('final');
    expect(res.url).toBe(`http://127.0.0.1:${port}/b`);
  });

  it('corta un bucle de redirecciones', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(302, { Location: '/otra-vez' });
      res.end();
    });
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1024, allowHosts: [`127.0.0.1:${port}`] }),
    ).rejects.toBeInstanceOf(TooManyRedirectsError);
  });

  it('rechaza protocolos que no son http/https, también en una redirección', async () => {
    await expect(safeFetch('file:///etc/passwd', { maxBytes: 1024 })).rejects.toThrow(
      /Unsupported protocol/,
    );
    const port = await serve((_req, res) => {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    });
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, { maxBytes: 1024, allowHosts: [`127.0.0.1:${port}`] }),
    ).rejects.toThrow(/Unsupported protocol/);
  });
});

describe('safeFetch — cuerpo', () => {
  it('descomprime gzip y el límite cuenta bytes descomprimidos', async () => {
    const big = 'a'.repeat(100_000);
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' });
      res.end(gzipSync(big));
    });
    const res = await safeFetch(`http://127.0.0.1:${port}/`, {
      maxBytes: 10_000,
      allowHosts: [`127.0.0.1:${port}`],
    });
    expect(res.body.length).toBe(10_000);
    expect(res.truncated).toBe(true);
  });
});

describe('web_fetch', () => {
  it('convierte HTML a texto limpio con cabecera de título', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>T</title></head><body><h2>Sec</h2><p>body text</p></body></html>',
      );
    });
    const result = await webFetchTool.execute(
      { url: `http://127.0.0.1:${port}/x` },
      ctx([`127.0.0.1:${port}`]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toContain('# T');
      expect(result.output).toContain('## Sec');
      expect(result.output).toContain('body text');
      expect(result.output).not.toContain('<p>');
    }
  });

  it('devuelve tal cual lo que no es HTML y manda Accept con markdown', async () => {
    let accept = '';
    const port = await serve((req, res) => {
      accept = String(req.headers.accept);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"a": 1}');
    });
    const result = await webFetchTool.execute(
      { url: `http://127.0.0.1:${port}/d` },
      ctx([`127.0.0.1:${port}`]),
    );
    expect(result).toMatchObject({ ok: true, output: '{"a": 1}' });
    expect(accept).toContain('text/markdown');
  });

  it('un 404 es un fallo recuperable', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(404, 'Not Found');
      res.end('nope');
    });
    const result = await webFetchTool.execute(
      { url: `http://127.0.0.1:${port}/missing` },
      ctx([`127.0.0.1:${port}`]),
    );
    expect(result).toMatchObject({ ok: false, recoverable: true });
    if (!result.ok) expect(result.error).toContain('404');
  });

  it('un host privado se rechaza sin consumir reintento y explicando cómo permitirlo', async () => {
    const result = await webFetchTool.execute(
      { url: 'http://169.254.169.254/latest/meta-data/' },
      ctx(),
    );
    expect(result).toMatchObject({ ok: false, recoverable: true, countsAsFailure: false });
    if (!result.ok) expect(result.error).toContain('tools.webFetch.allowHosts');
  });
});
