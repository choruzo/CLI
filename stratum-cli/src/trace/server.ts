import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes } from 'crypto';
import type { AddressInfo } from 'net';
import { VIEWER_PAGE } from './viewer-page.js';
import { FileTail } from './tail.js';

/**
 * Servidor efímero del visor de trayectoria (`/auditor`, `stratum auditor`).
 * Solo lee el JSONL de la traza y lo retransmite por SSE según crece: no tiene
 * ninguna ruta que escriba ni que hable con el agente.
 *
 * La traza lleva prompts y salidas de tools, así que escucha solo en loopback,
 * exige un token aleatorio en la ruta y comprueba la cabecera `Host` (sin eso,
 * una página cualquiera podría leerla con DNS rebinding).
 */

export interface AuditorServerOptions {
  file: string;
  sessionId: string;
  /** Puerto fijo; por defecto, uno libre que elige el sistema. */
  port?: number;
  /** Cada cuánto se mira si el fichero creció. */
  pollMs?: number;
}

export interface AuditorServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 15_000;
export async function startAuditorServer(opts: AuditorServerOptions): Promise<AuditorServer> {
  const token = randomBytes(16).toString('hex');
  const pollMs = opts.pollMs ?? 250;
  const base = `/${token}`;
  const streams = new Set<{ res: ServerResponse; stop: () => void }>();
  let port = 0;

  const hostAllowed = (req: IncomingMessage): boolean => {
    const host = req.headers.host;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };

  const serveEvents = (res: ServerResponse): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Sin un primer byte las cabeceras no salen, y el visor de una sesión aún
    // sin turnos se quedaría «conectando».
    res.write(': connected\n\n');
    const tail = new FileTail(
      opts.file,
      (line) => res.write(`data: ${line}\n\n`),
      () => res.write('event: reset\ndata: {}\n\n'),
    );
    const poll = setInterval(() => void tail.poll(), pollMs);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
    const entry = {
      res,
      stop: (): void => {
        clearInterval(poll);
        clearInterval(beat);
        streams.delete(entry);
      },
    };
    streams.add(entry);
    res.on('close', entry.stop);
    void tail.poll();
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || !hostAllowed(req) || !path.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const route = path.slice(base.length);
    if (route === '' || route === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "connect-src 'self'; base-uri 'none'; form-action 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(VIEWER_PAGE.replace('__SESSION_ID__', opts.sessionId));
      return;
    }
    if (route === '/events') {
      serveEvents(res);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  // El visor nunca mantiene vivo el proceso: quien quiera esperar, espera él.
  server.unref();

  return {
    url: `http://127.0.0.1:${port}${base}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of [...streams]) {
          s.stop();
          s.res.end();
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
