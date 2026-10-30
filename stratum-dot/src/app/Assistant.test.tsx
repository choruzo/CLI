import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { useUi } from '../stores/uiStore';
import { App } from './App';
import {
  CONNECTED,
  NEW_SID,
  fakeNative,
  hostedIdle,
  resetStores,
  sampleBox,
  type FakeNative,
} from '../testing/fixtures';

/**
 * M14 — la vista *Asistente* (PRD de Dot §23.8): la conversación con el
 * `companion` y su caja, todo por el protocolo y sin estado supuesto.
 */

beforeEach(resetStores);
afterEach(cleanup);

function mount(native: FakeNative) {
  return render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
}

function connected(native = fakeNative()): FakeNative {
  mount(native);
  act(() => {
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'sessions', sessionIds: [] });
  });
  return native;
}

const openAssistant = () => fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
const boxPanel = () => screen.getByRole('complementary', { name: "Assistant's box" });

describe('vista Asistente', () => {
  it('pide la sesión del companion (sin directorio) y la pinta cuando el daemon la publica', async () => {
    const native = connected();
    openAssistant();
    await waitFor(() => expect(native.calls.openSession).toHaveBeenCalledTimes(1));
    expect(native.calls.openSession).toHaveBeenCalledWith({ agent: 'companion' });
    // Hasta que el daemon la publica no se inventa nada.
    expect(screen.getByText(/Opening the assistant/)).toBeTruthy();
    await waitFor(() => expect(native.calls.focusSession).toHaveBeenCalledWith(NEW_SID));
    expect(useUi.getState().companionId).toBe(NEW_SID);

    act(() => {
      native.push({ type: 'sessions', sessionIds: [NEW_SID] });
      native.push({
        type: 'snapshot',
        sessionId: NEW_SID,
        snapshot: hostedIdle({}, { agent: 'companion' }),
      });
    });
    expect(screen.getByRole('textbox', { name: 'Ask Stratum' })).toBeTruthy();
    // Volver a la vista no abre otra: la sesión ya es esta.
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    openAssistant();
    expect(native.calls.openSession).toHaveBeenCalledTimes(1);
  });

  it('si el daemon no lo abre, lo dice y solo reintenta cuando se pide', async () => {
    const native = fakeNative();
    native.calls.openSession.mockRejectedValueOnce({ kind: 'rejected', code: 'UNAVAILABLE', reason: null, message: 'Too many live sessions.' });
    connected(native);
    openAssistant();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Too many live sessions.'));
    expect(native.calls.openSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(native.calls.openSession).toHaveBeenCalledTimes(2));
  });

  it('la caja: enseña lo que contesta el daemon, y arrancar o parar es una orden', async () => {
    const native = connected();
    openAssistant();
    await waitFor(() => expect(boxPanel().getAttribute('data-box-state')).toBe('stopped'));
    expect(native.calls.boxStatus).toHaveBeenCalled();
    expect(boxPanel().textContent).toContain('/home/ana/.stratum/companion/exchange');

    fireEvent.click(screen.getByRole('button', { name: 'Start box' }));
    await waitFor(() => expect(boxPanel().getAttribute('data-box-state')).toBe('running'));
    expect(native.calls.boxStart).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Stop box' }));
    await waitFor(() => expect(boxPanel().getAttribute('data-box-state')).toBe('stopped'));
    expect(native.calls.boxStop).toHaveBeenCalledTimes(1);
    // Borrarla no es de Dot.
    expect(screen.queryByRole('button', { name: /reset|delete/i })).toBeNull();
  });

  it('un arranque sin respuesta no se da por hecho ni se repite', async () => {
    const native = fakeNative();
    native.calls.boxStart.mockRejectedValueOnce({ kind: 'unknown', code: null, reason: null, message: 'no answer' });
    connected(native);
    openAssistant();
    await waitFor(() => expect(boxPanel().getAttribute('data-box-state')).toBe('stopped'));
    fireEvent.click(screen.getByRole('button', { name: 'Start box' }));
    await waitFor(() => expect(boxPanel().textContent).toContain('Result unknown'));
    expect(boxPanel().getAttribute('data-box-state')).toBe('stopped');
    expect(native.calls.boxStart).toHaveBeenCalledTimes(1);
  });

  it('sin la caja habilitada para exec, lo explica', async () => {
    const native = fakeNative();
    native.calls.boxStatus.mockResolvedValue({ box: sampleBox({ enabled: false }) });
    connected(native);
    openAssistant();
    await waitFor(() => expect(boxPanel().textContent).toContain('box.enabled'));
  });

  it('sin runtime, la caja no se puede arrancar y se dice por qué', async () => {
    const native = fakeNative();
    native.calls.boxStatus.mockResolvedValue({
      box: sampleBox({ state: 'unavailable', runtime: null, reason: 'Neither Podman nor Docker is available.' }),
    });
    connected(native);
    openAssistant();
    await waitFor(() => expect(boxPanel().textContent).toContain('Neither Podman nor Docker'));
    expect((screen.getByRole('button', { name: 'Start box' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
