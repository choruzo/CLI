import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autostartStatus,
  disableAutostart,
  enableAutostart,
  launchAgentPlist,
  systemdUnit,
  windowsLauncherVbs,
  xdgDesktopEntry,
  type AutostartDeps,
  type AutostartLaunch,
  type AutostartPlatform,
} from './autostart.js';

const launch: AutostartLaunch = {
  node: '/usr/local/bin/node',
  script: '/opt/stratum cli/dist/index.js',
};
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stratum-autostart-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Result = { exitCode: number; stdout: string; stderr: string };
const ok: Result = { exitCode: 0, stdout: '', stderr: '' };

/** `run` falso: registra las llamadas y contesta lo que diga `reply` (por defecto, éxito). */
function fakeDeps(
  platform: AutostartPlatform,
  reply: (cmd: string, args: string[]) => Result = () => ok,
): { deps: AutostartDeps; calls: Array<[string, string[]]> } {
  const calls: Array<[string, string[]]> = [];
  return {
    calls,
    deps: {
      platform,
      home,
      async run(cmd, args) {
        calls.push([cmd, args]);
        return reply(cmd, args);
      },
    },
  };
}

describe('contenido de los ficheros', () => {
  it('vbs: comillas duplicadas, ventana oculta y rutas con espacios', () => {
    const vbs = windowsLauncherVbs({
      node: 'C:\\Program Files\\nodejs\\node.exe',
      script: 'C:\\a b\\i.js',
    });
    expect(vbs).toContain(
      'Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\a b\\i.js"" daemon run", 0, False',
    );
  });

  it('plist: escapa & y <', () => {
    const plist = launchAgentPlist({ node: '/n', script: '/a&b/<c>.js' });
    expect(plist).toContain('<string>/a&amp;b/&lt;c&gt;.js</string>');
    expect(plist).toContain('<string>dev.stratum.daemon</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });

  it('unit y desktop llevan el comando entre comillas', () => {
    const unit = systemdUnit(launch);
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/stratum cli/dist/index.js" daemon run',
    );
    expect(unit).toContain('Restart=no');
    expect(unit).toContain('WantedBy=default.target');
    const desktop = xdgDesktopEntry(launch);
    expect(desktop).toContain(
      'Exec="/usr/local/bin/node" "/opt/stratum cli/dist/index.js" daemon run',
    );
    expect(desktop).toContain('NoDisplay=true');
  });
});

describe('Windows', () => {
  it('on: escribe el vbs y registra la clave Run', async () => {
    const { deps, calls } = fakeDeps('win32');
    const state = await enableAutostart(launch, deps);
    const vbs = join(home, '.stratum', 'daemon', 'autostart.vbs');
    expect(readFileSync(vbs, 'utf-8')).toBe(windowsLauncherVbs(launch));
    expect(calls).toEqual([
      [
        'reg.exe',
        ['add', RUN_KEY, '/v', 'StratumDaemon', '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f'],
      ],
    ]);
    expect(state).toMatchObject({ enabled: true, method: 'run-key' });
  });

  it('on con fallo de reg: error con el stderr y sin vbs', async () => {
    const { deps } = fakeDeps('win32', () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'x'.repeat(500),
    }));
    const err = await enableAutostart(launch, deps).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeLessThan(400);
    expect(existsSync(join(home, '.stratum', 'daemon', 'autostart.vbs'))).toBe(false);
  });

  it('off: borra la clave y el vbs aunque la clave no exista', async () => {
    const on = fakeDeps('win32');
    await enableAutostart(launch, on.deps);
    const { deps, calls } = fakeDeps('win32', () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'not found',
    }));
    const state = await disableAutostart(deps);
    expect(calls).toEqual([['reg.exe', ['delete', RUN_KEY, '/v', 'StratumDaemon', '/f']]]);
    expect(existsSync(join(home, '.stratum', 'daemon', 'autostart.vbs'))).toBe(false);
    expect(state.enabled).toBe(false);
  });

  it('status: lee el valor de reg query', async () => {
    const stdout = `\r\n${RUN_KEY}\r\n    StratumDaemon    REG_SZ    wscript.exe "C:\\x\\autostart.vbs"\r\n`;
    const { deps, calls } = fakeDeps('win32', () => ({ exitCode: 0, stdout, stderr: '' }));
    const state = await autostartStatus(deps);
    expect(calls).toEqual([['reg.exe', ['query', RUN_KEY, '/v', 'StratumDaemon']]]);
    expect(state).toMatchObject({
      enabled: true,
      method: 'run-key',
      command: 'wscript.exe "C:\\x\\autostart.vbs"',
    });
    const off = await autostartStatus(
      fakeDeps('win32', () => ({ exitCode: 1, stdout: '', stderr: '' })).deps,
    );
    expect(off).toEqual({ enabled: false, method: null, location: null, command: null });
  });
});

describe('Linux', () => {
  const unit = (): string => join(home, '.config', 'systemd', 'user', 'stratumd.service');
  const desktop = (): string => join(home, '.config', 'autostart', 'stratumd.desktop');

  it('on con systemd: unit, daemon-reload y enable', async () => {
    const { deps, calls } = fakeDeps('linux');
    const state = await enableAutostart(launch, deps);
    expect(readFileSync(unit(), 'utf-8')).toBe(systemdUnit(launch));
    expect(calls).toEqual([
      ['systemctl', ['--user', 'show-environment']],
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', 'stratumd.service']],
    ]);
    expect(state).toMatchObject({ enabled: true, method: 'systemd', location: unit() });
    expect((await autostartStatus(deps)).method).toBe('systemd');
  });

  it('on sin systemd: XDG autostart', async () => {
    const { deps, calls } = fakeDeps('linux', () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'no bus',
    }));
    const state = await enableAutostart(launch, deps);
    expect(calls).toHaveLength(1);
    expect(readFileSync(desktop(), 'utf-8')).toBe(xdgDesktopEntry(launch));
    expect(existsSync(unit())).toBe(false);
    expect(state.method).toBe('xdg');
    expect((await autostartStatus(deps)).method).toBe('xdg');
  });

  it('on con enable fallido: error y sin unit', async () => {
    const { deps } = fakeDeps('linux', (_c, args) =>
      args.includes('enable') ? { exitCode: 1, stdout: '', stderr: 'boom' } : ok,
    );
    await expect(enableAutostart(launch, deps)).rejects.toThrow(/boom/);
    expect(existsSync(unit())).toBe(false);
  });

  it('off: disable si hay unit y borra unit y .desktop', async () => {
    await enableAutostart(launch, fakeDeps('linux').deps);
    const { deps, calls } = fakeDeps('linux');
    await disableAutostart(deps);
    expect(calls).toEqual([['systemctl', ['--user', 'disable', 'stratumd.service']]]);
    expect(existsSync(unit())).toBe(false);
    expect((await autostartStatus(deps)).enabled).toBe(false);
  });
});

describe('macOS', () => {
  it('on / status / off con el LaunchAgent, sin ejecutar nada', async () => {
    const { deps, calls } = fakeDeps('darwin');
    const file = join(home, 'Library', 'LaunchAgents', 'dev.stratum.daemon.plist');
    const state = await enableAutostart(launch, deps);
    expect(readFileSync(file, 'utf-8')).toBe(launchAgentPlist(launch));
    expect(state).toMatchObject({ enabled: true, method: 'launchagent', location: file });
    expect((await autostartStatus(deps)).enabled).toBe(true);
    await disableAutostart(deps);
    expect(existsSync(file)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('instalación inestable', () => {
  it('rechaza npx y el temporal del SO, sin tocar el disco', async () => {
    const { deps, calls } = fakeDeps('linux');
    await expect(
      enableAutostart(
        { node: 'node', script: '/home/u/.npm/_npx/abc/node_modules/stratum/index.js' },
        deps,
      ),
    ).rejects.toThrow(/stable/);
    await expect(
      enableAutostart({ node: 'node', script: join(tmpdir(), 'x', 'index.js') }, deps),
    ).rejects.toThrow(/stable/);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, '.config'))).toBe(false);
  });
});
