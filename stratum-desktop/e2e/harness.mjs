/**
 * Arnés de la suite E2E (D7): cada `launch()` arranca la app de verdad —
 * binario de Tauri + sidecar SEA— a través de tauri-driver, con un HOME
 * propio (config, sesiones, workspaces y datos del webview aislados de los del
 * usuario) y un servidor OpenAI de mentira (`mock-llm.mjs`).
 *
 * Requisitos: `npm run e2e:build` (app de depuración con la feature `e2e`),
 * `tauri-driver` en el PATH o en `~/.cargo/bin`, y el driver nativo:
 * `msedgedriver` de la versión de WebView2 en Windows (`STRATUM_E2E_NATIVE_DRIVER`
 * o en el PATH) y `WebKitWebDriver` en Linux.
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, startMockLlm } from './mock-llm.mjs';
import { Session } from './webdriver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WINDOWS = process.platform === 'win32';

export const APP =
  process.env.STRATUM_E2E_APP ??
  join(ROOT, 'src-tauri', 'target', 'debug', WINDOWS ? 'stratum-desktop.exe' : 'stratum-desktop');

function tauriDriver() {
  const local = join(homedir(), '.cargo', 'bin', WINDOWS ? 'tauri-driver.exe' : 'tauri-driver');
  return existsSync(local) ? local : 'tauri-driver';
}

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/** Config de pruebas: el provider es el mock y nada sale de la máquina. */
export function e2eConfig(baseUrl, extra = {}) {
  return {
    provider: {
      default: 'e2e',
      providers: {
        e2e: { type: 'openai-compatible', baseUrl, apiKey: '', model: MODEL, contextWindow: 16384 },
      },
    },
    memory: { autoExtract: false, embeddingWarmup: false },
    desktop: {
      notifications: { enabled: false },
      globalHotkey: '',
      updates: { autoCheck: false },
      ...extra.desktop,
    },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'desktop')),
  };
}

/** Un HOME de pruebas que se conserva entre dos `launch` (para reabrir la app). */
export function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'stratum-e2e-'));
  mkdirSync(join(home, '.stratum'), { recursive: true });
  return home;
}

export function configPath(home) {
  return join(home, '.stratum', '.stratumrc.json');
}

export function writeConfig(home, config) {
  writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

export function readConfig(home) {
  return JSON.parse(readFileSync(configPath(home), 'utf8'));
}

function isolatedEnv(home, extra) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (WINDOWS) {
    env.APPDATA = join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    mkdirSync(env.APPDATA, { recursive: true });
    mkdirSync(env.LOCALAPPDATA, { recursive: true });
  } else {
    env.XDG_CONFIG_HOME = join(home, '.config');
    env.XDG_DATA_HOME = join(home, '.local', 'share');
    env.XDG_CACHE_HOME = join(home, '.cache');
  }
  return env;
}

/**
 * Arranca la app. `config`: objeto a escribir (con `baseUrl` del mock ya
 * dentro), `false` para no escribir ninguno (onboarding) o una función que
 * recibe la `baseUrl`. Devuelve la sesión y cómo cerrar todo.
 */
export async function launch({ home = makeHome(), config, env = {}, mock } = {}) {
  const llm = mock ?? (await startMockLlm());
  if (config !== false) {
    const value = typeof config === 'function' ? config(llm.baseUrl) : (config ?? e2eConfig(llm.baseUrl));
    writeConfig(home, value);
  }
  const port = await freePort();
  const nativePort = await freePort();
  const args = ['--port', String(port), '--native-port', String(nativePort)];
  if (process.env.STRATUM_E2E_NATIVE_DRIVER) {
    args.push('--native-driver', process.env.STRATUM_E2E_NATIVE_DRIVER);
  }
  const driver = spawn(tauriDriver(), args, {
    env: isolatedEnv(home, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let driverLog = '';
  driver.stdout.on('data', (d) => (driverLog += d));
  driver.stderr.on('data', (d) => (driverLog += d));

  let session;
  try {
    session = await Session.create(`http://127.0.0.1:${port}`, APP);
    // La TitleBar se pinta en cuanto carga el webview; el input, cuando el
    // agente conecta y la conversación está abierta.
    await session.waitForElement('.titlebar', { timeout: 30_000 });
  } catch (err) {
    driver.kill();
    if (!mock) await llm.close();
    throw new Error(`No arrancó la app: ${err.message}\n--- tauri-driver ---\n${driverLog}`);
  }

  return {
    session,
    home,
    mock: llm,
    driverLog: () => driverLog,
    /** Cierra la app (la sesión) y el driver. `keepHome` para relanzar sobre el mismo HOME. */
    async close({ keepHome = false, keepMock = false } = {}) {
      await saveArtifacts(session, home, driverLog);
      await session.close();
      driver.kill();
      await new Promise((r) => setTimeout(r, 800));
      if (!keepMock && !mock) await llm.close();
      if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

/**
 * Con `STRATUM_E2E_ARTIFACTS` (la CI), al cerrar cada app se guarda una
 * captura, el log de tauri-driver y los logs de la app y del agente, para
 * diagnosticar un fallo sin poder ver la ventana.
 */
async function saveArtifacts(session, home, driverLog) {
  const root = process.env.STRATUM_E2E_ARTIFACTS;
  if (!root) return;
  const dir = join(root, `${Date.now()}-${basename(home)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const png = await session.screenshot();
    writeFileSync(join(dir, 'screenshot.png'), Buffer.from(png, 'base64'));
  } catch {
    /* sin ventana ya */
  }
  writeFileSync(join(dir, 'tauri-driver.log'), driverLog);
  for (const logs of [
    join(home, '.stratum', 'logs'),
    join(home, '.local', 'share', 'dev.stratum.desktop', 'logs'),
    join(home, 'AppData', 'Local', 'dev.stratum.desktop', 'logs'),
  ]) {
    if (existsSync(logs)) {
      cpSync(logs, join(dir, 'logs', `${basename(dirname(logs))}-${basename(logs)}`), { recursive: true });
    }
  }
}

/** Espera a que el input esté habilitado: agente conectado y conversación abierta. */
export async function waitForReady(session, timeout = 60_000) {
  return session.waitFor(
    () =>
      session.execute(
        `const t = document.querySelector('#chat-input'); return !!t && !t.disabled;`,
      ),
    { timeout, message: 'el input habilitado (agente conectado)' },
  );
}

/** Escribe un mensaje en el input y lo envía con Enter. */
export async function send(session, text) {
  const input = await session.find('#chat-input');
  await session.click(input);
  await session.type(input, text);
  await session.type(input, '\uE007'); // Enter
}

/** Espera a que no haya turno en marcha (sin botón «Detener»). */
export async function waitForIdle(session, timeout = 60_000) {
  await session.waitFor(async () => !(await session.button('Detener')), {
    timeout,
    message: 'fin del turno',
  });
}
