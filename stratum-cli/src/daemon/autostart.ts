import { execa } from 'execa';
import { existsSync, readFileSync, realpathSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { writeFileAtomic } from '../config/writer.js';

/**
 * Autoarranque del daemon (M16, PRD §23.5): que `stratumd` arranque al iniciar la
 * sesión del usuario en el SO. Solo en el ámbito del usuario, sin privilegios:
 * clave `Run` de HKCU en Windows, `systemd --user` (o XDG autostart) en Linux y
 * un LaunchAgent en macOS. El proceso lanzado es siempre `<node> <script> daemon run`.
 */

export type AutostartPlatform = 'win32' | 'linux' | 'darwin';

/** Qué se lanza: el `node` actual y el script de la CLI (ya resuelto). */
export interface AutostartLaunch {
  node: string;
  script: string;
}

export interface AutostartDeps {
  platform: AutostartPlatform;
  home: string;
  /** Ejecuta un binario con argumentos en array (nunca shell); no lanza por exit code. */
  run(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export type AutostartMethod = 'run-key' | 'systemd' | 'xdg' | 'launchagent';

export interface AutostartState {
  enabled: boolean;
  method: AutostartMethod | null;
  location: string | null;
  command: string | null;
}

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'StratumDaemon';
const UNIT_NAME = 'stratumd.service';
const LAUNCH_LABEL = 'dev.stratum.daemon';
const NONE: AutostartState = { enabled: false, method: null, location: null, command: null };

/** El `node` y el script con los que corre esta CLI (el script, con symlinks resueltos). */
export function currentLaunch(): AutostartLaunch {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error('Cannot determine the Stratum entry script.');
  let script = resolve(argv1);
  try {
    script = realpathSync(script);
  } catch {
    // Se queda con la ruta absoluta.
  }
  return { node: process.execPath, script };
}

export function defaultAutostartDeps(): AutostartDeps {
  const platform = process.platform;
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') {
    throw new Error(`Autostart is not supported on ${platform}.`);
  }
  return {
    platform,
    home: homedir(),
    async run(cmd, args) {
      const r = await execa(cmd, args, { reject: false, windowsHide: true });
      return {
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
        stdout: String(r.stdout ?? ''),
        stderr: String(r.stderr ?? r.shortMessage ?? ''),
      };
    },
  };
}

// --- Contenido de los ficheros (puras) ---

const quoted = (s: string): string => `"${s}"`;
const commandLine = (l: AutostartLaunch): string =>
  `${quoted(l.node)} ${quoted(l.script)} daemon run`;

/** Lanzador de Windows: VBScript sin ventana (`0`) y sin esperar (`False`). */
export function windowsLauncherVbs(l: AutostartLaunch): string {
  // En VBScript una comilla dentro de una cadena se escribe duplicada.
  const cmd = commandLine(l).replace(/"/g, '""');
  return `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`;
}

/** Argumento entre comillas para systemd (`\` y `"` escapados; `%` es un especificador). */
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

export function systemdUnit(l: AutostartLaunch): string {
  return [
    '[Unit]',
    'Description=Stratum daemon (stratumd)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdQuote(l.node)} ${systemdQuote(l.script)} daemon run`,
    'Restart=no',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Argumento entre comillas para `Exec=` de un .desktop. */
function desktopQuote(s: string): string {
  return `"${s.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

export function xdgDesktopEntry(l: AutostartLaunch): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Stratum daemon',
    `Exec=${desktopQuote(l.node)} ${desktopQuote(l.script)} daemon run`,
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    '',
  ].join('\n');
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function launchAgentPlist(l: AutostartLaunch): string {
  const args = [l.node, l.script, 'daemon', 'run']
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// --- Rutas ---

const vbsPath = (home: string): string => join(home, '.stratum', 'daemon', 'autostart.vbs');
const unitPath = (home: string): string => join(home, '.config', 'systemd', 'user', UNIT_NAME);
const desktopPath = (home: string): string =>
  join(home, '.config', 'autostart', 'stratumd.desktop');
const plistPath = (home: string): string =>
  join(home, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);

// --- Operaciones ---

/** El autoarranque necesita una instalación estable: un temporal o `npx` desaparece. */
function assertStableInstall(l: AutostartLaunch): void {
  const lower = l.script.toLowerCase();
  const tmp = resolve(tmpdir()).toLowerCase();
  const underTmp = lower === tmp || lower.startsWith(tmp.endsWith(sep) ? tmp : tmp + sep);
  if (underTmp || lower.includes('_npx')) {
    throw new Error(
      'Autostart needs a stable Stratum install, but this one runs from a temporary location ' +
        '(npx or a temp folder). Install it with `npm i -g` and try again.',
    );
  }
}

function failure(what: string, r: { stderr: string; stdout: string }): Error {
  const detail = (r.stderr.trim() || r.stdout.trim()).slice(0, 300);
  return new Error(`${what} failed${detail ? `: ${detail}` : '.'}`);
}

export async function enableAutostart(
  launch: AutostartLaunch,
  deps: AutostartDeps,
): Promise<AutostartState> {
  assertStableInstall(launch);
  switch (deps.platform) {
    case 'win32':
      return enableWindows(launch, deps);
    case 'linux':
      return enableLinux(launch, deps);
    case 'darwin': {
      const file = plistPath(deps.home);
      writeFileAtomic(file, launchAgentPlist(launch));
      return { enabled: true, method: 'launchagent', location: file, command: commandLine(launch) };
    }
  }
}

async function enableWindows(
  launch: AutostartLaunch,
  deps: AutostartDeps,
): Promise<AutostartState> {
  const vbs = vbsPath(deps.home);
  writeFileAtomic(vbs, windowsLauncherVbs(launch));
  const value = `wscript.exe "${vbs}"`;
  const r = await deps.run('reg.exe', [
    'add',
    RUN_KEY,
    '/v',
    RUN_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    value,
    '/f',
  ]);
  if (r.exitCode !== 0) {
    rmSync(vbs, { force: true });
    throw failure('Registering the autostart entry (reg.exe)', r);
  }
  return { enabled: true, method: 'run-key', location: `${RUN_KEY}\\${RUN_VALUE}`, command: value };
}

async function enableLinux(launch: AutostartLaunch, deps: AutostartDeps): Promise<AutostartState> {
  const hasSystemd = (await deps.run('systemctl', ['--user', 'show-environment'])).exitCode === 0;
  if (!hasSystemd) {
    const file = desktopPath(deps.home);
    writeFileAtomic(file, xdgDesktopEntry(launch));
    return { enabled: true, method: 'xdg', location: file, command: commandLine(launch) };
  }
  const file = unitPath(deps.home);
  writeFileAtomic(file, systemdUnit(launch));
  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', UNIT_NAME],
  ]) {
    const r = await deps.run('systemctl', args);
    if (r.exitCode !== 0) {
      rmSync(file, { force: true });
      throw failure(`systemctl ${args.join(' ')}`, r);
    }
  }
  return { enabled: true, method: 'systemd', location: file, command: commandLine(launch) };
}

export async function disableAutostart(deps: AutostartDeps): Promise<AutostartState> {
  switch (deps.platform) {
    case 'win32':
      // Que la clave no exista no es un error: el objetivo ya se cumple.
      await deps.run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
      rmSync(vbsPath(deps.home), { force: true });
      break;
    case 'linux': {
      const unit = unitPath(deps.home);
      if (existsSync(unit)) await deps.run('systemctl', ['--user', 'disable', UNIT_NAME]);
      rmSync(unit, { force: true });
      rmSync(desktopPath(deps.home), { force: true });
      break;
    }
    case 'darwin':
      rmSync(plistPath(deps.home), { force: true });
      break;
  }
  return { ...NONE };
}

export async function autostartStatus(deps: AutostartDeps): Promise<AutostartState> {
  switch (deps.platform) {
    case 'win32': {
      const r = await deps.run('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]);
      if (r.exitCode !== 0) return { ...NONE };
      const m = /REG_SZ\s+(.+?)\s*$/m.exec(r.stdout);
      return {
        enabled: true,
        method: 'run-key',
        location: `${RUN_KEY}\\${RUN_VALUE}`,
        command: m?.[1] ?? null,
      };
    }
    case 'linux': {
      const unit = unitPath(deps.home);
      if (existsSync(unit)) {
        return {
          enabled: true,
          method: 'systemd',
          location: unit,
          command: execLine(unit, 'ExecStart='),
        };
      }
      const desktop = desktopPath(deps.home);
      if (existsSync(desktop)) {
        return {
          enabled: true,
          method: 'xdg',
          location: desktop,
          command: execLine(desktop, 'Exec='),
        };
      }
      return { ...NONE };
    }
    case 'darwin': {
      const file = plistPath(deps.home);
      return existsSync(file)
        ? { enabled: true, method: 'launchagent', location: file, command: null }
        : { ...NONE };
    }
  }
}

/** La línea `prefix…` de un fichero, o `null` si no se puede leer. */
function execLine(file: string, prefix: string): string | null {
  try {
    const line = readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : null;
  } catch {
    return null;
  }
}
