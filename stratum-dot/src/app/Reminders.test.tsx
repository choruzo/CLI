import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { useReminders } from '../stores/reminderStore';
import { useUi } from '../stores/uiStore';
import { App } from './App';
import {
  CONNECTED,
  fakeNative,
  resetStores,
  sampleReminder,
  type FakeNative,
} from '../testing/fixtures';

/**
 * M21 — los recordatorios del asistente en Dot (`docs/protocol.md` §30): el
 * panel de la vista *Asistente* y el aviso del sistema. Todo sale de lo que
 * contesta el daemon; nada de estado supuesto.
 */

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Aquí son las 10:00 del 17/11/2026, hora local. */
const NOW = new Date(2026, 10, 17, 10, 0, 0).getTime();

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
const panel = () => screen.getByRole('region', { name: 'Reminders' });

async function withPanel(native = fakeNative(), capabilities?: string[]): Promise<FakeNative> {
  connected(native, capabilities);
  openAssistant();
  await waitFor(() => expect(native.calls.remindersList).toHaveBeenCalled());
  return native;
}

const daemonError = (code: string, message: string, reason: string | null = null) => ({
  kind: 'rejected',
  code,
  reason,
  message,
});

const pending = (id: string, text: string, dueAt: number) => sampleReminder({ id, text, dueAt });
const ended = (id: string, text: string, status: 'delivered' | 'cancelled', endedAt: number, late = false) =>
  sampleReminder({ id, text, status, endedAt, late });

describe('el panel de recordatorios', () => {
  it('enseña los pendientes por hora, con su texto y la hora local', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockResolvedValue({
      reminders: [
        pending('rem_late', 'Llamar a Ana', new Date(2026, 10, 19, 9, 0).getTime()),
        pending('rem_today', 'Sacar la ropa', new Date(2026, 10, 17, 21, 30).getTime()),
        pending('rem_tomorrow', 'Pagar la luz', new Date(2026, 10, 18, 9, 0).getTime()),
      ],
      readOnly: false,
    });
    await withPanel(native);
    const list = within(panel()).getAllByRole('listitem');
    expect(list.map((li) => li.getAttribute('data-reminder'))).toEqual(['rem_today', 'rem_tomorrow', 'rem_late']);
    expect(list[0]!.textContent).toContain('today 21:30');
    expect(list[1]!.textContent).toContain('tomorrow 18/11 09:00');
    expect(list[2]!.textContent).toContain('19/11/2026 09:00');
    expect(within(panel()).getByText('Sacar la ropa')).toBeTruthy();
    expect(within(panel()).getAllByRole('button', { name: /Cancel the reminder/ })).toHaveLength(3);
  });

  it('lo entregado y lo cancelado van en «Recent», con «late» si lo fue', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockResolvedValue({
      reminders: [
        pending('rem_a', 'Pendiente', NOW + 3_600_000),
        ended('rem_b', 'Entregado tarde', 'delivered', NOW - 3_600_000, true),
        ended('rem_c', 'Cancelado', 'cancelled', NOW - 7_200_000),
        // Fuera de los 7 días que guarda el daemon.
        ended('rem_old', 'Viejo', 'delivered', NOW - 30 * 86_400_000),
      ],
      readOnly: false,
    });
    await withPanel(native);
    const recent = panel().querySelector('[data-e2e="reminders-recent"]') as HTMLElement;
    expect(recent.getAttribute('open')).toBeNull();
    fireEvent.click(within(recent).getByText('Recent'));
    const rows = [...recent.querySelectorAll('li')];
    expect(rows.map((li) => li.getAttribute('data-reminder'))).toEqual(['rem_b', 'rem_c']);
    expect(rows[0]!.textContent).toContain('Delivered · late');
    expect(rows[1]!.textContent).toContain('Cancelled');
    // El que ya no se guardaba no se enseña.
    expect(within(panel()).queryByText('Viejo')).toBeNull();
  });

  it('cancelar lo pide al daemon y vuelve a pedir la lista (sin optimismo)', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockResolvedValue({
      reminders: [pending('rem_a', 'Sacar la ropa', NOW + 3_600_000)],
      readOnly: false,
    });
    await withPanel(native);
    native.calls.remindersList.mockClear();
    native.calls.remindersList.mockResolvedValue({ reminders: [], readOnly: false });
    fireEvent.click(within(panel()).getByRole('button', { name: /Cancel the reminder Sacar la ropa/ }));
    await waitFor(() => expect(native.calls.remindersCancel).toHaveBeenCalledWith('rem_a'));
    await waitFor(() => expect(native.calls.remindersList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(panel()).getByText('No reminders pending.')).toBeTruthy());
  });

  it('un resultado desconocido se dice y no se reintenta solo', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockResolvedValue({
      reminders: [pending('rem_a', 'Sacar la ropa', NOW + 3_600_000)],
      readOnly: false,
    });
    await withPanel(native);
    native.calls.remindersCancel.mockRejectedValue({
      kind: 'unknown',
      code: null,
      reason: null,
      message: 'no answer',
    });
    fireEvent.click(within(panel()).getByRole('button', { name: /Cancel the reminder Sacar la ropa/ }));
    await waitFor(() => expect(within(panel()).getByRole('alert').textContent).toContain('Result unknown'));
    const calls = native.calls.remindersCancel.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(native.calls.remindersCancel).toHaveBeenCalledTimes(calls);
    // Sigue en la lista: no se pinta como cancelado.
    expect(native.calls.remindersList.mock.results.length).toBeGreaterThan(0);
    await waitFor(() => expect(within(panel()).getByText('Sacar la ropa')).toBeTruthy());
  });

  it('con el almacén en solo lectura, aviso y sin Cancel', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockResolvedValue({
      reminders: [pending('rem_a', 'Sacar la ropa', NOW + 3_600_000)],
      readOnly: true,
    });
    await withPanel(native);
    expect(within(panel()).getByText(/can see the reminders, not cancel them/)).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: /Cancel the reminder/ })).toBeNull();
  });

  it('sin capacidad de conducir no hay Cancel', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockResolvedValue({
      reminders: [pending('rem_a', 'Sacar la ropa', NOW + 3_600_000)],
      readOnly: false,
    });
    await withPanel(native, ['observe']);
    expect(within(panel()).queryByRole('button', { name: /Cancel the reminder/ })).toBeNull();
  });

  it('sin planificador, se dice', async () => {
    const native = fakeNative();
    native.calls.remindersList.mockRejectedValue(
      daemonError('UNAVAILABLE', 'no reminders', 'reminders-disabled'),
    );
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('no scheduler'));
  });
});

describe('el aviso de un recordatorio', () => {
  const due = (reminder: unknown) =>
    ({ type: 'reminder.due', sessionId: 'ses_companion', seq: 5, data: { reminder } }) as Record<string, unknown>;

  it('refresca la lista y avisa, una vez por id', async () => {
    const native = await withPanel();
    const reminder = sampleReminder({ id: 'rem_x', text: 'Sacar la ropa' });
    native.calls.remindersList.mockClear();
    act(() => {
      native.push({ type: 'events', sessionId: 'ses_companion', events: [due(reminder), due(reminder)] });
    });
    await waitFor(() => expect(native.calls.notifyReminder).toHaveBeenCalledTimes(1));
    expect(native.calls.notifyReminder).toHaveBeenCalledWith('Reminder', 'Sacar la ropa');
    expect(native.calls.remindersList).toHaveBeenCalledTimes(1);
    // Repetido por otra tanda: no se avisa otra vez.
    act(() => {
      native.push({ type: 'events', sessionId: 'ses_companion', events: [due(reminder)] });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.notifyReminder).toHaveBeenCalledTimes(1);
  });

  it('lo que no valida no avisa', async () => {
    const native = await withPanel();
    act(() => {
      native.push({
        type: 'events',
        sessionId: 'ses_companion',
        events: [{ type: 'reminder.due', data: { reminder: { id: 'rem_bad' } } }, { type: 'run.started', data: {} }],
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.notifyReminder).not.toHaveBeenCalled();
  });

  it('si se entregó tarde, el aviso lo dice, y el clic abre la pestaña Reminders', async () => {
    const native = await withPanel();
    const at = new Date(2026, 10, 17, 21, 30).getTime();
    act(() => {
      native.push({
        type: 'events',
        sessionId: 'ses_companion',
        events: [due(sampleReminder({ id: 'rem_late', text: 'Sacar la ropa', dueAt: at, late: true }))],
      });
    });
    await waitFor(() =>
      expect(native.calls.notifyReminder).toHaveBeenCalledWith('Reminder', 'Sacar la ropa (late: was due 21:30)'),
    );
    act(() => {
      native.push({ type: 'open-view', view: 'reminders' });
    });
    expect(useUi.getState().view).toBe('assistant');
    expect(useUi.getState().assistantTab).toBe('reminders');
    // La lista no se pinta a mano: la pone el daemon.
    expect(useReminders.getState().reminders).toEqual([]);
  });
});
