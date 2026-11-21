import { beforeEach, describe, expect, it } from 'vitest';
import { fakeNative, resetStores, sampleHealthNotice } from '../testing/fixtures';
import { watchHealthNotices } from './health-notices';

/** M23 — un `health.notice` avisa al sistema una sola vez. */

const notice = (n: unknown) => ({ type: 'health.notice', seq: 9, data: { notice: n } });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('watchHealthNotices', () => {
  beforeEach(() => resetStores());

  it('avisa una vez por aviso y no repite el mismo', async () => {
    const native = fakeNative();
    watchHealthNotices(native, [notice(sampleHealthNotice())]);
    await flush();
    watchHealthNotices(native, [notice(sampleHealthNotice())]);
    await flush();
    expect(native.notifyHealth).toHaveBeenCalledTimes(1);
    expect(native.notifyHealth).toHaveBeenCalledWith(
      'Assistant · a connector needs attention',
      'Google rejected the credentials.',
    );
    watchHealthNotices(native, [notice(sampleHealthNotice({ kind: 'recovered', at: 2 }))]);
    await flush();
    expect(native.notifyHealth).toHaveBeenCalledTimes(2);
  });

  it('ignora lo que no valida', async () => {
    const native = fakeNative();
    watchHealthNotices(native, [notice({ cause: 'x' }), { type: 'watch.notice', data: {} }, null]);
    await flush();
    expect(native.notifyHealth).not.toHaveBeenCalled();
  });
});
