import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { HOME_VIEW, useUi } from '../stores/uiStore';
import { NARROW_QUERY } from '../screens/Assistant';
import { App } from './App';
import {
  CONNECTED,
  NEW_SID,
  fakeNative,
  hostedIdle,
  resetStores,
  sampleApproval,
  sampleSession,
  snapshotOf,
  type FakeNative,
} from '../testing/fixtures';

/**
 * Cierre de M14 (PRD de Dot §23.8): el asistente es la vista de inicio, se
 * empieza una conversación nueva de forma explícita y, en una ventana estrecha,
 * la conversación y los paneles van en pestañas.
 */

const FRESH_SID = 'ses_20261104_fresh01';

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(native: FakeNative) {
  return render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
}

/** Conectado, en la vista *Asistente*, con su sesión publicada (en reposo o trabajando). */
async function withAssistant(native = fakeNative(), running = false): Promise<FakeNative> {
  act(() => useUi.setState({ view: 'assistant' }));
  mount(native);
  act(() => {
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'sessions', sessionIds: [] });
  });
  await waitFor(() => expect(useUi.getState().companionId).toBe(NEW_SID));
  act(() => {
    native.push({ type: 'sessions', sessionIds: [NEW_SID] });
    native.push({
      type: 'snapshot',
      sessionId: NEW_SID,
      snapshot: running
        ? snapshotOf(
            {},
            {
              id: NEW_SID,
              agent: 'companion',
              state: 'running',
              host: { kind: 'daemon', client: 'daemon', connected: true },
            },
            { id: 'run_1', sessionId: NEW_SID, status: 'running' },
          )
        : hostedIdle({}, { agent: 'companion' }),
    });
  });
  return native;
}

/** Simula una ventana estrecha (o ancha) para `matchMedia`. */
function stubWidth(narrow: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query === NARROW_QUERY ? narrow : false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

describe('el asistente es la vista de inicio', () => {
  it('Dot arranca en el asistente; Esc fuera de él vuelve a él', () => {
    expect(HOME_VIEW).toBe('assistant');
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(useUi.getState().view).toBe('sessions');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUi.getState().view).toBe('assistant');
    // En el inicio, Esc oculta la ventana.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(native.calls.hideWindow).toHaveBeenCalled();
  });
  it('Ctrl+N desde el asistente abre un chat nuevo en la cabina', () => {
    const native = fakeNative();
    act(() => useUi.setState({ view: 'assistant' }));
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(useUi.getState()).toMatchObject({ view: 'sessions', composingNew: true });
  });
});

describe('conversación nueva', () => {
  it('se confirma en la página y pasa a la sesión que devuelve el daemon', async () => {
    const native = await withAssistant();
    native.calls.newCompanionConversation.mockResolvedValue({
      session: sampleSession({ id: FRESH_SID, agent: 'companion' }),
      archived: { sessionId: NEW_SID, memoryCarried: true },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    // Nada sale sin confirmar.
    expect(native.calls.newCompanionConversation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));
    await waitFor(() => expect(useUi.getState().companionId).toBe(FRESH_SID));
    expect(native.calls.newCompanionConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/what it remembered was carried over/)).toBeTruthy();
  });

  it('con el asistente trabajando no se ofrece; un rechazo se dice sin cambiar de sesión', async () => {
    const busy = await withAssistant(fakeNative(), true);
    expect(
      (
        screen.getByRole('button', {
          name: 'New conversation',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();
    resetStores();

    const native = await withAssistant();
    native.calls.newCompanionConversation.mockRejectedValue({
      kind: 'rejected',
      code: 'UNAVAILABLE',
      reason: 'compaction',
      message: 'The current conversation could not be compacted, so it was kept: memory model down',
    });
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('so it was kept'));
    expect(useUi.getState().companionId).toBe(NEW_SID);
    expect(busy.calls.newCompanionConversation).not.toHaveBeenCalled();
  });

  it('sin respuesta no se repite: se vuelve a pedir la del asistente, que es la que haya', async () => {
    const native = await withAssistant();
    native.calls.newCompanionConversation.mockRejectedValue({
      kind: 'unknown',
      code: null,
      reason: null,
      message: 'x',
    });
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }));
    await waitFor(() => expect(native.calls.openSession).toHaveBeenCalledTimes(2));
    expect(native.calls.newCompanionConversation).toHaveBeenCalledTimes(1);
    expect(native.calls.openSession).toHaveBeenLastCalledWith({
      agent: 'companion',
    });
  });
});

describe('ventana estrecha: pestañas', () => {
  it('una pestaña a la vez; Conversation avisa de lo que espera el asistente', async () => {
    stubWidth(true);
    const native = await withAssistant();
    const tab = (name: RegExp) => within(screen.getByRole('tablist', { name: 'Assistant' })).getByRole('tab', { name });
    expect(tab(/Conversation/).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('textbox', { name: 'Ask Stratum' })).toBeTruthy();
    expect(screen.queryByRole('complementary', { name: "Assistant's box" })).toBeNull();

    fireEvent.click(tab(/Box/));
    expect(screen.getByRole('complementary', { name: "Assistant's box" })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Ask Stratum' })).toBeNull();

    // Una aprobación pendiente se ve en la pestaña Conversation.
    act(() =>
      native.push({
        type: 'snapshot',
        sessionId: NEW_SID,
        snapshot: hostedIdle(
          {
            seq: 9,
            approvals: [sampleApproval({ sessionId: NEW_SID })],
          },
          { agent: 'companion' },
        ),
      }),
    );
    expect(tab(/Conversation/).textContent).toMatch(/1/);
  });

  it('en ancho, todo a la vez y sin pestañas', async () => {
    stubWidth(false);
    await withAssistant();
    expect(screen.queryByRole('tablist', { name: 'Assistant' })).toBeNull();
    expect(screen.getByRole('complementary', { name: "Assistant's box" })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Ask Stratum' })).toBeTruthy();
  });
});

describe('Dot compacto (PRD §8.2)', () => {
  it('lo escrito llega como un run del asistente, una vez, y lleva a su vista', async () => {
    const native = await withAssistant();
    act(() => useUi.getState().setView('sessions'));
    act(() => native.push({ type: 'ask', text: 'recuérdame comprar pan' }));
    expect(useUi.getState().view).toBe('assistant');
    await waitFor(() => expect(native.calls.startRun).toHaveBeenCalledWith(NEW_SID, 'recuérdame comprar pan'));
    expect(native.calls.startRun).toHaveBeenCalledTimes(1);
    expect(useUi.getState().pendingAsk).toBeNull();
  });

  it('con el asistente trabajando es steering; si no sale, se queda en su campo', async () => {
    const native = await withAssistant(fakeNative(), true);
    native.calls.steerRun.mockRejectedValue({ kind: 'not-sent', code: null, reason: null, message: 'x' });
    act(() => native.push({ type: 'ask', text: 'y leche' }));
    await waitFor(() => expect(native.calls.steerRun).toHaveBeenCalledWith(NEW_SID, 'y leche'));
    expect(native.calls.startRun).not.toHaveBeenCalled();
    await waitFor(() => expect(useUi.getState().drafts[NEW_SID]).toBe('y leche'));
  });

  it('sin la sesión del asistente aún, espera a tenerla', async () => {
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'ask', text: 'hola' }));
    expect(useUi.getState()).toMatchObject({ view: 'assistant', pendingAsk: 'hola' });
    expect(native.calls.startRun).not.toHaveBeenCalled();
  });
});
