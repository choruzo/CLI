import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { useRoutines } from '../stores/routineStore';
import { useUi } from '../stores/uiStore';
import { App } from './App';
import {
  CONNECTED,
  NEW_SID,
  fakeNative,
  hostedIdle,
  resetStores,
  sampleRoutine,
  sampleRun,
  stateEvent,
  type FakeNative,
} from '../testing/fixtures';

/**
 * M16 — las rutinas del asistente en Dot (PRD §23.5): el panel de la vista
 * *Asistente*, la marca en la lista de sesiones y el aviso del sistema. Todo
 * sale de lo que contesta el daemon; nada de estado supuesto.
 */

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ROUTINE_SID = 'ses_20261013_rout01';

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

const panel = () => screen.getByRole('region', { name: 'Routines' });
const openAssistant = () => fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));

async function withPanel(native = fakeNative()): Promise<FakeNative> {
  connected(native);
  openAssistant();
  await waitFor(() => expect(native.calls.routinesList).toHaveBeenCalled());
  return native;
}

const daemonError = (code: string, message: string, reason: string | null = null) => ({
  kind: 'rejected',
  code,
  reason,
  message,
});

describe('panel Rutinas', () => {
  it('lista lo que contesta routines.list: horario, siguiente, estado y último resultado', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({
      readOnly: false,
      routines: [
        sampleRoutine({
          sessionId: ROUTINE_SID,
          lastResult: {
            runId: 'run_9',
            sessionId: ROUTINE_SID,
            status: 'completed',
            endedAt: 1_760_000_100_000,
            summary: 'Three emails need an answer.',
          },
        }),
        sampleRoutine({
          id: 'rt_second',
          origin: 'agent',
          name: 'Weekly report',
          schedule: '0 9 * * 1',
          enabled: false,
          nextFireAt: null,
          scheduleError: 'Cron "0 9 * * 1" has no next date.',
        }),
      ],
    });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Morning summary'));
    expect(panel().textContent).toContain('1d');
    expect(panel().textContent).toContain('Three emails need an answer.');
    expect(panel().textContent).toContain('Finished');
    expect(panel().textContent).toContain('Weekly report');
    // Solo la propuesta por el asistente lo dice.
    expect(panel().textContent?.match(/Proposed by the assistant/g)).toHaveLength(1);
    expect(panel().textContent).toContain('not scheduled (disabled)');
    expect(panel().textContent).toContain('Cron "0 9 * * 1" has no next date.');
    // El siguiente vencimiento, en hora local.
    expect(panel().textContent).toContain(new Date(1_760_086_400_000).toLocaleString());
  });

  it('sin rutinas lo dice; con el almacén en solo lectura, avisa y no deja cambiar nada', async () => {
    const empty = await withPanel();
    await waitFor(() => expect(panel().textContent).toContain('No routines yet.'));
    expect((screen.getByRole('button', { name: 'New routine' }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    resetStores();

    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [sampleRoutine()], readOnly: true });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('you can see the routines, not change them'));
    expect((screen.getByRole('button', { name: 'New routine' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Run Morning summary now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(empty.calls.routinesAdd).not.toHaveBeenCalled();
  });

  it('un daemon sin planificador lo explica', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockRejectedValue(
      daemonError('UNAVAILABLE', 'Routines are disabled.', 'routines-disabled'),
    );
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('it has no scheduler'));
    expect((screen.getByRole('button', { name: 'New routine' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('crear: un horario inválido se pinta junto a su campo y no cierra el formulario', async () => {
    const native = fakeNative();
    native.calls.routinesAdd.mockRejectedValueOnce(
      daemonError('INVALID_PARAMS', 'Invalid schedule: "someday" is not an interval or a cron expression.'),
    );
    await withPanel(native);
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
    const form = screen.getByRole('form', { name: 'New routine' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Digest' } });
    fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: 'someday' } });
    fireEvent.change(within(form).getByLabelText('Prompt'), { target: { value: 'Summarise my mail' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }));

    await waitFor(() => expect(native.calls.routinesAdd).toHaveBeenCalledTimes(1));
    expect(native.calls.routinesAdd).toHaveBeenCalledWith({
      name: 'Digest',
      schedule: 'someday',
      prompt: 'Summarise my mail',
    });
    const alert = await within(form).findByText(/Invalid schedule/);
    // Junto al campo del horario, no en otro.
    expect(alert.closest('label')?.textContent).toContain('Schedule');
    expect(screen.getByRole('form', { name: 'New routine' })).toBeTruthy();
    // Sin estado optimista: no se pintó ninguna rutina nueva.
    expect(native.calls.routinesList).toHaveBeenCalledTimes(1);

    // Corregido, el daemon la crea: la respuesta se pinta y el formulario se cierra.
    fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: '1d' } });
    native.calls.routinesAdd.mockResolvedValueOnce({
      routine: sampleRoutine({ id: 'rt_new', name: 'Digest', schedule: '1d' }),
    });
    native.calls.routinesList.mockResolvedValue({
      routines: [sampleRoutine({ id: 'rt_new', name: 'Digest', schedule: '1d' })],
      readOnly: false,
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'New routine' })).toBeNull());
    expect(panel().textContent).toContain('Digest');
  });

  it('crear: lo que falta ni siquiera sale hacia el daemon', async () => {
    const native = await withPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
    const form = screen.getByRole('form', { name: 'New routine' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }));
    expect(within(form).getByText('Give the routine a name.')).toBeTruthy();
    expect(within(form).getByText('Say when it runs.')).toBeTruthy();
    expect(native.calls.routinesAdd).not.toHaveBeenCalled();
  });

  it('crear sin respuesta: «Result unknown», sin repetirse', async () => {
    const native = fakeNative();
    native.calls.routinesAdd.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'no answer' });
    await withPanel(native);
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
    const form = screen.getByRole('form', { name: 'New routine' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Digest' } });
    fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: '1d' } });
    fireEvent.change(within(form).getByLabelText('Prompt'), { target: { value: 'x' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create routine' }));
    await within(form).findByText(/Result unknown/);
    expect(native.calls.routinesAdd).toHaveBeenCalledTimes(1);
    // No se dio por creada.
    expect(useRoutines.getState().routines).toEqual([]);
  });

  it('editar solo envía lo que cambió, y quitar el modelo es clearModel', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({
      routines: [sampleRoutine({ model: 'big-model', limits: { maxIterations: 20 } })],
      readOnly: false,
    });
    await withPanel(native);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Morning summary' }));
    const form = screen.getByRole('form', { name: 'Edit Morning summary' });
    fireEvent.change(within(form).getByLabelText('Schedule'), { target: { value: '2h' } });
    fireEvent.change(within(form).getByLabelText('Model'), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Max iterations'), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(native.calls.routinesUpdate).toHaveBeenCalledTimes(1));
    expect(native.calls.routinesUpdate).toHaveBeenCalledWith('rt_abc1234567', {
      schedule: '2h',
      clearModel: true,
      clearLimits: true,
    });
  });

  it('Run now: «skipped-busy» se dice tal cual y la lista se relee', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [sampleRoutine({ running: true })], readOnly: false });
    native.calls.routinesRun.mockResolvedValue({
      fire: { at: 1_760_000_000_000, outcome: 'skipped-busy', manual: true },
      routine: sampleRoutine({ running: true }),
    });
    await withPanel(native);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Morning summary now' }));
    await waitFor(() => expect(native.calls.routinesRun).toHaveBeenCalledWith('rt_abc1234567'));
    await waitFor(() => expect(panel().textContent).toContain('Skipped: the previous run was still going.'));
    expect(panel().textContent).toContain('Running now');
    await waitFor(() => expect(native.calls.routinesList).toHaveBeenCalledTimes(2));
  });

  it('Run now sin respuesta: «Result unknown» y una sola petición', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [sampleRoutine()], readOnly: false });
    native.calls.routinesRun.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'no answer' });
    await withPanel(native);
    fireEvent.click(await screen.findByRole('button', { name: 'Run Morning summary now' }));
    await waitFor(() => expect(panel().textContent).toContain('Result unknown'));
    expect(native.calls.routinesRun).toHaveBeenCalledTimes(1);
  });

  it('activar o desactivar es un routines.update de enabled', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [sampleRoutine()], readOnly: false });
    native.calls.routinesUpdate.mockResolvedValue({ routine: sampleRoutine({ enabled: false, nextFireAt: null }) });
    await withPanel(native);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Morning summary' }));
    await waitFor(() =>
      expect(native.calls.routinesUpdate).toHaveBeenCalledWith('rt_abc1234567', { enabled: false }),
    );
  });

  it('borrar pide confirmación dentro de la página y quita también su sesión', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValueOnce({
      routines: [sampleRoutine({ sessionId: ROUTINE_SID })],
      readOnly: false,
    });
    await withPanel(native);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Morning summary' }));
    // Hasta confirmar no sale nada.
    expect(native.calls.routinesRemove).not.toHaveBeenCalled();
    expect(panel().textContent).toContain('and its conversation?');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(native.calls.routinesRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }));
    await waitFor(() => expect(native.calls.routinesRemove).toHaveBeenCalledWith('rt_abc1234567'));
    await waitFor(() => expect(panel().textContent).toContain('No routines yet.'));
    expect(panel().textContent).not.toContain('Morning summary');
  });

  it('Open abre la sesión de la rutina como cualquier otra', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({
      routines: [sampleRoutine({ sessionId: ROUTINE_SID }), sampleRoutine({ id: 'rt_none', name: 'Never run' })],
      readOnly: false,
    });
    await withPanel(native);
    // Sin sesión todavía (no se ha disparado) no hay a qué abrir.
    await screen.findByText('Never run');
    expect(screen.queryByRole('button', { name: 'Open the conversation of Never run' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Open the conversation of Morning summary' }));
    expect(useUi.getState().selectedId).toBe(ROUTINE_SID);
    expect(useUi.getState().view).toBe('sessions');
    await waitFor(() => expect(native.calls.focusSession).toHaveBeenCalledWith(ROUTINE_SID));
  });
});

describe('marca de sesión de rutina', () => {
  it('«Routine · nombre» con la lista conocida, «Routine» sin ella, y nada en las demás', () => {
    const native = connected();
    act(() => {
      native.push({ type: 'sessions', sessionIds: [ROUTINE_SID, NEW_SID] });
      native.push({
        type: 'snapshot',
        sessionId: ROUTINE_SID,
        snapshot: hostedIdle({}, { id: ROUTINE_SID, agent: 'companion', routineId: 'rt_abc1234567' }),
      });
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle({}, { agent: 'general' }) });
    });
    const marks = () => Array.from(document.querySelectorAll('[data-e2e="routine-mark"]')).map((e) => e.textContent);
    expect(marks()).toEqual(['Routine']);
    act(() => useRoutines.getState().setList([sampleRoutine()], false));
    expect(marks()).toEqual(['Routine · Morning summary']);
  });
});

describe('aviso del sistema al terminar una rutina', () => {
  function routineSession(native: FakeNative) {
    act(() => {
      native.push({ type: 'sessions', sessionIds: [ROUTINE_SID] });
      native.push({
        type: 'snapshot',
        sessionId: ROUTINE_SID,
        snapshot: hostedIdle({ seq: 3 }, { id: ROUTINE_SID, agent: 'companion', routineId: 'rt_abc1234567' }),
      });
    });
  }
  const finished = (seq: number, type = 'run.completed') =>
    stateEvent(seq, type, { run: sampleRun({ id: 'run_77', sessionId: ROUTINE_SID, status: 'completed' }) }, ROUTINE_SID);
  const routineWithResult = () =>
    sampleRoutine({
      sessionId: ROUTINE_SID,
      lastResult: {
        runId: 'run_77',
        sessionId: ROUTINE_SID,
        status: 'completed',
        endedAt: 1_760_000_100_000,
        summary: 'Three emails need an answer.',
      },
    });

  it('avisa una vez por run con el nombre, el estado y el resumen, y refresca la lista', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [routineWithResult()], readOnly: false });
    connected(native);
    routineSession(native);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    act(() => native.push({ type: 'events', sessionId: ROUTINE_SID, events: [finished(4)] }));
    await waitFor(() => expect(native.calls.notifyRoutine).toHaveBeenCalledTimes(1));
    expect(native.calls.notifyRoutine).toHaveBeenCalledWith({
      title: 'Morning summary finished',
      body: 'Three emails need an answer.',
      sessionId: ROUTINE_SID,
    });
    expect(native.calls.routinesList).toHaveBeenCalled();

    // El mismo fin otra vez (una reconexión lo repite): no vuelve a avisar.
    const before = native.calls.routinesList.mock.calls.length;
    act(() => native.push({ type: 'events', sessionId: ROUTINE_SID, events: [finished(4)] }));
    await waitFor(() => expect(native.calls.routinesList.mock.calls.length).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.notifyRoutine).toHaveBeenCalledTimes(1);
  });

  it('no avisa con la ventana en primer plano y esa sesión delante', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [routineWithResult()], readOnly: false });
    connected(native);
    routineSession(native);
    act(() => useUi.getState().select(ROUTINE_SID));
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    act(() => native.push({ type: 'events', sessionId: ROUTINE_SID, events: [finished(4)] }));
    await waitFor(() => expect(native.calls.routinesList).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.notifyRoutine).not.toHaveBeenCalled();
  });

  it('con el foco pero en otra sesión, sí avisa; el inicio de un run solo refresca', async () => {
    const native = fakeNative();
    native.calls.routinesList.mockResolvedValue({ routines: [routineWithResult()], readOnly: false });
    connected(native);
    routineSession(native);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    act(() =>
      native.push({
        type: 'events',
        sessionId: ROUTINE_SID,
        events: [stateEvent(4, 'run.started', { run: sampleRun({ id: 'run_78', sessionId: ROUTINE_SID }) }, ROUTINE_SID)],
      }),
    );
    await waitFor(() => expect(native.calls.routinesList).toHaveBeenCalled());
    expect(native.calls.notifyRoutine).not.toHaveBeenCalled();

    act(() => native.push({ type: 'events', sessionId: ROUTINE_SID, events: [finished(5)] }));
    await waitFor(() => expect(native.calls.notifyRoutine).toHaveBeenCalledTimes(1));
  });

  it('una sesión que no es de una rutina no avisa ni refresca', async () => {
    const native = connected();
    act(() => {
      native.push({ type: 'sessions', sessionIds: [NEW_SID] });
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle({ seq: 3 }, { agent: 'general' }) });
    });
    act(() =>
      native.push({
        type: 'events',
        sessionId: NEW_SID,
        events: [stateEvent(4, 'run.completed', { run: sampleRun({ id: 'run_5', sessionId: NEW_SID }) }, NEW_SID)],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.calls.routinesList).not.toHaveBeenCalled();
    expect(native.calls.notifyRoutine).not.toHaveBeenCalled();
  });

  it('el evento «open-session» (se pulsó el aviso) solo selecciona la sesión', async () => {
    const native = connected();
    act(() => native.push({ type: 'open-session', sessionId: ROUTINE_SID }));
    expect(useUi.getState().selectedId).toBe(ROUTINE_SID);
    await waitFor(() => expect(native.calls.focusSession).toHaveBeenCalledWith(ROUTINE_SID));
    expect(native.calls.approve).not.toHaveBeenCalled();
    expect(native.calls.deny).not.toHaveBeenCalled();
  });
});
