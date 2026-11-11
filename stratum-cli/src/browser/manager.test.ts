import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { liveBrowsers } from './cdp.js';
import {
  BrowserActionError,
  BrowserManager,
  BrowserUnavailableError,
  jpegSize,
  type BrowserManagerOptions,
} from './manager.js';

/** Un navegador de verdad no: un proceso Node que habla CDP por los fd 3 y 4. */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-browser.mjs', import.meta.url));

const managers: BrowserManager[] = [];
const dirs: string[] = [];
const envKeys: string[] = [];

function setEnv(key: string, value: string): void {
  envKeys.push(key);
  process.env[key] = value;
}

function makeManager(options: Partial<BrowserManagerOptions> = {}): BrowserManager {
  const cwd = mkdtempSync(join(tmpdir(), 'stratum-browser-cwd-'));
  dirs.push(cwd);
  const manager = new BrowserManager({
    executable: process.execPath,
    argsPrefix: [FIXTURE],
    cwd,
    timeouts: { settleMs: 5, closeMs: 1000 },
    ...options,
  });
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
  for (const key of envKeys.splice(0)) delete process.env[key];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 8000,
  what = 'condición',
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function profiles(): string[] {
  return readdirSync(tmpdir()).filter(
    (n) => n.startsWith('stratum-browser-') && !n.startsWith('stratum-browser-cwd-'),
  );
}

// Cada test lanza un proceso Node que hace de navegador: con la suite completa cargada,
// arrancarlo pasa de los 5 s por defecto.
describe('BrowserManager', { timeout: 30_000 }, () => {
  it('arranca perezosamente: nada hasta la primera acción', async () => {
    const before = liveBrowsers();
    const manager = makeManager();
    expect(manager.state).toBe('closed');
    expect(await manager.status()).toEqual({ state: 'closed' });
    expect(await manager.screen(512 * 1024)).toBeNull();
    expect(liveBrowsers()).toBe(before);
    const info = await manager.navigate('http://localhost:3000/');
    expect(info).toMatchObject({
      url: 'http://localhost:3000/',
      title: 'Fake page',
      status: 200,
      timedOut: false,
    });
    expect(manager.state).toBe('open');
    expect(liveBrowsers()).toBe(before + 1);
    const status = await manager.status();
    expect(status).toMatchObject({
      state: 'open',
      url: 'http://localhost:3000/',
      canGoBack: false,
    });
  });

  it('navigate rechaza lo externo sin aprobar y lo vetado siempre', async () => {
    const manager = makeManager();
    await expect(manager.navigate('https://example.com/')).rejects.toBeInstanceOf(
      BrowserActionError,
    );
    await expect(manager.navigate('http://169.254.169.254/')).rejects.toThrow(/cannot be opened/);
    // No arrancó nada por intentarlo.
    expect(manager.state).toBe('closed');
  });

  it('en la red: una navegación de la página a otro origen se bloquea, y pasa tras aprobarlo', async () => {
    const manager = makeManager();
    await manager.navigate('http://localhost:3000/');
    const blocked = JSON.parse(await manager.evaluate('__nav:https://example.com/')) as {
      continued: boolean;
    };
    expect(blocked.continued).toBe(false);
    expect(manager.takeBlockedNavigations()).toEqual([
      'navigation to https://example.com blocked: call browser_navigate to request it',
    ]);
    const vetoed = JSON.parse(await manager.evaluate('__nav:http://169.254.169.254/')) as {
      continued: boolean;
    };
    expect(vetoed.continued).toBe(false);
    expect(manager.takeBlockedNavigations()).toEqual([
      'navigation to http://169.254.169.254/ blocked: 169.254.169.254 is link-local / cloud metadata',
    ]);

    manager.approveOrigin('https://example.com');
    const allowed = JSON.parse(await manager.evaluate('__nav:https://example.com/docs')) as {
      continued: boolean;
    };
    expect(allowed.continued).toBe(true);
    expect(manager.takeBlockedNavigations()).toEqual([]);
    await expect(manager.navigate('https://example.com/other')).resolves.toMatchObject({
      status: 200,
    });
  });

  it('subrecursos: la red privada solo desde un documento local, y manda el que quedó cargado', async () => {
    const manager = makeManager();
    const sub = async (url: string) =>
      (JSON.parse(await manager.evaluate(`__sub:${url}`)) as { continued: boolean }).continued;
    const PRIVATE = 'http://192.168.1.10/api';

    await manager.navigate('http://localhost:3000/');
    expect(await sub(PRIVATE)).toBe(true);
    expect(await sub('https://cdn.example.org/lib.js')).toBe(true);
    // Lo vetado, ni desde lo local.
    expect(await sub('http://169.254.169.254/latest/meta-data')).toBe(false);

    manager.approveOrigin('https://example.com');
    await manager.navigate('https://example.com/');
    expect(await sub(PRIVATE)).toBe(false);
    expect(await sub('http://localhost:3000/admin')).toBe(false);
    expect(await sub('https://cdn.example.org/lib.js')).toBe(true);

    // Vuelve la página de internet desde la caché, sin petición que interceptar:
    // sigue sin poder pedir a la red privada.
    await manager.navigate('http://localhost:3000/');
    expect(await sub(PRIVATE)).toBe(true);
    await manager.evaluate('__restore:https://example.com/');
    expect(await sub(PRIVATE)).toBe(false);
    expect(manager.takeConsole().some((l) => l.includes('request blocked by Stratum'))).toBe(true);
  });

  it('snapshot, click y type con referencias; una referencia vieja es un error claro', async () => {
    const manager = makeManager();
    const snap = await manager.snapshot();
    expect(snap.text).toContain('[e1] button "OK"');
    await expect(manager.click('e1')).resolves.toMatchObject({ title: 'Fake page' });
    await expect(manager.type('e2', 'hola', true)).resolves.toMatchObject({ title: 'Fake page' });
    await expect(manager.click('e9')).rejects.toThrow(/browser_snapshot/);
    await expect(manager.click('button')).rejects.toThrow(/not an element reference/);
    await expect(manager.press('ctrl+a Backspace')).resolves.toBeDefined();
    await expect(manager.press('rm -rf')).rejects.toThrow(/not a key sequence/);
  });

  it('eval devuelve el valor y cuenta la excepción', async () => {
    const manager = makeManager();
    expect(await manager.evaluate('6*7')).toBe('42');
    await expect(manager.evaluate('throw')).rejects.toThrow(/Error: nope/);
  });

  it('la pantalla para un cliente es un JPEG con su tamaño', async () => {
    const manager = makeManager();
    await manager.snapshot();
    const shot = await manager.screen(512 * 1024);
    expect(shot).toMatchObject({ width: 32, height: 16 });
    expect(jpegSize(Buffer.from(shot!.data, 'base64'))).toEqual({ width: 32, height: 16 });
    await expect(manager.screen(4)).rejects.toThrow(/size limit/);
  });

  it('una orden sin respuesta caduca y no cuelga', async () => {
    setEnv('FAKE_BROWSER_SILENT', 'Page.captureScreenshot');
    // El plazo vale también para las órdenes del arranque: corto, pero no tanto
    // que un proceso lento en arrancar (suite cargada) no llegue a contestarlas.
    const manager = makeManager({ commandTimeoutMs: 1500 });
    await manager.snapshot();
    await expect(manager.screenshotPng()).rejects.toThrow(/did not answer/);
    // El navegador sigue vivo para lo demás.
    await expect(manager.snapshot()).resolves.toBeDefined();
  });

  it('un mensaje por encima del tope deja el navegador muerto para la sesión', async () => {
    setEnv('FAKE_BROWSER_HUGE', '1');
    const manager = makeManager({ maxMessageBytes: 8 * 1024 });
    await expect(manager.snapshot()).rejects.toBeInstanceOf(BrowserUnavailableError);
    expect(manager.state).toBe('dead');
    await expect(manager.navigate('http://localhost/')).rejects.toThrow(
      /not available in this session/,
    );
    expect(await manager.status()).toEqual({ state: 'unavailable', reason: 'failed' });
  });

  it('si el navegador se cae, la siguiente acción es un error legible (no lanza otra cosa)', async () => {
    setEnv('FAKE_BROWSER_EXIT_AFTER_SETUP', '1');
    const manager = makeManager();
    await manager.snapshot().catch(() => undefined);
    await waitUntil(() => manager.state === 'dead', 8000, 'la caída');
    const err = await manager.snapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUnavailableError);
    expect((err as Error).message).toMatch(/not available/);
  });

  it('dispose no deja procesos huérfanos ni el perfil', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'stratum-browser-cwd-pids-'));
    dirs.push(pidDir);
    const pidFile = join(pidDir, 'pids');
    setEnv('FAKE_BROWSER_PID_FILE', pidFile);
    const before = new Set(profiles());
    const manager = makeManager();
    await manager.snapshot();
    await waitUntil(() => existsSync(pidFile), 5000, 'el pid');
    const [pid, grandchild] = readFileSync(pidFile, 'utf8').split(' ').map(Number) as [
      number,
      number,
    ];
    expect(alive(pid)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    const created = profiles().filter((p) => !before.has(p));
    expect(created).toHaveLength(1);
    await manager.dispose();
    await waitUntil(() => !alive(pid) && !alive(grandchild), 10_000, 'que mueran');
    expect(existsSync(join(tmpdir(), created[0]!))).toBe(false);
    expect(manager.state).toBe('dead');
    await expect(manager.snapshot()).rejects.toBeInstanceOf(BrowserUnavailableError);
  }, 30_000);

  it('dispose mata también a uno que no atiende Browser.close', async () => {
    const pidDir = mkdtempSync(join(tmpdir(), 'stratum-browser-cwd-pids-'));
    dirs.push(pidDir);
    const pidFile = join(pidDir, 'pids');
    setEnv('FAKE_BROWSER_PID_FILE', pidFile);
    setEnv('FAKE_BROWSER_IGNORE_CLOSE', '1');
    const manager = makeManager();
    await manager.snapshot();
    await waitUntil(() => existsSync(pidFile), 5000, 'el pid');
    const [pid, grandchild] = readFileSync(pidFile, 'utf8').split(' ').map(Number) as [
      number,
      number,
    ];
    await manager.dispose();
    await waitUntil(() => !alive(pid) && !alive(grandchild), 10_000, 'que mueran');
  }, 30_000);

  it('se cierra por inactividad y vuelve a abrirse al usarlo', async () => {
    const manager = makeManager({ idleMinutes: 0.002 });
    await manager.snapshot();
    expect(manager.state).toBe('open');
    await waitUntil(() => manager.state === 'closed', 8000, 'el cierre por inactividad');
    await expect(manager.snapshot()).resolves.toBeDefined();
    expect(manager.state).toBe('open');
  });

  it('la consola está acotada y se vacía al leerla', async () => {
    const manager = makeManager();
    await manager.navigate('http://localhost:3000/');
    await manager.evaluate('__nav:https://example.com/');
    const first = manager.takeConsole();
    expect(Array.isArray(first)).toBe(true);
    expect(manager.takeConsole()).toEqual([]);
  });
});
