import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach } from 'vitest';
import { BoxConfigSchema } from '../config/schema.js';
import { BoxBusyError, BoxCommandError, BoxManager, BoxUnavailableError } from './manager.js';
import {
  BOX_CONNECTORS_LABEL,
  BOX_LABEL,
  BOX_ROLE_LABEL,
  BOX_SPEC_LABEL,
  DEFAULT_BOX_IMAGE,
  boxSpecHash,
  connectorsSpecHash,
  type BoxSpec,
  type ConnectorsBoxSpec,
} from './spec.js';
import type { RunResult, RuntimeRunner } from './runtime.js';

interface FakeContainer {
  exists: boolean;
  running: boolean;
  labels: Record<string, string>;
}

/**
 * Runtime falso: guarda cada orden y contesta según el estado simulado, por
 * contenedor (la caja del agente y, desde M20, la de conectores). Lo que se
 * comprueba es QUÉ órdenes manda el manager, no Docker.
 *
 * `state` es el de la caja principal; `connectors`, el de la de conectores.
 */
function fakeRuntime(
  initial: {
    exists?: boolean;
    running?: boolean;
    label?: string;
    spec?: string;
    image?: boolean;
    connectors?: Partial<FakeContainer>;
  } = {},
) {
  const state = { image: false, exists: false, running: false, label: 'box', spec: '', ...initial };
  const connectors: FakeContainer = {
    exists: false,
    running: false,
    labels: {},
    ...initial.connectors,
  };
  const calls: string[][] = [];
  const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' });
  const fail = (stderr: string): RunResult => ({ exitCode: 1, stdout: '', stderr });
  const isConnectors = (name: string | undefined) => name === 'stratum-box-box-connectors';
  const run: RuntimeRunner = async (_bin, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'container' && b === 'inspect') {
      const name = args[2];
      if (isConnectors(name)) {
        if (!connectors.exists) return fail(`Error: No such container: ${name}`);
        return ok(
          JSON.stringify([
            { State: { Running: connectors.running }, Config: { Labels: connectors.labels } },
          ]),
        );
      }
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
      if (isConnectors(args[2])) {
        connectors.exists = true;
        connectors.running = false;
        connectors.labels = {};
        args.forEach((v, i) => {
          if (args[i - 1] !== '--label') return;
          const eq = v.indexOf('=');
          connectors.labels[v.slice(0, eq)] = v.slice(eq + 1);
        });
        return ok('id');
      }
      state.exists = true;
      state.running = false;
      const specLabel = args[args.indexOf(`${BOX_LABEL}=box`) + 2] ?? '';
      state.spec = specLabel.split('=')[1] ?? '';
      return ok('id');
    }
    if (a === 'start') {
      if (isConnectors(args[1])) connectors.running = true;
      else state.running = true;
      return ok();
    }
    if (a === 'stop') {
      if (isConnectors(args.at(-1))) connectors.running = false;
      else state.running = false;
      return ok();
    }
    if (a === 'rm') {
      if (isConnectors(args.at(-1))) {
        connectors.exists = false;
        connectors.running = false;
      } else {
        state.exists = false;
        state.running = false;
      }
      return ok();
    }
    if (a === 'volume' && b === 'rm') return ok();
    return fail(`unexpected ${args.join(' ')}`);
  };
  return { state, connectors, calls, run };
}

let exchange: string;
beforeEach(() => {
  exchange = join(mkdtempSync(join(tmpdir(), 'stratum-box-')), 'exchange');
});
afterEach(() => {
  rmSync(join(exchange, '..'), { recursive: true, force: true });
});

function make(
  rt: ReturnType<typeof fakeRuntime>,
  config: Record<string, unknown> = {},
  connectorsWanted?: () => boolean,
) {
  return new BoxManager({
    ...(connectorsWanted ? { connectorsWanted } : {}),
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
  image: DEFAULT_BOX_IMAGE,
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
      DEFAULT_BOX_IMAGE,
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
    // M20: el volumen de la caja de conectores también se borra.
    expect(rt.calls).toContainEqual(['volume', 'rm', '-f', 'stratum-box-box-connectors-data']);
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

const connectorsSpec = (over: Partial<ConnectorsBoxSpec> = {}): ConnectorsBoxSpec => ({
  name: 'box',
  image: DEFAULT_BOX_IMAGE,
  network: true,
  runtime: 'docker',
  platform: 'linux',
  ...over,
});

const upToDateConnectors = (running: boolean) => ({
  exists: true,
  running,
  labels: {
    [BOX_ROLE_LABEL]: 'connectors',
    [BOX_CONNECTORS_LABEL]: 'box',
    [BOX_SPEC_LABEL]: connectorsSpecHash(connectorsSpec()),
  },
});

describe('BoxManager: la caja de conectores (M20)', () => {
  it('sin conectores activos, start no crea la caja de conectores', async () => {
    const rt = fakeRuntime();
    await make(rt).start();
    await make(rt, {}, () => false).start();
    expect(rt.calls.some((c) => c.includes('stratum-box-box-connectors'))).toBe(false);
    expect(rt.connectors.exists).toBe(false);
  });

  it('con conectores activos, start crea y arranca también la de conectores', async () => {
    const rt = fakeRuntime();
    const m = make(rt, {}, () => true);
    expect((await m.start()).state).toBe('running');
    expect(rt.connectors).toMatchObject({ exists: true, running: true });
    expect(rt.connectors.labels).toMatchObject({
      [BOX_ROLE_LABEL]: 'connectors',
      [BOX_CONNECTORS_LABEL]: 'box',
    });
    // No lleva la etiqueta de la caja del agente: `exec` nunca la alcanza.
    expect(rt.connectors.labels[BOX_LABEL]).toBeUndefined();
    expect(await m.connectorsStatus()).toMatchObject({ state: 'running', outdated: false });
    // La imagen de Stratum se construye una sola vez.
    expect(rt.calls.filter((c) => c[0] === 'build')).toHaveLength(1);
  });

  it('usa la imagen de Stratum aunque la caja del agente use otra', async () => {
    const rt = fakeRuntime({ image: true });
    await make(rt, { image: 'ghcr.io/x/y:1' }, () => true).start();
    const create = rt.calls.find(
      (c) => c[0] === 'create' && c[2] === 'stratum-box-box-connectors',
    )!;
    expect(create.at(-1)).toBe(DEFAULT_BOX_IMAGE);
    const main = rt.calls.find((c) => c[0] === 'create' && c[2] === 'stratum-box-box')!;
    expect(main.at(-1)).toBe('ghcr.io/x/y:1');
  });

  it('un fallo de la de conectores no hace fallar start y queda en el estado', async () => {
    const rt = fakeRuntime({ image: true });
    const failing: RuntimeRunner = async (bin, args, opts) =>
      args[0] === 'create' && args[2] === 'stratum-box-box-connectors'
        ? { exitCode: 125, stdout: '', stderr: 'no space left' }
        : rt.run(bin, args, opts);
    const m = new BoxManager({
      config: BoxConfigSchema.parse({}),
      exchangeDir: exchange,
      run: failing,
      detect: async () => ({ ok: true, runtime: { kind: 'docker', bin: 'docker' } }),
      connectorsWanted: () => true,
    });
    expect((await m.start()).state).toBe('running');
    const status = await m.connectorsStatus();
    expect(status.state).toBe('absent');
    expect(status.reason).toMatch(/no space left/);
  });

  it('stop para las dos cajas', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf()),
      connectors: upToDateConnectors(true),
    });
    expect((await make(rt).stop()).state).toBe('stopped');
    expect(rt.calls).toContainEqual([
      'stop',
      '-t',
      expect.any(String),
      'stratum-box-box-connectors',
    ]);
    expect(rt.connectors.running).toBe(false);
    expect(rt.state.running).toBe(false);
  });

  it('reset borra las dos cajas y los dos volúmenes', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf()),
      connectors: upToDateConnectors(true),
    });
    expect((await make(rt).reset()).state).toBe('absent');
    expect(rt.calls).toContainEqual(['rm', '-f', 'stratum-box-box-connectors']);
    expect(rt.calls).toContainEqual(['volume', 'rm', '-f', 'stratum-box-box-home']);
    expect(rt.calls).toContainEqual(['volume', 'rm', '-f', 'stratum-box-box-connectors-data']);
    expect(rt.connectors.exists).toBe(false);
  });

  it('un contenedor con su nombre y sin sus etiquetas no se toca', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf()),
      connectors: { exists: true, running: true, labels: { other: '1' } },
    });
    await expect(make(rt).stop()).rejects.toBeInstanceOf(BoxCommandError);
    await expect(make(rt).reset()).rejects.toBeInstanceOf(BoxCommandError);
    // La caja del agente puede haberse borrado antes; la ajena, ni ella ni su volumen.
    expect(rt.calls.filter((c) => c[0] !== 'container').flat()).not.toContain(
      'stratum-box-box-connectors',
    );
    expect(rt.calls).not.toContainEqual(['volume', 'rm', '-f', 'stratum-box-box-connectors-data']);
    expect((await make(rt).connectorsStatus()).state).toBe('unavailable');
  });

  it('también lo es uno con la etiqueta de la caja del agente (io.stratum.box)', async () => {
    const rt = fakeRuntime({
      connectors: {
        exists: true,
        running: false,
        labels: { ...upToDateConnectors(false).labels, [BOX_LABEL]: 'box' },
      },
    });
    expect((await make(rt).connectorsStatus()).state).toBe('unavailable');
  });

  it('ensureConnectors arranca la de conectores solo si la principal corre', async () => {
    const stopped = fakeRuntime({ exists: true, running: false, image: true });
    expect((await make(stopped).ensureConnectors()).state).toBe('absent');
    expect(stopped.calls.some((c) => c[0] === 'create' || c[0] === 'start')).toBe(false);

    const running = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf()),
    });
    expect((await make(running).ensureConnectors()).state).toBe('running');
    expect(running.connectors).toMatchObject({ exists: true, running: true });
    // No toca la principal.
    expect(running.calls.some((c) => c[0] === 'start' && c[1] === 'stratum-box-box')).toBe(false);
  });

  it('desfasada (otra red): la recrea', async () => {
    const rt = fakeRuntime({
      exists: true,
      running: true,
      image: true,
      spec: boxSpecHash(specOf({ network: false })),
      connectors: upToDateConnectors(true),
    });
    const m = make(rt, { network: false }, () => true);
    expect((await m.connectorsStatus()).outdated).toBe(true);
    await m.start();
    expect(rt.calls).toContainEqual(['rm', '-f', 'stratum-box-box-connectors']);
    const create = rt.calls.find(
      (c) => c[0] === 'create' && c[2] === 'stratum-box-box-connectors',
    )!;
    expect(create[create.indexOf('--network') + 1]).toBe('none');
    expect(await m.connectorsStatus()).toMatchObject({ state: 'running', outdated: false });
  });

  it('sin runtime, connectorsStatus lo dice y no lanza', async () => {
    const m = new BoxManager({
      config: BoxConfigSchema.parse({}),
      exchangeDir: exchange,
      detect: async () => ({ ok: false, reason: 'No container runtime available' }),
    });
    expect(await m.connectorsStatus()).toEqual({
      state: 'unavailable',
      reason: 'No container runtime available',
      outdated: false,
    });
  });
});
