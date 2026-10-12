import { describe, it, expect } from 'vitest';
import { ProtocolError } from '../ipc/codec.js';
import { OperationCache, type OperationKey } from './operation-cache.js';

const key = (over: Partial<OperationKey> = {}): OperationKey => ({
  client: 'cli:stratum',
  operationId: 'op-1',
  method: 'runs.start',
  params: { sessionId: 's', input: 'hola', operationId: 'op-1' },
  ...over,
});

describe('operationId', () => {
  it('el reenvío de la misma petición no la ejecuta otra vez y recibe el mismo resultado', async () => {
    const cache = new OperationCache();
    let runs = 0;
    const exec = async (): Promise<{ n: number }> => ({ n: ++runs });
    const first = await cache.run(key(), exec);
    // Las claves en otro orden son la misma petición.
    const again = await cache.run(
      key({ params: { operationId: 'op-1', input: 'hola', sessionId: 's' } }),
      exec,
    );
    expect(again).toBe(first);
    expect(runs).toBe(1);
  });

  it('un reenvío mientras la operación sigue en curso espera a la misma', async () => {
    const cache = new OperationCache();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const exec = async (): Promise<number> => {
      runs++;
      await gate;
      return 7;
    };
    const a = cache.run(key(), exec);
    const b = cache.run(key(), exec);
    release();
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(runs).toBe(1);
  });

  it('el mismo operationId con otra petición es un error, y no se ejecuta', async () => {
    const cache = new OperationCache();
    let runs = 0;
    const exec = async (): Promise<number> => ++runs;
    await cache.run(key(), exec);
    const other = cache.run(key({ params: { sessionId: 's', input: 'otra cosa' } }), exec);
    await expect(other).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(cache.run(key({ method: 'runs.cancel' }), exec)).rejects.toBeInstanceOf(
      ProtocolError,
    );
    expect(runs).toBe(1);
  });

  it('otro cliente con el mismo operationId es otra operación', async () => {
    const cache = new OperationCache();
    let runs = 0;
    const exec = async (): Promise<number> => ++runs;
    await cache.run(key(), exec);
    await cache.run(key({ client: 'dot:stratum-dot' }), exec);
    expect(runs).toBe(2);
  });

  it('un error del protocolo es el resultado de la operación; un fallo interno, no', async () => {
    const cache = new OperationCache();
    let runs = 0;
    const busy = async (): Promise<never> => {
      runs++;
      throw new ProtocolError('BUSY', 'busy');
    };
    await expect(cache.run(key(), busy)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(cache.run(key(), busy)).rejects.toMatchObject({ code: 'BUSY' });
    expect(runs).toBe(1);

    let attempts = 0;
    const flaky = async (): Promise<string> => {
      if (++attempts === 1) throw new Error('boom');
      return 'ok';
    };
    const k = key({ operationId: 'op-2' });
    await expect(cache.run(k, flaky)).rejects.toThrow('boom');
    await new Promise((r) => setImmediate(r));
    expect(await cache.run(k, flaky)).toBe('ok');
  });

  it('caduca: pasado el TTL el operationId vuelve a ser desconocido', async () => {
    let now = 1_000;
    const cache = new OperationCache({ ttlMs: 100, now: () => now });
    let runs = 0;
    const exec = async (): Promise<number> => ++runs;
    await cache.run(key(), exec);
    now += 99;
    await cache.run(key(), exec);
    expect(runs).toBe(1);
    now += 2;
    await cache.run(key(), exec);
    expect(runs).toBe(2);
  });

  it('está acotada: al llenarse olvida las más antiguas', async () => {
    const cache = new OperationCache({ max: 3 });
    let runs = 0;
    const exec = async (): Promise<number> => ++runs;
    for (let i = 0; i < 10; i++) await cache.run(key({ operationId: `op-${i}` }), exec);
    expect(cache.size).toBeLessThanOrEqual(3);
    await cache.run(key({ operationId: 'op-9' }), exec);
    expect(runs).toBe(10);
    await cache.run(key({ operationId: 'op-0' }), exec);
    expect(runs).toBe(11);
  });
});
