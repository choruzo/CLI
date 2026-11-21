import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { App } from './App';
import { CONNECTED, fakeNative, resetStores, type FakeNative } from '../testing/fixtures';

/**
 * M23 — la salud del asistente en Dot (`docs/protocol.md` §33): el panel de la
 * vista *Asistente* pinta el informe de `doctor.run`. Solo lee.
 */

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function connected(native = fakeNative()): FakeNative {
  render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
  act(() => {
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'sessions', sessionIds: [] });
  });
  return native;
}

const panel = () => screen.getByRole('region', { name: 'Health' });

async function withPanel(native = fakeNative()): Promise<FakeNative> {
  connected(native);
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
  await waitFor(() => expect(native.calls.doctorRun).toHaveBeenCalled());
  return native;
}

const check = (
  id: string,
  area: string,
  status: string,
  title: string,
  detail: string | null = null,
  fix: string | null = null,
) => ({ id, area, status, title, detail, fix });

const REPORT = {
  report: {
    checkedAt: 1_760_000_000_000,
    checks: [
      check('daemon.up', 'daemon', 'ok', 'Daemon running', null, 'never shown'),
      check('box.state', 'box', 'warn', 'Box stopped', 'The box is not running.', 'stratum box start'),
      check('box.image', 'box', 'fail', 'Box image missing', null, 'stratum box build'),
      check('telegram.off', 'telegram', 'off', 'Telegram is off'),
    ],
  },
};

describe('el panel Health', () => {
  it('pide el informe al abrir, una sola vez', async () => {
    const native = await withPanel();
    await waitFor(() => expect(panel().textContent).not.toContain('Checking'));
    expect(native.calls.doctorRun).toHaveBeenCalledTimes(1);
  });

  it('agrupa por área en el orden en que llegan, con su encabezado', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue(REPORT);
    await withPanel(native);
    await waitFor(() => expect(within(panel()).getByText('Box stopped')).toBeTruthy());
    const headings = within(panel())
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Daemon', 'Box', 'Telegram']);
    const box = panel().querySelector('[data-area="box"]')!;
    expect(box.querySelectorAll('.health-check')).toHaveLength(2);
    expect(box.querySelector('[data-check="box.state"] [data-status="warn"]')).not.toBeNull();
    expect(box.querySelector('[data-check="box.image"] [data-status="fail"]')).not.toBeNull();
    expect(within(panel()).getByText('The box is not running.')).toBeTruthy();
  });

  it('enseña el fix solo en lo que no está bien, como texto', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue(REPORT);
    await withPanel(native);
    await waitFor(() => expect(within(panel()).getByText('stratum box start')).toBeTruthy());
    expect(within(panel()).getByText('stratum box build')).toBeTruthy();
    expect(within(panel()).queryByText('never shown')).toBeNull();
    // Ni botón ni enlace: solo texto.
    expect(within(panel()).queryByRole('link')).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /stratum box/ })).toBeNull();
  });

  it('resume los fallos y los avisos', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue(REPORT);
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('1 failing, 1 warnings.'));
  });

  it('dice que todo está bien si nada falla ni avisa', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue({
      report: {
        checkedAt: 1_760_000_000_000,
        checks: [check('daemon.up', 'daemon', 'ok', 'Daemon running'), check('t.off', 'telegram', 'off', 'Telegram is off')],
      },
    });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Everything checked is fine.'));
  });

  it('un error de la llamada se dice y no se repite solo', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockRejectedValue({ kind: 'timeout', message: 'no answer' });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Could not run the check:'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(native.calls.doctorRun).toHaveBeenCalledTimes(1);
  });

  it('un resultado que no valida es un error', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue({ report: { checkedAt: 'ayer', checks: 3 } });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Could not run the check:'));
    expect(panel().querySelector('.health-check')).toBeNull();
  });

  it('Check again vuelve a pedirlo una vez, y está deshabilitado mientras espera', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue(REPORT);
    await withPanel(native);
    const again = () => within(panel()).getByRole('button', { name: 'Check again' }) as HTMLButtonElement;
    await waitFor(() => expect(again().disabled).toBe(false));
    let release: (v: unknown) => void = () => undefined;
    native.calls.doctorRun.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    fireEvent.click(again());
    await waitFor(() => expect(native.calls.doctorRun).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(panel().textContent).toContain('Checking…'));
    expect(again().disabled).toBe(true);
    act(() => release(REPORT));
    await waitFor(() => expect(again().disabled).toBe(false));
    expect(native.calls.doctorRun).toHaveBeenCalledTimes(2);
  });

  it('con un daemon desfasado pone una fila local al principio, sin pedir nada más', async () => {
    const native = fakeNative();
    native.calls.doctorRun.mockResolvedValue(REPORT);
    connected(native);
    act(() => {
      native.push({ type: 'connection', state: { ...CONNECTED, serverRevision: null, serverVersion: '0.14.0' } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    await waitFor(() => expect(panel().textContent).toContain('Box stopped'));
    const row = panel().querySelector('[data-check="revision.skew"]');
    expect(row?.textContent).toContain('The Stratum daemon is older than this Dot');
    expect(row?.textContent).toContain('Stratum 0.14.0');
    expect(row?.querySelector('[data-status="warn"]')).not.toBeNull();
    expect(panel().querySelectorAll('.health-check')[0]).toBe(row);
    expect(native.calls.doctorRun).toHaveBeenCalledTimes(1);
  });

  it('sin desfase no hay fila de revisión', async () => {
    await withPanel();
    expect(panel().querySelector('[data-check="revision.skew"]')).toBeNull();
  });
});
