import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locateBrowser } from './locate.js';
import { BrowserManager } from './manager.js';

/**
 * Contra el Edge/Chrome/Chromium instalado de verdad. Sin navegador en la
 * máquina se salta (CI sin navegador): el resto de los tests usa uno falso.
 */
const executable = locateBrowser({});

const PAGE = `<!doctype html><title>App de prueba</title>
<h1>Mi app</h1><p>Hola desde el servidor local.</p>
<label>Email <input id="email"></label>
<button onclick="console.error('guardado ' + document.getElementById('email').value); document.title = 'Guardado'">Guardar</button>
<a href="/otra">Otra</a>
<a href="https://example.com/">Fuera</a>
<script>console.log('app lista'); fetch('/no-existe');</script>`;

let server: Server;
let base = '';
let cwd = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else if (req.url === '/otra') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Otra</title><h1>Segunda</h1>');
    } else if (req.url === '/fuera') {
      res.writeHead(302, { location: 'https://example.com/' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cwd = mkdtempSync(join(tmpdir(), 'stratum-browser-cwd-real-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

// En el runner de Linux de CI (Ubuntu 26.04) Chrome se cierra nada más arrancar;
// probablemente AppArmor restringe los user namespaces que necesita su sandbox. No se
// arregla con --no-sandbox (decisión de seguridad pendiente): ver .claude/docs/browser.md.
const ciLinux = process.env.CI === 'true' && process.platform === 'linux';

describe.skipIf(!executable || ciLinux)('navegador real', () => {
  it('navigate → snapshot → type → click → console, y lo externo bloqueado en la red', async () => {
    const manager = new BrowserManager({ executable: executable!, cwd });
    try {
      const info = await manager.navigate(`${base}/`);
      expect(info).toMatchObject({ title: 'App de prueba', status: 200, timedOut: false });

      const snap = await manager.snapshot();
      expect(snap.text).toContain('# Mi app');
      expect(snap.text).toContain('Hola desde el servidor local.');
      const email = /\[(e\d+)\] textbox "Email"/.exec(snap.text)?.[1];
      const save = /\[(e\d+)\] button "Guardar"/.exec(snap.text)?.[1];
      const outside = /\[(e\d+)\] link "Fuera"/.exec(snap.text)?.[1];
      expect(email && save && outside).toBeTruthy();

      await manager.type(email!, 'ana@example.com', false);
      const after = await manager.click(save!);
      expect(after.title).toBe('Guardado');

      const console = manager.takeConsole();
      expect(console).toContain('log: app lista');
      expect(console).toContain('error: guardado ana@example.com');
      expect(console.some((l) => l.includes('/no-existe') && l.includes('404'))).toBe(true);

      // Un clic a otro origen no se salta la confirmación…
      await manager.click(outside!);
      expect(manager.takeBlockedNavigations()).toEqual([
        'navigation to https://example.com blocked: call browser_navigate to request it',
      ]);
      // …ni una redirección del servidor local.
      const redirected = await manager.navigate(`${base}/fuera`);
      expect(redirected.error).toMatch(/BLOCKED_BY_CLIENT/);

      const screen = await manager.screen(512 * 1024);
      expect(screen?.width).toBeGreaterThan(100);
    } finally {
      await manager.dispose();
    }
    expect(manager.state).toBe('dead');
  }, 60_000);
});
