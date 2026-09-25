import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { AUTO_CHECK_DELAY_MS, updateReducer, useUpdates, type UpdatePhase } from './useUpdates';
import { UpdateBanner } from '../components/layout/UpdateBanner';
import type { UpdateInfo } from '../ipc/updates';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));

const INFO: UpdateInfo = {
  version: '0.2.0',
  currentVersion: '0.1.0',
  notes: '- Ventana sin marco\n- Razonamiento visible',
  date: '2026-09-25T10:00:00Z',
};

describe('updateReducer (D7)', () => {
  it('check → available → descarga → instalando', () => {
    let s: UpdatePhase = { kind: 'idle' };
    s = updateReducer(s, { type: 'check', manual: false });
    expect(s).toEqual({ kind: 'checking', manual: false });
    s = updateReducer(s, { type: 'checked', info: INFO, at: 1 });
    expect(s).toEqual({ kind: 'available', info: INFO });
    s = updateReducer(s, {
      type: 'progress',
      progress: { event: 'progress', downloaded: 5, total: 10 },
    });
    expect(s).toMatchObject({ kind: 'downloading', downloaded: 5, total: 10 });
    // Una comprobación a mitad de descarga no la interrumpe.
    expect(updateReducer(s, { type: 'check', manual: true })).toBe(s);
    s = updateReducer(s, { type: 'progress', progress: { event: 'installing' } });
    expect(s).toEqual({ kind: 'installing', info: INFO });
  });

  it('sin versión nueva → none; un fallo recuerda si fue manual', () => {
    expect(updateReducer({ kind: 'checking', manual: true }, { type: 'checked', info: null, at: 7 })).toEqual({
      kind: 'none',
      checkedAt: 7,
    });
    expect(
      updateReducer({ kind: 'checking', manual: false }, { type: 'failed', message: 'sin red' }),
    ).toEqual({ kind: 'error', message: 'sin red', manual: false });
    // Progreso sin nada que instalar: se ignora.
    expect(
      updateReducer({ kind: 'idle' }, { type: 'progress', progress: { event: 'installing' } }),
    ).toEqual({ kind: 'idle' });
  });
});

function Harness({ connected = true, autoCheck = true }: { connected?: boolean; autoCheck?: boolean }) {
  const updates = useUpdates(connected, autoCheck);
  return (
    <>
      <UpdateBanner updates={updates} />
      <p data-testid="phase">{updates.phase.kind}</p>
      <button type="button" onClick={updates.check}>
        buscar
      </button>
    </>
  );
}

describe('useUpdates + UpdateBanner (D7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const flush = () => act(async () => {});

  it('busca sola al conectar (con retraso) y ofrece la versión', async () => {
    vi.mocked(invoke).mockResolvedValue(INFO);
    render(<Harness />);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS);
    });
    await flush();
    expect(invoke).toHaveBeenCalledWith('update_check');
    expect(screen.getByText('Stratum 0.2.0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Novedades' }));
    expect(screen.getByText(/Razonamiento visible/)).toBeTruthy();
  });

  it('con autoCheck desactivado no pregunta a nadie', async () => {
    render(<Harness autoCheck={false} />);
    await act(async () => {
      vi.advanceTimersByTime(AUTO_CHECK_DELAY_MS * 2);
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('«Más tarde» aparca esa versión y no vuelve a ofrecerla', async () => {
    vi.mocked(invoke).mockResolvedValue(INFO);
    const { unmount } = render(<Harness autoCheck={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'buscar' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Más tarde' }));
    expect(screen.queryByText('Stratum 0.2.0')).toBeNull();
    unmount();
    render(<Harness autoCheck={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'buscar' }));
    await flush();
    expect(screen.getByTestId('phase').textContent).toBe('available');
    expect(screen.queryByText('Stratum 0.2.0')).toBeNull();
  });

  it('instalar pasa a la barra de progreso', async () => {
    vi.mocked(invoke).mockImplementation((cmd) =>
      cmd === 'update_check' ? Promise.resolve(INFO) : new Promise(() => {}),
    );
    render(<Harness autoCheck={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'buscar' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Instalar y reiniciar' }));
    expect(invoke).toHaveBeenCalledWith('update_install', expect.anything());
    expect(screen.getByRole('progressbar', { name: 'Descarga de la actualización' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Más tarde' })).toBeNull();
  });

  it('si la instalación falla, el banner lo dice y ofrece reintentar', async () => {
    vi.mocked(invoke).mockImplementation((cmd) =>
      cmd === 'update_check'
        ? Promise.resolve(INFO)
        : Promise.reject('signature verification failed'),
    );
    render(<Harness autoCheck={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'buscar' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Instalar y reiniciar' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/No se pudo instalar: signature verification failed/);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Instalar y reiniciar' })).toBeTruthy();
  });
});
