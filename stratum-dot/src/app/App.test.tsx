import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import {
  CONNECTED,
  SID,
  fakeNative,
  resetStores,
  runUpdated,
  sampleApproval,
  sampleRun,
  sampleToolCall,
  snapshotOf,
  stateEvent,
  type FakeNative,
} from '../testing/fixtures';

beforeEach(resetStores);
afterEach(cleanup);

function mount(native: FakeNative) {
  return render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
}

/** Dot conectado, con una sesión en marcha y seleccionada. */
function running(snapshot = snapshotOf()): FakeNative {
  const native = fakeNative();
  mount(native);
  act(() => {
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'sessions', sessionIds: [SID] });
    native.push({ type: 'snapshot', sessionId: SID, snapshot });
  });
  fireEvent.click(screen.getByRole('button', { name: /^Session / }));
  return native;
}

const badge = (name: string) => document.querySelectorAll(`[data-status="${name}"]`).length;

describe('overview', () => {
  it('enseña el estado del daemon, las sesiones y las versiones', () => {
    const native = fakeNative();
    mount(native);
    expect(screen.getByText('Starting…')).toBeTruthy();
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [SID] });
      native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    });
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByLabelText('1 live sessions').textContent).toBe('1 session');
    const row = screen.getByRole('button', { name: /^Session Implement authentication, running/ });
    expect(row.textContent).toContain('test-model');
    expect(row.textContent).toContain('/work/api');
    expect(row.textContent).toContain('cli (peer)');
    expect(screen.getByText(/daemon 0\.9\.0 · protocol/)).toBeTruthy();
  });

  it('una sesión del daemon y una par usan la misma fila: solo cambia el anfitrión', () => {
    const native = fakeNative();
    mount(native);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [SID, 'ses_d'] });
      native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
      native.push({
        type: 'snapshot',
        sessionId: 'ses_d',
        snapshot: snapshotOf(
          {},
          { id: 'ses_d', title: 'Hosted task', host: { kind: 'daemon', client: 'daemon', connected: true } },
          { sessionId: 'ses_d' },
        ),
      });
    });
    const rows = screen.getAllByRole('button', { name: /^Session / });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.className)).toEqual(['row', 'row']);
    expect(rows.map((r) => r.querySelector('[data-host]')?.getAttribute('data-host'))).toEqual(['peer', 'daemon']);
  });

  it('H. detached se ve como detached, no como error', () => {
    running(snapshotOf({}, { state: 'detached', host: { kind: 'peer', client: 'cli', connected: false } }));
    expect(badge('detached')).toBeGreaterThan(0);
    expect(badge('failed')).toBe(0);
    expect(screen.getByText(/this is not a\s+failure/)).toBeTruthy();
    // Sin anfitrión no se puede conducir: los controles están, deshabilitados.
    expect((screen.getByRole('button', { name: 'Pause run' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.tone-bad')).toBeNull();
  });
});

describe('controles: el protocolo manda', () => {
  it('I. Pause envía la orden y no marca la UI como pausada hasta que llega el evento', async () => {
    const native = running();
    fireEvent.click(screen.getByRole('button', { name: 'Pause run' }));
    await waitFor(() => expect(screen.getByText('Pause requested…')).toBeTruthy());
    expect(native.calls.pauseRun).toHaveBeenCalledWith(SID, 'run_1');
    // Pedida no es alcanzada: el estado sigue siendo el que publicó el anfitrión.
    expect(badge('running')).toBeGreaterThan(0);
    expect(badge('paused')).toBe(0);
    expect(screen.queryByRole('button', { name: 'Resume run' })).toBeNull();

    // El runtime alcanza el punto seguro y lo publica.
    act(() => native.push({ type: 'events', sessionId: SID, events: [runUpdated(4, 'paused')] }));
    expect(badge('paused')).toBeGreaterThan(0);
    expect(screen.queryByText('Pause requested…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeTruthy();
  });

  it('Resume espera igual al estado de verdad', async () => {
    const native = running(snapshotOf({}, { state: 'paused' }, { status: 'paused' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume run' }));
    await waitFor(() => expect(screen.getByText('Resume requested…')).toBeTruthy());
    expect(native.calls.resumeRun).toHaveBeenCalledWith(SID, 'run_1');
    expect(badge('paused')).toBeGreaterThan(0);
    act(() => native.push({ type: 'events', sessionId: SID, events: [runUpdated(4, 'running')] }));
    expect(badge('running')).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Pause run' })).toBeTruthy();
  });

  it('J. steer con el run en pausa: aceptado, y sigue en pausa', async () => {
    const native = running(snapshotOf({}, { state: 'paused' }, { status: 'paused' }));
    const input = screen.getByRole('textbox', { name: /Steer this run/ }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'mejor resume el README' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send steering message' }));
    await waitFor(() => expect(screen.getByText(/still paused: resume it/)).toBeTruthy());
    expect(native.calls.steerRun).toHaveBeenCalledWith(SID, 'mejor resume el README');
    expect(input.value).toBe('');
    expect(badge('paused')).toBeGreaterThan(0);
    expect(native.calls.resumeRun).not.toHaveBeenCalled();
  });

  it('un mensaje que no se pudo enviar no se pierde del campo', async () => {
    const native = running();
    native.calls.steerRun.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'UNAVAILABLE',
      reason: 'host-unavailable',
      message: 'x',
    });
    const input = screen.getByRole('textbox', { name: /Steer this run/ }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send steering message' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/host is not connected/));
    expect(input.value).toBe('hola');
  });

  it('Cancel pide confirmación y no quita la sesión hasta que el anfitrión lo dice', async () => {
    const native = running();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(native.calls.cancelRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel run' }));
    await waitFor(() => expect(screen.getByText('Cancel requested…')).toBeTruthy());
    expect(native.calls.cancelRun).toHaveBeenCalledWith(SID, 'run_1');
    expect(badge('running')).toBeGreaterThan(0);

    act(() =>
      native.push({
        type: 'events',
        sessionId: SID,
        events: [stateEvent(4, 'run.cancelled', { run: sampleRun({ status: 'cancelled', stopReason: 'cancelled' }) })],
      }),
    );
    // La sesión sigue en la lista; lo que cambió es su run.
    expect(screen.getAllByRole('button', { name: /^Session / })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Pause run' })).toBeNull();
    expect(screen.getByText('Run cancelled')).toBeTruthy();
  });

  it('una orden con resultado desconocido se dice, y el estado no se toca', async () => {
    const native = running();
    native.calls.pauseRun.mockRejectedValueOnce({
      kind: 'unknown',
      code: null,
      reason: null,
      message: 'The connection was lost before the daemon answered.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Pause run' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/connection was lost/));
    expect(screen.queryByText('Pause requested…')).toBeNull();
    expect(badge('running')).toBeGreaterThan(0);
  });

  it('sin conexión se conserva lo último conocido y los controles no se pueden pulsar', () => {
    const native = running();
    act(() => native.push({ type: 'connection', state: { kind: 'reconnecting', attempt: 3 } }));
    expect(screen.getByText(/Reconnecting \(attempt 3\)/)).toBeTruthy();
    expect(screen.getByText(/· last known/)).toBeTruthy();
    // La interfaz no se vació.
    expect(screen.getAllByRole('button', { name: /^Session / })).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Pause run' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });
});

describe('detalle', () => {
  it('enseña lo pendiente y lleva al centro (sin resolverlo en el chat), y las tools sin decir «ejecutando»', () => {
    running(
      snapshotOf({
        approvals: [sampleApproval()],
        toolCalls: [sampleToolCall({ state: 'running', description: 'git push origin main' })],
        partial: { text: 'Voy a subir los cambios', reasoning: '' },
      }),
    );
    const pending = screen.getByRole('region', { name: 'Waiting for you' });
    expect(pending.textContent).toContain('git push origin main');
    // En el chat no se resuelve: solo se lleva al centro de aprobaciones.
    expect(screen.queryByRole('button', { name: /approve|deny|allow/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^Open in the Approval Center/ })).toBeTruthy();
    // En el chat, lo que se está escribiendo; en Activity, las tools del run.
    expect(screen.getByText('Voy a subir los cambios')).toBeTruthy();
    expect(screen.getByText(/1 pending/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    const tools = screen.getByRole('list', { name: 'Tool calls' });
    expect(tools.textContent).toContain('Active');
    expect(document.body.textContent).not.toMatch(/Executing/i);
    expect(screen.getByRole('region', { name: 'Waiting for you' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve|deny|allow/i })).toBeNull();
  });

  it('Activity sigue ahí: el run, el anfitrión y lo último que pasó', () => {
    const native = running();
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(screen.getByText('Directory')).toBeTruthy();
    act(() => native.push({ type: 'events', sessionId: SID, events: [runUpdated(4, 'paused')] }));
    expect(screen.getByRole('list', { name: 'Recent activity' }).textContent).toContain('Run paused');
    // El campo de escritura y los controles son los mismos en las dos pestañas.
    expect(screen.getByRole('textbox', { name: /Steer this run/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume run' })).toBeTruthy();
  });

  it('no enseña botones de cosas que Dot aún no hace', () => {
    running();
    for (const name of [/attach/i, /trace/i, /close session/i, /approve/i, /stop daemon/i, /history/i, /memory/i]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('conexión', () => {
  it('protocolo incompatible: lo dice claro y no enseña sesiones', () => {
    const native = fakeNative();
    mount(native);
    act(() =>
      native.push({
        type: 'connection',
        state: { kind: 'incompatible', clientProtocol: 1, daemonProtocol: 2, daemonVersion: '1.0.0' },
      }),
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Incompatible Stratum daemon');
    expect(alert.textContent).toContain('Dot supports protocol 1');
    expect(alert.textContent).toContain('Daemon uses protocol 2');
    fireEvent.click(screen.getByRole('button', { name: 'Check the daemon again' }));
    expect(native.calls.retry).toHaveBeenCalledTimes(1);
  });

  it('error: el mensaje y un Retry', () => {
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'connection', state: { kind: 'error', message: 'The Stratum daemon is not running.' } }));
    expect(screen.getByRole('alert').textContent).toContain('The Stratum daemon is not running.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry connecting to the daemon' }));
    expect(native.calls.retry).toHaveBeenCalledTimes(1);
  });

  it('Quit Dot solo cierra Dot', () => {
    const native = running();
    fireEvent.click(screen.getByRole('button', { name: /Quit Stratum Dot/ }));
    expect(native.calls.quit).toHaveBeenCalledTimes(1);
    expect(native.calls.cancelRun).not.toHaveBeenCalled();
  });
});

describe('teclado y resistencia', () => {
  it('Ctrl+K lleva al campo de steering; Esc lo suelta y, después, oculta la ventana', () => {
    const native = running();
    const input = screen.getByRole('textbox', { name: /Steer this run/ });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).not.toBe(input);
    expect(native.calls.hideWindow).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(native.calls.hideWindow).toHaveBeenCalledTimes(1);
  });

  it('algo que falla al pintarse no deja la ventana en blanco', () => {
    const Boom = () => {
      throw new Error('dato inesperado');
    };
    const quiet = console.error;
    console.error = () => undefined;
    try {
      render(
        <ErrorBoundary fallback={(error) => <p role="alert">No se pudo pintar: {error.message}</p>}>
          <Boom />
        </ErrorBoundary>,
      );
    } finally {
      console.error = quiet;
    }
    expect(screen.getByRole('alert').textContent).toBe('No se pudo pintar: dato inesperado');
  });
});

describe('M9 — vista parcial', () => {
  it('con más sesiones vivas de las que Dot sigue, la lista dice que es parcial', () => {
    const native = fakeNative();
    mount(native);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [SID], unfollowed: 6 });
      native.push({ type: 'snapshot', sessionId: SID, snapshot: snapshotOf() });
    });
    const note = document.querySelector<HTMLElement>('[data-partial]')!;
    expect(note.dataset.partial).toBe('6');
    expect(note.textContent).toContain('Partial view: 6 more live sessions are not shown');
    act(() => native.push({ type: 'sessions', sessionIds: [SID], unfollowed: 0 }));
    expect(document.querySelector('[data-partial]')).toBeNull();
  });
});
