import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { McpServer } from '../../config/schema.js';
import {
  MARKER_FILE,
  installServer,
  installState,
  isServerInstalled,
  resetInstallerStateForTests,
  resolveServerCommand,
  serverInstallPath,
} from './installer.js';

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `stratum-mcpinst-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  resetInstallerStateForTests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function server(pkg: string, name = 'fs'): McpServer {
  return { name, package: pkg, args: ['--x'], startupTimeout: 15000 } as McpServer;
}

/** Deja en `prefix` lo que dejaría `npm install <spec>`: paquete con bin. */
function writePackage(prefix: string, spec: string): void {
  const name = spec.replace(/@[^@/]*$/, '');
  const dir = join(prefix, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, bin: 'cli.js' }));
  writeFileSync(join(dir, 'cli.js'), `// ${spec}\n`);
}

function fakeNpm(calls: string[] = []) {
  return async (spec: string, prefix: string): Promise<void> => {
    calls.push(spec);
    writePackage(prefix, spec);
  };
}

/** Un npm que se corta a mitad: el paquete extraído, sus dependencias no. */
async function interruptedNpm(spec: string, prefix: string): Promise<void> {
  writePackage(prefix, spec);
  throw new Error('killed by SIGINT');
}

const leftovers = () =>
  readdirSync(root).filter((n) => n.startsWith('.staging-') || n.startsWith('.trash-'));

describe('instalación transaccional de MCP servers', () => {
  it('instala con marcador, sin restos, y lanza node <entry>', async () => {
    const cfg = server('srv@1.0.0');
    const cmd = await resolveServerCommand(
      cfg,
      { installDir: root, autoInstall: true },
      undefined,
      { runNpm: fakeNpm() },
    );
    expect(cmd.command).toBe('node');
    expect(cmd.args[0]).toBe(join(serverInstallPath(root, 'fs'), 'node_modules', 'srv', 'cli.js'));
    expect(cmd.args[1]).toBe('--x');
    expect(isServerInstalled(cfg, root)).toBe(true);
    const marker = JSON.parse(
      readFileSync(join(serverInstallPath(root, 'fs'), MARKER_FILE), 'utf-8'),
    );
    expect(marker).toMatchObject({
      server: 'fs',
      package: 'srv@1.0.0',
      entry: 'node_modules/srv/cli.js',
    });
    expect(leftovers()).toEqual([]);
  });

  it('un npm cortado a mitad no deja nada que parezca instalado', async () => {
    const cfg = server('srv@1.0.0');
    await expect(installServer(cfg, root, undefined, { runNpm: interruptedNpm })).rejects.toThrow(
      /killed by SIGINT/,
    );
    expect(existsSync(serverInstallPath(root, 'fs'))).toBe(false);
    expect(installState(cfg, root).kind).toBe('missing');
    expect(leftovers()).toEqual([]);
  });

  it('cambiar la versión en la config reinstala', async () => {
    const calls: string[] = [];
    const opts = { installDir: root, autoInstall: true };
    await resolveServerCommand(server('srv@1.0.0'), opts, undefined, { runNpm: fakeNpm(calls) });
    expect(installState(server('srv@2.0.0'), root)).toEqual({
      kind: 'outdated',
      installed: 'srv@1.0.0',
    });
    await resolveServerCommand(server('srv@2.0.0'), opts, undefined, { runNpm: fakeNpm(calls) });
    expect(calls).toEqual(['srv@1.0.0', 'srv@2.0.0']);
    const cli = readFileSync(
      join(serverInstallPath(root, 'fs'), 'node_modules', 'srv', 'cli.js'),
      'utf-8',
    );
    expect(cli).toContain('srv@2.0.0');
    expect(leftovers()).toEqual([]);
  });

  it('si la reinstalación falla, la instalación anterior sigue intacta', async () => {
    const opts = { installDir: root, autoInstall: true };
    await resolveServerCommand(server('srv@1.0.0'), opts, undefined, { runNpm: fakeNpm() });
    await expect(
      resolveServerCommand(server('srv@2.0.0'), opts, undefined, { runNpm: interruptedNpm }),
    ).rejects.toThrow(/No se pudo instalar/);
    expect(isServerInstalled(server('srv@1.0.0'), root)).toBe(true);
  });

  it('una instalación legacy (sin marcador) se reinstala, y se usa si no se puede', async () => {
    const dir = serverInstallPath(root, 'fs');
    writePackage(dir, 'srv@1.0.0');
    const cfg = server('srv@1.0.0');
    expect(installState(cfg, root).kind).toBe('legacy');

    const offline = await resolveServerCommand(cfg, { installDir: root, autoInstall: false });
    expect(offline.args[0]).toBe(join(dir, 'node_modules', 'srv', 'cli.js'));

    const failing = await resolveServerCommand(
      cfg,
      { installDir: root, autoInstall: true },
      undefined,
      { runNpm: interruptedNpm },
    );
    expect(failing.args[0]).toBe(join(dir, 'node_modules', 'srv', 'cli.js'));

    resetInstallerStateForTests();
    await resolveServerCommand(cfg, { installDir: root, autoInstall: true }, undefined, {
      runNpm: fakeNpm(),
    });
    expect(installState(cfg, root).kind).toBe('installed');
  });

  it('tras un fallo no relanza npm en cada reconexión', async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('ENOTFOUND registry.npmjs.org');
    };
    const opts = { installDir: root, autoInstall: true };
    for (let i = 0; i < 3; i++) {
      await expect(
        resolveServerCommand(server('srv@1.0.0'), opts, undefined, { runNpm: failing }),
      ).rejects.toThrow(/ENOTFOUND/);
    }
    expect(calls).toBe(1);
  });

  it('dos conexiones simultáneas del mismo proceso comparten una sola instalación', async () => {
    const calls: string[] = [];
    const slow = async (spec: string, prefix: string) => {
      calls.push(spec);
      await new Promise((r) => setTimeout(r, 30));
      writePackage(prefix, spec);
    };
    const opts = { installDir: root, autoInstall: true };
    const [a, b] = await Promise.all([
      resolveServerCommand(server('srv@1.0.0'), opts, undefined, { runNpm: slow }),
      resolveServerCommand(server('srv@1.0.0'), opts, undefined, { runNpm: slow }),
    ]);
    expect(calls).toEqual(['srv@1.0.0']);
    expect(a.args[0]).toBe(b.args[0]);
  });

  it('si otro proceso termina antes la misma instalación, se conserva la suya', async () => {
    const cfg = server('srv@1.0.0');
    const dir = serverInstallPath(root, 'fs');
    const otherProcessWins = async (spec: string, prefix: string) => {
      writePackage(prefix, spec);
      // Mientras tanto, otro proceso promovió su instalación completa.
      writePackage(dir, spec);
      writeFileSync(
        join(dir, MARKER_FILE),
        JSON.stringify({
          schemaVersion: 1,
          server: 'fs',
          package: spec,
          entry: 'node_modules/srv/cli.js',
          installedAt: 'otro-proceso',
        }),
      );
    };
    await installServer(cfg, root, undefined, { runNpm: otherProcessWins });
    const marker = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf-8'));
    expect(marker.installedAt).toBe('otro-proceso');
    expect(leftovers()).toEqual([]);
  });

  it('--force reemplaza aunque ya esté instalado', async () => {
    const cfg = server('srv@1.0.0');
    await installServer(cfg, root, undefined, { runNpm: fakeNpm() });
    const first = JSON.parse(
      readFileSync(join(serverInstallPath(root, 'fs'), MARKER_FILE), 'utf-8'),
    );
    await new Promise((r) => setTimeout(r, 5));
    await installServer(cfg, root, undefined, { runNpm: fakeNpm(), force: true });
    const second = JSON.parse(
      readFileSync(join(serverInstallPath(root, 'fs'), MARKER_FILE), 'utf-8'),
    );
    expect(second.installedAt).not.toBe(first.installedAt);
    expect(leftovers()).toEqual([]);
  });

  it('detecta la colisión de dos servers que se sanitizan igual', async () => {
    await installServer(server('srv@1.0.0', 'a.b'), root, undefined, { runNpm: fakeNpm() });
    const other = server('srv@1.0.0', 'a_b');
    expect(installState(other, root)).toEqual({ kind: 'collision', owner: 'a.b' });
    await expect(
      resolveServerCommand(other, { installDir: root, autoInstall: true }, undefined, {
        runNpm: fakeNpm(),
      }),
    ).rejects.toThrow(/Renombra uno de los dos/);
  });

  it('un marcador cuyo entry se sale de la carpeta no se ejecuta', async () => {
    const cfg = server('srv@1.0.0');
    await installServer(cfg, root, undefined, { runNpm: fakeNpm() });
    const markerPath = join(serverInstallPath(root, 'fs'), MARKER_FILE);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    writeFileSync(markerPath, JSON.stringify({ ...marker, entry: '../../evil.js' }));
    expect(installState(cfg, root).kind).toBe('broken');
  });
});
