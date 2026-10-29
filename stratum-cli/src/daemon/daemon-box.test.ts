import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProtocolError } from '../ipc/codec.js';
import { BoxConfigSchema } from '../config/schema.js';
import { BoxManager } from '../box/manager.js';
import { BOX_LABEL } from '../box/spec.js';
import type { RuntimeRunner } from '../box/runtime.js';
import { boxStatusSchema } from '../protocol/schemas.js';
import { startTestDaemon, type TestDaemon } from './daemon.fixtures.js';

/**
 * M13 — `box.*` en el daemon: capacidades, resultado del contrato y errores
 * traducidos. La caja es un `BoxManager` con un runtime de mentira: lo que se
 * prueba aquí es el método, no Docker (eso está en `container.integration.test.ts`).
 */
function fakeRunner(): RuntimeRunner {
  const state = { exists: false, running: false };
  return async (_bin, args) => {
    const [a, b] = args;
    if (a === 'container' && b === 'inspect') {
      return state.exists
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { State: { Running: state.running }, Config: { Labels: { [BOX_LABEL]: 'box' } } },
            ]),
            stderr: '',
          }
        : { exitCode: 1, stdout: '', stderr: 'Error: No such container: stratum-box-box' };
    }
    if (a === 'create') state.exists = true;
    if (a === 'start') state.running = true;
    if (a === 'stop') state.running = false;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'OK',
    (err: unknown) =>
      err instanceof ProtocolError
        ? `${err.code}${err.data?.reason ? `:${err.data.reason}` : ''}`
        : `threw ${String(err)}`,
  );

let t: TestDaemon | undefined;
let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stratumd-box-')));
});
afterEach(async () => {
  await t?.stop();
  t = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe('box.* (M13)', () => {
  it('observe ve el estado; solo control arranca, para y borra', async () => {
    t = await startTestDaemon({
      base,
      box: new BoxManager({
        config: BoxConfigSchema.parse({ image: 'custom/box:1' }),
        exchangeDir: join(base, 'exchange'),
        run: fakeRunner(),
        detect: async () => ({ ok: true, runtime: { kind: 'podman', bin: 'podman' } }),
      }),
    });
    const observer = await t.connect(['observer'], 'obs');
    const operator = await t.connect(['operator'], 'op');

    const before = await observer.request('box.status', {});
    expect(boxStatusSchema.parse(before.box)).toMatchObject({
      name: 'box',
      state: 'absent',
      runtime: 'podman',
      network: true,
      enabled: false,
    });
    expect(await code(observer.request('box.start', {}))).toBe('FORBIDDEN');
    expect(await code(observer.request('box.reset', {}))).toBe('FORBIDDEN');

    const started = await operator.request('box.start', {});
    expect(started.box.state).toBe('running');
    expect((await operator.request('box.stop', {})).box.state).toBe('stopped');
    expect((await operator.request('box.reset', {})).box.state).toBe('absent');
  });

  it('sin runtime: status lo cuenta y start contesta UNAVAILABLE no-runtime', async () => {
    t = await startTestDaemon({
      base,
      box: new BoxManager({
        config: BoxConfigSchema.parse({}),
        exchangeDir: join(base, 'exchange'),
        detect: async () => ({ ok: false, reason: 'No container runtime available' }),
      }),
    });
    const operator = await t.connect(['operator'], 'op');
    expect((await operator.request('box.status', {})).box).toMatchObject({
      state: 'unavailable',
      runtime: null,
      reason: 'No container runtime available',
    });
    expect(await code(operator.request('box.start', {}))).toBe('UNAVAILABLE:no-runtime');
  });

  it('el runtime rechaza una orden: UNAVAILABLE box-failed con el motivo', async () => {
    const failing: RuntimeRunner = async (bin, args, opts) =>
      args[0] === 'create'
        ? { exitCode: 125, stdout: '', stderr: 'no space left on device' }
        : fakeRunner()(bin, args, opts);
    t = await startTestDaemon({
      base,
      box: new BoxManager({
        config: BoxConfigSchema.parse({ image: 'custom/box:1' }),
        exchangeDir: join(base, 'exchange'),
        run: failing,
        detect: async () => ({ ok: true, runtime: { kind: 'docker', bin: 'docker' } }),
      }),
    });
    const operator = await t.connect(['operator'], 'op');
    const err = await operator.request('box.start', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('UNAVAILABLE');
    expect((err as ProtocolError).data?.reason).toBe('box-failed');
    expect((err as ProtocolError).message).toContain('no space left on device');
  });
});
