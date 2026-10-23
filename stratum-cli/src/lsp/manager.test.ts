import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LspManager } from './manager.js';
import { languageIdFor } from './client.js';
import { resolveLspServers } from './presets.js';
import { formatDiagnostics } from './format.js';
import type { ResolvedLspServer } from './presets.js';

/** Servidor LSP de verdad (un proceso Node), no un mock del protocolo. */
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-lsp-server.mjs', import.meta.url));

const managers: LspManager[] = [];
const dirs: string[] = [];

function makeServer(overrides: Partial<ResolvedLspServer> = {}): ResolvedLspServer {
  return {
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    extensions: ['.ts'],
    env: {},
    ...overrides,
  };
}

function makeManager(servers: ResolvedLspServer[], options: { timeoutMs?: number } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'stratum-lsp-'));
  dirs.push(cwd);
  const manager = new LspManager({
    servers,
    cwd,
    timeoutMs: options.timeoutMs ?? 5000,
    startupTimeoutMs: 5000,
  });
  managers.push(manager);
  return { manager, cwd };
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  what = 'condición',
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout esperando ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.dispose()));
  managers.length = 0;
  for (const dir of dirs) {
    // En Windows el proceso recién matado puede seguir sujetando el cwd.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* se queda en el temporal */
    }
  }
  dirs.length = 0;
});

describe('LspManager', () => {
  it('devuelve un diagnóstico de error por cada línea con ERROR', async () => {
    const { manager, cwd } = makeManager([makeServer()]);
    const file = join(cwd, 'a.ts');
    const report = await manager.diagnose(file, 'const a = 1;\nconst b = ERROR;\n');

    expect(report).not.toBeNull();
    expect(report!.server).toBe('fake');
    expect(report!.uri.endsWith('/a.ts') || report!.uri.endsWith('\\a.ts')).toBe(true);
    expect(report!.version).toBe(1);
    expect(report!.diagnostics).toHaveLength(1);
    expect(report!.diagnostics[0]).toMatchObject({ message: 'bad line', severity: 1 });
    expect(report!.diagnostics[0]!.range.start).toEqual({ line: 1, character: 10 });

    // El informe se formatea sin ceremonia: 2:11 en 1-based.
    expect(
      formatDiagnostics(report!, { maxDiagnostics: 20, severity: 'error', displayPath: 'a.ts' }),
    ).toBe(['Diagnostics (fake) for a.ts — 1 error:', '  2:11  error  FAKE1  bad line'].join('\n'));
  });

  it('un fichero limpio devuelve un informe sin diagnósticos (no null)', async () => {
    const { manager, cwd } = makeManager([makeServer()]);
    const report = await manager.diagnose(join(cwd, 'clean.ts'), 'const a = 1;\n');
    expect(report).not.toBeNull();
    expect(report!.diagnostics).toEqual([]);
  });

  it('un didChange posterior actualiza los diagnósticos', async () => {
    const { manager, cwd } = makeManager([makeServer()]);
    const file = join(cwd, 'a.ts');

    const first = await manager.diagnose(file, 'const a = 1;\n');
    expect(first!.diagnostics).toEqual([]);

    const second = await manager.diagnose(file, 'const a = 1;\nERROR aquí\n');
    expect(second!.diagnostics).toHaveLength(1);
    expect(second!.diagnostics[0]!.range.start.line).toBe(1);
    // El documento ya estaba abierto: fue un didChange, versión 2.
    expect(second!.version).toBe(2);
  });

  it('un servidor que no existe devuelve null y queda desactivado, sin lanzar', async () => {
    const { manager, cwd } = makeManager([
      makeServer({ command: 'stratum-no-existe-lsp-de-verdad' }),
    ]);
    const file = join(cwd, 'a.ts');

    await expect(manager.diagnose(file, 'ERROR\n')).resolves.toBeNull();

    const started = Date.now();
    await expect(manager.diagnose(file, 'ERROR\n')).resolves.toBeNull();
    // Desactivado: el segundo intento no vuelve a arrancar nada.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('una extensión sin servidor no arranca nada y devuelve null', async () => {
    const { manager, cwd } = makeManager([makeServer()]);
    await expect(manager.diagnose(join(cwd, 'nota.md'), 'ERROR\n')).resolves.toBeNull();
    expect(manager.serverFor(join(cwd, 'nota.md'))).toBeNull();
    expect(manager.serverFor(join(cwd, 'a.ts'))).not.toBeNull();
  });

  it('si el servidor no publica, vence el timeout y devuelve null', async () => {
    const { manager, cwd } = makeManager([makeServer({ env: { FAKE_LSP_SILENT: '1' } })], {
      timeoutMs: 300,
    });
    const started = Date.now();
    await expect(manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n')).resolves.toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('respeta un AbortSignal ya abortado sin arrancar el servidor', async () => {
    const { manager, cwd } = makeManager([makeServer()]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n', controller.signal),
    ).resolves.toBeNull();
  });

  it('dispose cierra el proceso del servidor', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stratum-lsp-'));
    dirs.push(cwd);
    const pidPath = join(cwd, 'pid.txt');
    const manager = new LspManager({
      servers: [makeServer({ env: { FAKE_LSP_PID_FILE: pidPath } })],
      cwd,
      timeoutMs: 5000,
      startupTimeoutMs: 5000,
    });
    managers.push(manager);

    const report = await manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n');
    expect(report).not.toBeNull();

    await waitUntil(() => existsSync(pidPath), 4000, 'el pid del servidor');
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);

    await manager.dispose();

    await waitUntil(() => !alive(pid), 4000, 'que el servidor muera');
    expect(alive(pid)).toBe(false);
  });

  it('un abort durante el arranque devuelve null enseguida, sin esperar al initialize', async () => {
    const { manager, cwd } = makeManager([
      makeServer({ env: { FAKE_LSP_STARTUP_DELAY_MS: '4000' } }),
    ]);
    const controller = new AbortController();
    const started = Date.now();
    const promise = manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n', controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(promise).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('dispose durante un arranque en vuelo no deja el servidor huérfano', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stratum-lsp-'));
    dirs.push(cwd);
    const pidPath = join(cwd, 'pid.txt');
    const manager = new LspManager({
      // `initialize` tarda: cuando llega `dispose`, el arranque está en vuelo.
      servers: [
        makeServer({ env: { FAKE_LSP_PID_FILE: pidPath, FAKE_LSP_STARTUP_DELAY_MS: '4000' } }),
      ],
      cwd,
      timeoutMs: 5000,
      startupTimeoutMs: 5000,
    });
    managers.push(manager);

    const running = manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n');
    // El proceso ya existe (execa lo crea antes de esperar al `initialize`).
    await waitUntil(() => existsSync(pidPath), 4000, 'el pid del servidor');
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(alive(pid)).toBe(true);

    await manager.dispose();
    await expect(running).resolves.toBeNull();

    await waitUntil(() => !alive(pid), 4000, 'que el servidor a medio arrancar muera');
    expect(alive(pid)).toBe(false);
  });

  it('un transporte roto (basura sin framing) mata el servidor y lo desactiva', async () => {
    const { manager, cwd } = makeManager([makeServer({ env: { FAKE_LSP_GARBAGE: '1' } })]);
    const file = join(cwd, 'a.ts');
    await expect(manager.diagnose(file, 'ERROR\n')).resolves.toBeNull();

    // Desactivado: la segunda llamada no vuelve a arrancar nada.
    const started = Date.now();
    await expect(manager.diagnose(file, 'ERROR\n')).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('descarta los diagnósticos con forma inválida', async () => {
    const { manager, cwd } = makeManager([makeServer({ env: { FAKE_LSP_BAD_DIAGNOSTICS: '1' } })]);
    const report = await manager.diagnose(join(cwd, 'a.ts'), 'const b = ERROR;\n');
    expect(report).not.toBeNull();
    // El fixture manda cuatro: solo una tiene range numérico y message.
    expect(report!.diagnostics).toHaveLength(1);
    expect(report!.diagnostics[0]).toMatchObject({ message: 'bad line' });
  });

  it('dispose es idempotente y deja el manager inservible en silencio', async () => {
    const { manager, cwd } = makeManager([makeServer()]);
    await manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n');
    await manager.dispose();
    await expect(manager.dispose()).resolves.toBeUndefined();
    await expect(manager.diagnose(join(cwd, 'a.ts'), 'ERROR\n')).resolves.toBeNull();
  });

  it('los servidores salen de resolveLspServers, un preset por nombre', () => {
    const servers = resolveLspServers({ typescript: {}, pyright: {} });
    const { manager } = makeManager(servers);
    expect(manager.serverNames).toEqual(['typescript', 'pyright']);
    expect(manager.serverFor('/p/a.tsx')!.name).toBe('typescript');
    expect(manager.serverFor('/p/a.py')!.name).toBe('pyright');
    expect(manager.serverFor('/p/a.rb')).toBeNull();
  });
});

describe('languageIdFor', () => {
  it('deriva el languageId de la extensión', () => {
    expect(languageIdFor('/p/a.ts')).toBe('typescript');
    expect(languageIdFor('/p/a.tsx')).toBe('typescriptreact');
    expect(languageIdFor('/p/a.mts')).toBe('typescript');
    expect(languageIdFor('/p/a.jsx')).toBe('javascriptreact');
    expect(languageIdFor('/p/a.py')).toBe('python');
    expect(languageIdFor('/p/a.rs')).toBe('rust');
    expect(languageIdFor('C:\\p\\a.TS')).toBe('typescript');
    expect(languageIdFor('/p/Makefile')).toBe('plaintext');
  });
});
