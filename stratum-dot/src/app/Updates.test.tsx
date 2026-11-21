import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../bridge/context';
import type { UpdateInfo, UpdateProgress } from '../bridge/native';
import { CONNECTED, fakeNative, resetStores, type FakeNative } from '../testing/fixtures';
import { App } from './App';
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_EVERY_MS, updateReducer } from './useUpdates';

const INFO: UpdateInfo = { version: '0.4.0', currentVersion: '0.3.0', notes: '- Auto-update', date: null };

beforeEach(() => {
  resetStores();
  window.localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(native: FakeNative) {
  render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
  act(() => native.push({ type: 'connection', state: CONNECTED }));
}

/** Pasa el retraso de la comprobación automática y deja que resuelva la promesa. */
async function autoCheck() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_CHECK_DELAY_MS);
  });
}

describe('auto-update de Dot (M23)', () => {
  it('comprueba sola tras arrancar y ofrece la versión nueva sin instalarla', async () => {
    const native = fakeNative();
    native.calls.checkForUpdate.mockResolvedValue(INFO);
    mount(native);
    expect(native.calls.checkForUpdate).not.toHaveBeenCalled();
    await autoCheck();
    expect(native.calls.checkForUpdate).toHaveBeenCalledTimes(1);
    const banner = screen.getByRole('status', { name: 'Update available' });
    expect(banner.textContent).toContain('Stratum Dot 0.4.0 is available');
    expect(banner.textContent).toContain('You have 0.3.0');
    expect(native.calls.installUpdate).not.toHaveBeenCalled();
  });

  it('vuelve a comprobar cada 12 h: Dot vive días en la bandeja', async () => {
    const native = fakeNative();
    mount(native);
    await autoCheck();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_CHECK_EVERY_MS);
    });
    expect(native.calls.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it('«Install and restart» instala y enseña el progreso', async () => {
    const native = fakeNative();
    native.calls.checkForUpdate.mockResolvedValue(INFO);
    let report: ((p: UpdateProgress) => void) | undefined;
    native.calls.installUpdate.mockImplementation(async (onProgress: (p: UpdateProgress) => void) => {
      report = onProgress;
      return new Promise<void>(() => undefined);
    });
    mount(native);
    await autoCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
    expect(native.calls.installUpdate).toHaveBeenCalledTimes(1);
    act(() => report!({ event: 'progress', downloaded: 1_048_576, total: 2_097_152 }));
    expect(screen.getByRole('status', { name: 'Update available' }).textContent).toContain('Downloading 1.0 MB of 2.0 MB (50%)');
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
    act(() => report!({ event: 'installing' }));
    expect(screen.getByRole('status', { name: 'Update available' }).textContent).toContain('Dot will restart by itself');
  });

  it('«Later» aparca esa versión, y una más nueva vuelve a avisar', async () => {
    const native = fakeNative();
    native.calls.checkForUpdate.mockResolvedValue(INFO);
    mount(native);
    await autoCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status', { name: 'Update available' })).toBeNull();
    native.calls.checkForUpdate.mockResolvedValue({ ...INFO, version: '0.5.0' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('status', { name: 'Update available' }).textContent).toContain('0.5.0');
  });

  it('un fallo de la comprobación automática no se enseña; el de la manual, sí', async () => {
    const native = fakeNative();
    native.calls.checkForUpdate.mockRejectedValue('network unreachable');
    mount(native);
    await autoCheck();
    expect(screen.queryByText('Update check failed')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
      await Promise.resolve();
    });
    const button = screen.getByRole('button', { name: 'Update check failed' });
    expect(button.getAttribute('title')).toContain('network unreachable');
  });

  it('a mano, sin versión nueva, dice que está al día', async () => {
    const native = fakeNative();
    mount(native);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Dot is up to date' })).toBeTruthy();
  });

  it('si la instalación falla, Dot sigue y se puede volver a buscar', async () => {
    const native = fakeNative();
    native.calls.checkForUpdate.mockResolvedValue(INFO);
    native.calls.installUpdate.mockRejectedValue('the installer was cancelled');
    mount(native);
    await autoCheck();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Install and restart' }));
      await Promise.resolve();
    });
    const banner = screen.getByRole('status', { name: 'Update available' });
    expect(banner.textContent).toContain('Could not install it: the installer was cancelled');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('updateReducer', () => {
  it('una comprobación no interrumpe una descarga en marcha', () => {
    const downloading = { kind: 'downloading', info: INFO, downloaded: 10, total: null } as const;
    expect(updateReducer(downloading, { type: 'check', manual: true })).toBe(downloading);
  });

  it('una respuesta que llega sin comprobación en curso no cambia nada', () => {
    const available = { kind: 'available', info: INFO } as const;
    expect(updateReducer(available, { type: 'checked', info: null, at: 1 })).toBe(available);
  });
});

describe('sin la CLI', () => {
  it('dice cómo instalarla, con el motivo con tipo y no por el texto', () => {
    const native = fakeNative();
    render(
      <NativeProvider value={native}>
        <App />
      </NativeProvider>,
    );
    act(() =>
      native.push({
        type: 'connection',
        state: { kind: 'error', message: 'Could not start the Stratum daemon: …', reason: 'cli-missing' },
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-reason')).toBe('cli-missing');
    expect(alert.textContent).toContain('Stratum Dot needs the Stratum CLI');
    expect(alert.textContent).toContain('npm install -g stratum-cli');
    fireEvent.click(screen.getByRole('button', { name: 'Retry connecting to the daemon' }));
    expect(native.calls.retry).toHaveBeenCalled();
  });

  it('otro error sin motivo se enseña tal cual', () => {
    const native = fakeNative();
    render(
      <NativeProvider value={native}>
        <App />
      </NativeProvider>,
    );
    act(() => native.push({ type: 'connection', state: { kind: 'error', message: 'The Stratum daemon is not running.' } }));
    expect(screen.getByRole('alert').textContent).toContain('The Stratum daemon is not running.');
    expect(screen.queryByText('Stratum Dot needs the Stratum CLI')).toBeNull();
  });
});
