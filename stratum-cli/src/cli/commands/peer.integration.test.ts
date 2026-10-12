import { describe, it, expect, afterAll } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { StratumClient } from '../../client/client.js';
import { ENDPOINT_FILE, fileDiscovery } from '../../client/discovery.js';
import { MOCK_MODEL, startMockLlm, type MockLlm } from '../../eval/mock-llm.js';
import type { ScriptStep } from '../../eval/scenario.js';
import type { ProtocolRun, ProtocolSession } from '../../protocol/index.js';

/**
 * M3 con los procesos de verdad: un `stratumd`, un `stratum run` en otro
 * proceso que se publica en él, y `stratum ps` y un operador mirándolo desde
 * fuera. Lo único de guion es el modelo.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'index.ts');
const tsxLoader = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'loader.mjs'),
).href;

const home = realpathSync(mkdtempSync(join(tmpdir(), 'stratum-peer-')));
const dir = join(home, '.stratum', 'daemon');
const endpointFile = join(dir, ENDPOINT_FILE);
// Los tests corren con la publicación desactivada (vitest.config); aquí es justo lo que se prueba.
const env = { HOME: home, USERPROFILE: home, STRATUM_LOG_LEVEL: 'silent', STRATUM_NO_DAEMON: '' };
const SLEEP = (seconds: number): string =>
  process.platform === 'win32' ? `Start-Sleep -Seconds ${seconds}` : `sleep ${seconds}`;

const children: ResultPromise[] = [];
const mocks: MockLlm[] = [];
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await stratum(home, 'daemon', 'stop', '--force').catch(() => undefined);
  for (const mock of mocks) await mock.close().catch(() => undefined);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const cli = (cwd: string, args: string[]): ResultPromise =>
  execa(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {
    cwd,
    env,
    reject: false,
    timeout: 120_000,
  });

function stratum(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return cli(cwd, args).then((r) => ({
    exitCode: r.exitCode ?? -1,
    stdout: String(r.stdout),
    stderr: String(r.stderr),
  }));
}

/** Un proyecto con su modelo de guion. */
async function project(
  name: string,
  script: ScriptStep[],
  daemon: Record<string, unknown> = {},
): Promise<string> {
  const mock = await startMockLlm(script);
  mocks.push(mock);
  const cwd = join(home, name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, '.stratumrc.json'),
    JSON.stringify({
      provider: {
        default: 'mock',
        providers: {
          mock: {
            type: 'openai-compatible',
            baseUrl: mock.baseUrl,
            apiKey: 'none',
            model: MOCK_MODEL,
            contextWindow: 200_000,
          },
        },
      },
      memory: { autoExtract: false },
      skills: { enabled: false },
      daemon,
    }),
  );
  return cwd;
}

async function until<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function connect(role: 'observer' | 'operator'): Promise<StratumClient> {
  const client = new StratumClient({
    discovery: fileDiscovery({ dir }),
    identity: { kind: 'other', name: 'test', version: '0', roles: [role] },
    reconnect: false,
    requestTimeoutMs: 15_000,
  });
  await client.connect();
  return client;
}

type PsJson = { running: boolean; sessions: ProtocolSession[]; runs: ProtocolRun[] };
const ps = async (): Promise<PsJson> =>
  JSON.parse((await stratum(home, 'ps', '--json')).stdout) as PsJson;

describe('stratum run como anfitrión par (procesos reales)', () => {
  it('sin daemon funciona igual y no arranca ninguno', async () => {
    const cwd = await project('solo', [{ text: 'hecho sin nadie' }]);
    const result = await stratum(cwd, 'run', 'saluda');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hecho sin nadie');
    expect(existsSync(endpointFile)).toBe(false);
    const none = await stratum(home, 'ps');
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain('not running');
  }, 120_000);

  it('se ve en `stratum ps`, y parar el daemon a la fuerza no mata la tarea', async () => {
    expect((await stratum(home, 'daemon', 'start')).exitCode).toBe(0);
    const cwd = await project('visible', [
      { toolCalls: [{ name: 'exec', args: { command: SLEEP(20) } }] },
      { text: 'hecho aunque el daemon se fue' },
    ]);
    const task = cli(cwd, ['run', 'analiza este proyecto']);
    children.push(task);

    // Terminal 3: `stratum ps` ve la sesión de la otra terminal, en marcha.
    const seen = await until(async () => {
      const state = await ps();
      return state.sessions.length === 1 && state.runs[0]?.status === 'running' ? state : false;
    });
    expect(seen.sessions[0]).toMatchObject({
      host: { kind: 'peer', client: 'cli', connected: true },
      state: 'running',
      cwd: realpathSync(cwd),
      model: MOCK_MODEL,
    });
    expect(seen.runs[0]).toMatchObject({ input: 'analiza este proyecto', kind: 'run' });
    const table = (await stratum(home, 'ps')).stdout;
    expect(table).toMatch(/SESSION\s+HOST\s+STATE\s+AGENT\s+MODEL\s+CWD\s+RUN/);
    expect(table).toContain(seen.sessions[0]!.id);
    expect(table).toMatch(/\bcli\s+running\b/);
    expect(table).toContain('analiza este proyecto');

    // El daemon no aloja nada: parar sin --force se niega por el run de la CLI…
    const refused = await stratum(home, 'daemon', 'stop');
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('--force');
    // …y a la fuerza se va, sin llevarse la tarea por delante.
    expect((await stratum(home, 'daemon', 'stop', '--force')).exitCode).toBe(0);
    expect(existsSync(endpointFile)).toBe(false);

    const result = await task;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe('hecho aunque el daemon se fue');
  }, 180_000);

  it('otro cliente la redirige y la cancela; al morir el proceso no queda nada', async () => {
    expect((await stratum(home, 'daemon', 'start')).exitCode).toBe(0);
    const cwd = await project('control', [
      { toolCalls: [{ name: 'exec', args: { command: SLEEP(60) } }] },
      { text: 'no debería llegar' },
    ]);
    // Un observador en continuo, arrancado antes que la tarea.
    const watcher = cli(home, ['ps', '--watch', '--json']);
    children.push(watcher);
    let watched = '';
    watcher.stdout?.on('data', (chunk: Buffer) => (watched += chunk.toString('utf-8')));
    const frames = (): PsJson[] =>
      watched
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as PsJson);
    await until(async () => frames().length > 0);
    expect(frames()[0]!.sessions).toEqual([]);

    const task = cli(cwd, ['run', 'tarea larga']);
    children.push(task);
    const operator = await connect('operator');
    const run = await until(async () => {
      const { runs } = await operator.request('runs.list', { active: true });
      return runs[0];
    });

    expect(
      await operator.request('runs.steer', { sessionId: run.sessionId, text: 'mejor otra cosa' }),
    ).toEqual({ status: 'accepted' });
    expect(
      await operator.request('runs.cancel', { sessionId: run.sessionId, runId: run.id }),
    ).toEqual({ status: 'cancelled' });

    const result = await task;
    expect(result.exitCode).toBe(130);
    expect(String(result.stderr)).toContain('cancelled from another client');
    // La CLI se despidió: ni sesión ni run en curso.
    await until(async () => (await operator.request('sessions.list', {})).sessions.length === 0);
    expect((await operator.request('runs.get', { runId: run.id })).run.status).toBe('cancelled');
    // `ps --watch` lo fue contando según ocurría: apareció, corrió, se canceló y se fue.
    await until(async () => frames().at(-1)?.sessions.length === 0 && frames().length > 2);
    const seen = frames();
    expect(seen.some((f) => f.sessions[0]?.state === 'running')).toBe(true);
    expect(seen.some((f) => f.runs[0]?.status === 'running')).toBe(true);
    expect(seen.some((f) => f.sessions[0]?.host.kind === 'peer')).toBe(true);
    watcher.kill();

    // Y si el proceso muere de golpe, su proyección no se queda para siempre.
    const cwd2 = await project('killed', [
      { toolCalls: [{ name: 'exec', args: { command: SLEEP(60) } }] },
    ]);
    const doomed = cli(cwd2, ['run', 'tarea que muere']);
    children.push(doomed);
    await until(async () => (await operator.request('sessions.list', {})).sessions.length === 1);
    doomed.kill('SIGKILL');
    await doomed;
    await until(async () => (await operator.request('sessions.list', {})).sessions.length === 0);
    expect((await operator.request('core.status', {})).activeRuns).toBe(0);
    operator.close();
    expect((await stratum(home, 'daemon', 'stop')).exitCode).toBe(0);
  }, 240_000);

  it('daemon.autoStart: la CLI arranca el daemon y se publica en él', async () => {
    expect(existsSync(endpointFile)).toBe(false);
    const cwd = await project(
      'autostart',
      [{ toolCalls: [{ name: 'exec', args: { command: SLEEP(6) } }] }, { text: 'hecho' }],
      { autoStart: true },
    );
    const task = cli(cwd, ['run', 'arranca tú']);
    children.push(task);
    const seen = await until(async () => {
      if (!existsSync(endpointFile)) return false;
      const state = await ps().catch(() => undefined);
      return state?.sessions.length === 1 ? state : false;
    });
    expect(seen.sessions[0]!.host.kind).toBe('peer');
    const result = await task;
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout).trim()).toBe('hecho');
    // El daemon sobrevive a quien lo arrancó.
    expect((await stratum(home, 'daemon', 'status')).exitCode).toBe(0);
    expect((await ps()).sessions).toEqual([]);
  }, 180_000);
});
