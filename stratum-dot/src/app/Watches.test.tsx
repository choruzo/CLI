import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { useUi } from '../stores/uiStore';
import { useWatches } from '../stores/watchStore';
import { App } from './App';
import {
  CONNECTED,
  fakeNative,
  resetStores,
  sampleWatch,
  sampleWatchNotice,
  type FakeNative,
} from '../testing/fixtures';

/**
 * M22 — los vigilantes del asistente en Dot (`docs/protocol.md` §31): el panel
 * de la vista *Asistente* y el aviso del sistema. Todo sale de lo que contesta
 * el daemon; nada de estado supuesto, y crear no está en Dot.
 */

beforeEach(() => {
  resetStores();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function connected(native = fakeNative(), capabilities = ['observe', 'control']): FakeNative {
  render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
  act(() => {
    native.push({ type: 'connection', state: { ...CONNECTED, capabilities } as typeof CONNECTED });
    native.push({ type: 'sessions', sessionIds: [] });
  });
  return native;
}

const openAssistant = () => fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
const panel = () => screen.getByRole('region', { name: 'Watches' });

async function withPanel(native = fakeNative(), capabilities?: string[]): Promise<FakeNative> {
  connected(native, capabilities);
  openAssistant();
  await waitFor(() => expect(native.calls.watchesList).toHaveBeenCalled());
  return native;
}

const daemonError = (code: string, message: string, reason: string | null = null) => ({
  kind: 'rejected',
  code,
  reason,
  message,
});

const list = (watches: unknown[], readOnly = false) => ({ watches, checks: [], readOnly });

describe('el panel de vigilantes', () => {
  it('enseña cada vigilante con su condición, su intervalo y sus marcas', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(
      list([
        sampleWatch({
          id: 'wat_a',
          name: 'Luz del salón',
          connector: 'home-assistant',
          check: 'estado_entidad',
          condition: { kind: 'state-is', values: ['on'], forMinutes: 10 },
          intervalSec: 60,
          firing: true,
          lastFiredAt: new Date(2026, 10, 17, 21, 5).getTime(),
          origin: 'agent',
        }),
        sampleWatch({
          id: 'wat_b',
          name: 'Calor',
          condition: { kind: 'above', threshold: 30 },
          status: 'paused',
          health: 'failing',
        }),
        sampleWatch({ id: 'wat_c', name: 'Cambios', condition: { kind: 'changes' }, health: 'suspended' }),
      ]),
    );
    await withPanel(native);
    const items = within(panel()).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-watch'))).toEqual(['wat_a', 'wat_b', 'wat_c']);
    expect(items[0]!.textContent).toContain('home-assistant · estado_entidad');
    expect(items[0]!.textContent).toContain('state is "on" for at least 10 min');
    expect(items[0]!.textContent).toContain('every 60s');
    expect(items[0]!.textContent).toContain('Firing');
    expect(items[0]!.textContent).toContain('Last fired 17/11 21:05');
    expect(items[0]!.textContent).toContain('By the assistant');
    expect(items[0]!.textContent).toContain('active');
    expect(items[1]!.textContent).toContain('value above 30');
    expect(items[1]!.textContent).toContain('paused');
    expect(items[1]!.textContent).toContain('Cannot check');
    expect(items[1]!.textContent).not.toContain('By the assistant');
    expect(items[2]!.textContent).toContain('state changes');
    expect(items[2]!.textContent).toContain('Suspended');
  });

  it('vacío: explica de dónde salen los vigilantes', async () => {
    await withPanel();
    await waitFor(() => expect(panel().querySelector('[data-e2e="watches-empty"]')).not.toBeNull());
    expect(panel().textContent).toContain('stratum watches add');
    // Crear no está en Dot.
    expect(within(panel()).queryByRole('button', { name: /add|create|new/i })).toBeNull();
  });

  it('pausar lo pide al daemon y vuelve a pedir la lista (sin optimismo)', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a' })]));
    await withPanel(native);
    native.calls.watchesList.mockClear();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a', status: 'paused' })]));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pause Lluvia en Madrid' }));
    await waitFor(() => expect(native.calls.watchesPause).toHaveBeenCalledWith('wat_a'));
    await waitFor(() => expect(native.calls.watchesList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Resume Lluvia en Madrid' })).toBeTruthy());
  });

  it('reanudar lo pide al daemon y vuelve a pedir la lista', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a', status: 'paused' })]));
    await withPanel(native);
    native.calls.watchesList.mockClear();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a' })]));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Resume Lluvia en Madrid' }));
    await waitFor(() => expect(native.calls.watchesResume).toHaveBeenCalledWith('wat_a'));
    await waitFor(() => expect(native.calls.watchesList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Pause Lluvia en Madrid' })).toBeTruthy());
  });

  it('quitar pide confirmación en la página y luego vuelve a pedir la lista', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a' })]));
    await withPanel(native);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove Lluvia en Madrid' }));
    // Todavía no se ha pedido nada.
    expect(native.calls.watchesRemove).not.toHaveBeenCalled();
    const confirm = within(panel()).getByRole('group', { name: 'Remove Lluvia en Madrid' });
    // «Keep» la descarta sin llamar.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep' }));
    expect(native.calls.watchesRemove).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove Lluvia en Madrid' }));
    native.calls.watchesList.mockClear();
    native.calls.watchesList.mockResolvedValue(list([]));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove watch' }));
    await waitFor(() => expect(native.calls.watchesRemove).toHaveBeenCalledWith('wat_a'));
    await waitFor(() => expect(native.calls.watchesList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(panel().querySelector('[data-e2e="watches-empty"]')).not.toBeNull());
  });

  it('un resultado desconocido se dice y no se reintenta solo', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a' })]));
    await withPanel(native);
    native.calls.watchesPause.mockRejectedValue({
      kind: 'unknown',
      code: null,
      reason: null,
      message: 'no answer',
    });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Pause Lluvia en Madrid' }));
    await waitFor(() => expect(within(panel()).getByRole('alert').textContent).toContain('Result unknown'));
    const calls = native.calls.watchesPause.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(native.calls.watchesPause).toHaveBeenCalledTimes(calls);
    // Sigue como estaba: no se pinta como pausado.
    expect(within(panel()).getByRole('button', { name: 'Pause Lluvia en Madrid' })).toBeTruthy();
  });

  it('con el almacén en solo lectura, aviso y sin botones que cambien', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a' })], true));
    await withPanel(native);
    expect(within(panel()).getByText(/can see the watches, not change them/)).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Pause Lluvia en Madrid' }).hasAttribute('disabled')).toBe(true);
    expect(within(panel()).getByRole('button', { name: 'Remove Lluvia en Madrid' }).hasAttribute('disabled')).toBe(true);
  });

  it('sin capacidad de conducir los botones están deshabilitados', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockResolvedValue(list([sampleWatch({ id: 'wat_a' })]));
    await withPanel(native, ['observe']);
    expect(within(panel()).getByRole('button', { name: 'Pause Lluvia en Madrid' }).hasAttribute('disabled')).toBe(true);
    expect(within(panel()).getByRole('button', { name: 'Remove Lluvia en Madrid' }).hasAttribute('disabled')).toBe(true);
  });

  it('sin planificador, se dice', async () => {
    const native = fakeNative();
    native.calls.watchesList.mockRejectedValue(daemonError('UNAVAILABLE', 'no watches', 'watches-disabled'));
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('no scheduler'));
  });
});

describe('el aviso de un vigilante', () => {
  const notice = (n: unknown) =>
    ({ type: 'watch.notice', seq: 5, data: { notice: n } }) as Record<string, unknown>;

  it('refresca la lista y avisa una sola vez aunque llegue duplicado', async () => {
    const native = await withPanel();
    const fired = sampleWatchNotice({ name: 'Calor', text: 'Value above 30: 31.' });
    native.calls.watchesList.mockClear();
    act(() => {
      native.push({ type: 'events', sessionId: 'ses_overview', events: [notice(fired), notice(fired)] });
    });
    await waitFor(() => expect(native.calls.notifyWatch).toHaveBeenCalledTimes(1));
    expect(native.calls.notifyWatch).toHaveBeenCalledWith('Watch · Calor', 'Value above 30: 31.');
    expect(native.calls.watchesList).toHaveBeenCalledTimes(1);
    // Repetido por otra tanda: no se avisa otra vez.
    act(() => {
      native.push({ type: 'events', sessionId: 'ses_overview', events: [notice(fired)] });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.notifyWatch).toHaveBeenCalledTimes(1);
  });

  it('cada clase tiene su título', async () => {
    const native = await withPanel();
    act(() => {
      native.push({
        type: 'events',
        sessionId: 'ses_overview',
        events: [
          notice(sampleWatchNotice({ kind: 'resolved', at: 1, text: 'Back to normal.' })),
          notice(sampleWatchNotice({ kind: 'failing', at: 2, text: 'Cannot check.' })),
          notice(sampleWatchNotice({ kind: 'suspended', at: 3, text: 'Paused.' })),
        ],
      });
    });
    await waitFor(() => expect(native.calls.notifyWatch).toHaveBeenCalledTimes(3));
    const titles = native.calls.notifyWatch.mock.calls.map((c) => c[0]);
    expect(titles).toEqual([
      'Watch resolved · Lluvia en Madrid',
      'Watch cannot check · Lluvia en Madrid',
      'Watch paused by Stratum · Lluvia en Madrid',
    ]);
  });

  it('lo que no valida no avisa', async () => {
    const native = await withPanel();
    act(() => {
      native.push({
        type: 'events',
        sessionId: 'ses_overview',
        events: [{ type: 'watch.notice', data: { notice: { watchId: 'wat_bad' } } }, { type: 'run.started', data: {} }],
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.notifyWatch).not.toHaveBeenCalled();
  });

  it('el clic abre la pestaña Watches', async () => {
    const native = await withPanel();
    act(() => {
      native.push({ type: 'open-view', view: 'watches' });
    });
    expect(useUi.getState().view).toBe('assistant');
    expect(useUi.getState().assistantTab).toBe('watches');
    expect(useWatches.getState().watches).toEqual([]);
  });
});
