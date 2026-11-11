import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { ConnectorsPanel } from '../components/ConnectorsPanel';
import type { ApproverStatus } from '../bridge/native';
import { useApprover } from '../stores/approverStore';
import { CONNECTED, fakeNative, resetStores, type FakeNative } from '../testing/fixtures';

/**
 * M20 — los conectores del asistente en Dot: el panel enseña lo que dice
 * `connectors.list`; activar pasa por la confirmación nativa con la autoridad de
 * aprobar; desactivar solo resta (con confirmación en la página); sin estado
 * optimista (tras cada orden se vuelve a pedir la lista).
 */

beforeEach(resetStores);
afterEach(cleanup);

const renfe = (over: Record<string, unknown> = {}) => ({
  id: 'renfe',
  version: '1.1.0',
  name: 'Renfe',
  description: 'Trenes de Renfe.',
  hosts: ['ssl.renfe.com'],
  needs: [],
  tools: [
    { name: 'cercanias_salidas', readOnly: true, summary: 'Salidas.' },
    { name: 'encender', readOnly: false, summary: 'Actúa.' },
  ],
  enabled: false,
  enabledAt: null,
  ...over,
});
const list = (connectors: unknown[], box = 'running', readOnly = false) => ({
  connectors,
  box: { state: box, reason: null },
  readOnly,
});
const ready = () =>
  useApprover.getState().setStatus({ kind: 'ready', expiresAt: Date.now() + 600_000 } as ApproverStatus);

function mounted(native: FakeNative, canControl = true) {
  render(
    <NativeProvider value={native}>
      <ConnectorsPanel connected canControl={canControl} />
    </NativeProvider>,
  );
  act(() => native.push({ type: 'connection', state: CONNECTED }));
}

const panel = () => screen.getByRole('region', { name: 'Connectors' });

describe('panel de conectores', () => {
  it('enseña el catálogo con su estado y la marca de cada tool', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe()]));
    mounted(native);
    await waitFor(() => expect(panel().textContent).toContain('Renfe'));
    expect(panel().textContent).toContain('Disabled');
    expect(panel().textContent).toContain('read-only');
    expect(panel().textContent).toContain('asks approval');
    expect(panel().textContent).toContain('Connects to: ssl.renfe.com');
    expect(panel().textContent).toContain('Connectors box: running');
  });

  it('activar pasa por la vía nativa y vuelve a pedir la lista (sin optimismo)', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe()]));
    ready();
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Enable Renfe' })).toBeTruthy());
    const before = native.calls.connectorsList.mock.calls.length;
    fireEvent.click(within(panel()).getByRole('button', { name: 'Enable Renfe' }));
    await waitFor(() => expect(native.calls.connectorsEnable).toHaveBeenCalledWith('renfe'));
    await waitFor(() => expect(native.calls.connectorsList.mock.calls.length).toBeGreaterThan(before));
    // El estado es lo que contesta el daemon, no lo que se pidió.
    expect(panel().textContent).toContain('Disabled');
    native.calls.connectorsList.mockResolvedValue(list([renfe({ enabled: true, enabledAt: 1 })]));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refresh connectors' }));
    await waitFor(() => expect(panel().textContent).toContain('Enabled'));
  });

  it('sin la autoridad de aprobar no se activa: pide desbloquear', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe()]));
    mounted(native);
    await waitFor(() => expect(panel().textContent).toContain('Renfe'));
    const enable = within(panel()).getByRole('button', { name: 'Enable Renfe' }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Unlock…' }));
    expect(native.calls.unlockApprovals).toHaveBeenCalled();
    expect(native.calls.connectorsEnable).not.toHaveBeenCalled();
  });

  it('desactivar pide confirmación en la página y solo entonces envía', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe({ enabled: true, enabledAt: 1 })]));
    native.calls.connectorsDisable.mockResolvedValue({ connector: renfe(), changed: true });
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Disable Renfe' })).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'Disable Renfe' }));
    expect(native.calls.connectorsDisable).not.toHaveBeenCalled();
    const group = within(panel()).getByRole('group', { name: 'Disable Renfe' });
    fireEvent.click(within(group).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(native.calls.connectorsDisable).toHaveBeenCalledWith('renfe'));
    await waitFor(() => expect(native.calls.connectorsList.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('un resultado desconocido es «Result unknown» y no se repite', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe()]));
    native.calls.connectorsEnable.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'x' });
    ready();
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Enable Renfe' })).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'Enable Renfe' }));
    await waitFor(() => expect(panel().textContent).toContain('Result unknown'));
    expect(native.calls.connectorsEnable).toHaveBeenCalledTimes(1);
  });

  it('un rechazo legible (no-connector) se cuenta tal cual', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe()]));
    native.calls.connectorsEnable.mockRejectedValue({
      kind: 'rejected',
      code: 'NOT_FOUND',
      reason: 'no-connector',
      message: 'That connector cannot be enabled. Nothing was sent.',
    });
    ready();
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Enable Renfe' })).toBeTruthy());
    fireEvent.click(within(panel()).getByRole('button', { name: 'Enable Renfe' }));
    await waitFor(() => expect(panel().textContent).toContain('Nothing was sent'));
  });

  it('con conectores activos y la caja parada, avisa de que no se ofrecen', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe({ enabled: true, enabledAt: 1 })], 'stopped'));
    mounted(native);
    await waitFor(() =>
      expect(panel().textContent).toContain(
        'Enabled connectors are not offered to the assistant until the box is running',
      ),
    );
  });

  it('solo lectura: acciones deshabilitadas y un aviso', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe(), renfe({ id: 'otro', name: 'Otro', enabled: true })], 'running', true));
    ready();
    mounted(native);
    await waitFor(() => expect(panel().querySelector('[data-e2e="connectors-readonly"]')).not.toBeNull());
    expect((within(panel()).getByRole('button', { name: 'Enable Renfe' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel()).getByRole('button', { name: 'Disable Otro' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sin `control` no se cambia nada', async () => {
    const native = fakeNative();
    native.calls.connectorsList.mockResolvedValue(list([renfe()]));
    ready();
    mounted(native, false);
    await waitFor(() => expect(panel().textContent).toContain('Renfe'));
    expect((within(panel()).getByRole('button', { name: 'Enable Renfe' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
