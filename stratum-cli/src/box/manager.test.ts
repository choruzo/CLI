import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach } from 'vitest';
import { BoxConfigSchema } from '../config/schema.js';
import { BoxBusyError, BoxCommandError, BoxManager, BoxUnavailableError } from './manager.js';
import { BOX_LABEL, BOX_SPEC_LABEL, boxSpecHash, type BoxSpec } from './spec.js';
import type { RunResult, RuntimeRunner } from './runtime.js';

/**
 * Runtime falso: guarda cada orden y contesta según el estado simulado. Lo que
 * se comprueba es QUÉ órdenes manda el manager, no Docker.
 */
function fakeRuntime(
  initial: {
    exists?: boolean;
    running?: boolean;
    label?: string;
    spec?: string;
    image?: boolean;
  } = {},
) {
  const state = { image: false, exists: false, running: false, label: 'box', spec: '', ...initial };
  const calls: string[][] = [];
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' });
  const fail = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr });
  const run: RuntimeRunner = async (_bin, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'container' && b === 'inspect') {
      if (!state.exists) return fail('Error: No such container: stratum-box-box');
      return ok(
        JSON.stringify([
          {
            State: { Running: state.running },
            Config: { Labels: { [BOX_LABEL]: state.label, [BOX_SPEC_LABEL]: state.spec } },
          },
        ]),
      );
    }
    if (a === 'image' && b === 'inspect') return state.image ? ok('[]') : fail('No such image');
    if (a === 'build') {
      state.image = true;
      return ok();
    }
    if (a === 'create') {
      state.exists = true;
      state.running = false;
      const specLabel = args[args.indexOf(`${BOX_LABEL}=box`) + 2] ?? '';
      state.spec = specLabel.split('=')[1] ?? '';
      return ok('id');
    }
    if (a === 'start') {
      state.running = true;
      return ok();
    }
    if (a === 'stop') {
      state.running = false;
      return ok();
    }
    if (a === 'rm') {
      state.exists = false;
      state.running = false;
      return ok();
    }
    if (a === 'volume' && b === 'rm') return ok();
    return fail(`unexpected ${args.join(' ')}`);
  };
  return { state, calls, run };
}

let exchange: string;
beforeEach(() => {
  exchange = join(mkdtempSync(join(tmpdir(), 'stratum-box-')), 'exchange');
});
afterEach(() => {
  rmSync(join(exchange, '..'), { recursive: true, force: true });
});

function make(rt: ReturnType<typeof fakeRuntime>, config: Record<string, unknown> = {}) {
  return new BoxManager({
    config: BoxConfigSchema.parse(config),
    exchangeDir: exchange,
    imageDir: '/pkg/box-image',
    run: rt.run,
    detect: async () => ({ ok: true, runtime: { kind: 'docker', bin: 'docker' } }),
    platform: 'linux',
  });
}

const specOf = (over: Partial<BoxSpec> = {}): BoxSpec => ({
  name: 'box',
  image: 'stratum-box:1',
  network: true,
  exchangeDir: exchange,
  runtime: 'docker',
  platform: 'linux',
  ...over,
});

const verbs = (calls: string[][]) => calls.map((c) => c.slice(0, 2).join(' '));

describe('BoxManager (M13)', () => {
  it('start sin caja ni imagen: construye, crea y arranca', async () => {
    const rt = fakeRuntime();
    const status = await make(rt).start();
    expect(verbs(rt.calls)).toEqual([
      'container inspect',
      'image inspect',
      'build -t',
      'create --name',
      'start stratum-box-box',
      'container inspect',
    ]);
    const build = rt.calls.find((c) => c[0] === 'build')!;
    expect(build).toEqual([
      'build',
      '-t',
      'stratum-box:1',
      '-f',
      join('/pkg/box-image', 'Containerfile'),
      '/pkg/box-image',
    ]);
    expect(status).toMatchObject({ state: 'running', runtime: 'docker', outdated: false });
  });

  it('una imagen propia no se construye: la descarga create', async () => {
    const rt = fakeRuntime();
    await make(rt, { image: 'ghcr.io/x/y:1' }).start();
    expect(verbs(rt.calls)).not.toContain('build -t');
    expect(verbs(rt.calls)).not.toContain('image inspect');
  });

  it('start sobre una caja parada y al día solo la arranca', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: false,
      image: true,
      spec: boxSpecHash(specOf()),
    });
    await make(rt).start();
    expect(verbs(rt.calls)).toEqual([
      'container inspect',
      'start stratum-box-box',
      'container inspect',
    ]);
  });

  it('desfasada (otra red): recrea el contenedor sin tocar el volumen', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf()),
    });
    const before = await make(rt, { network: false }).status();
    expect(before.outdated).toBe(true);
    rt.calls.length = 0;
    const after = await make(rt, { network: false }).start();
    expect(verbs(rt.calls)).toContain('rm -f');
    expect(rt.calls.some((c) => c[0] === 'volume')).toBe(false);
    const create = rt.calls.find((c) => c[0] === 'create')!;
    expect(create[create.indexOf('--network') + 1]).toBe('none');
    expect(after).toMatchObject({ state: 'running', outdated: false, network: false });
  });

  it('un contenedor con su nombre que no creó Stratum no se toca', async () => {
    const rt = fakeRuntime({ exists: true, running: true, label: 'someone-else' });
    await expect(make(rt).start()).rejects.toBeInstanceOf(BoxCommandError);
    await expect(make(rt).reset()).rejects.toBeInstanceOf(BoxCommandError);
    expect(rt.calls.some((c) => c[0] === 'rm' || c[0] === 'volume')).toBe(false);
    expect((await make(rt).status()).state).toBe('unavailable');
  });

  it('stop solo si corre; reset borra contenedor y volumen', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf()),
    });
    expect((await make(rt).stop()).state).toBe('stopped');
    rt.calls.length = 0;
    expect((await make(rt).stop()).state).toBe('stopped');
    expect(verbs(rt.calls)).not.toContain('stop -t');
    rt.calls.length = 0;
    expect((await make(rt).reset()).state).toBe('absent');
    expect(rt.calls).toContainEqual(['rm', '-f', 'stratum-box-box']);
    expect(rt.calls).toContainEqual(['volume', 'rm', '-f', 'stratum-box-box-home']);
  });

  it('sin runtime: status lo dice y las órdenes lanzan BoxUnavailableError', async () => {
    const m = new BoxManager({
      config: BoxConfigSchema.parse({}),
      exchangeDir: exchange,
      detect: async () => ({ ok: false, reason: 'No container runtime available' }),
    });
    expect(await m.status()).toMatchObject({
      state: 'unavailable',
      runtime: null,
      reason: 'No container runtime available',
    });
    await expect(m.start()).rejects.toBeInstanceOf(BoxUnavailableError);
  });

  it('una operación a la vez', async () => {
    const rt = fakeRuntime();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: RuntimeRunner = async (bin, args, opts) => {
      if (args[0] === 'build') await gate;
      return rt.run(bin, args, opts);
    };
    const m = new BoxManager({
      config: BoxConfigSchema.parse({}),
      exchangeDir: exchange,
      imageDir: '/pkg/box-image',
      run: slow,
      detect: async () => ({ ok: true, runtime: { kind: 'docker', bin: 'docker' } }),
    });
    const first = m.start();
    await new Promise((r) => setTimeout(r, 10));
    await expect(m.stop()).rejects.toBeInstanceOf(BoxBusyError);
    release();
    await first;
  });

  it('un fallo del runtime sale como BoxCommandError con su motivo', async () => {
    const rt = fakeRuntime({ image: true });
    const failing: RuntimeRunner = async (bin, args, opts) =>
      args[0] === 'create'
        ? { exitCode: 125, stdout: '', stderr: 'boom: disk full' }
        : rt.run(bin, args, opts);
    const m = new BoxManager({
      config: BoxConfigSchema.parse({}),
      exchangeDir: exchange,
      run: failing,
      detect: async () => ({ ok: true, runtime: { kind: 'docker', bin: 'docker' } }),
    });
    await expect(m.start()).rejects.toThrow(/create the box: boom: disk full/);
  });
});
