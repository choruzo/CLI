import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import { LIMITS, type ProtocolChatMessage } from '../protocol';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import { App } from './App';
import {
  CONNECTED,
  NEW_SID,
  SID,
  delta,
  fakeNative,
  hostedIdle,
  resetStores,
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

const AT = 1_760_000_003_000;

function user(id: string, text: string, runId = 'run_0'): ProtocolChatMessage {
  return { kind: 'user', id, runId, at: AT, text };
}
function assistant(id: string, text: string, runId = 'run_0'): ProtocolChatMessage {
  return { kind: 'assistant', id, runId, at: AT, text };
}

/** Lo que se ve de la conversación, en orden: `[tipo, texto]`. */
function shown(): Array<[string, string]> {
  return [...document.querySelectorAll('.messages > li')].map((li) => [
    li.getAttribute('data-kind') ?? '',
    (li.textContent ?? '').trim(),
  ]);
}

/** Dot conectado, con un chat del daemon parado y seleccionado. */
function chatting(snapshot = hostedIdle()): FakeNative {
  const native = fakeNative();
  mount(native);
  act(() => {
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'sessions', sessionIds: [NEW_SID] });
    native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot });
  });
  fireEvent.click(screen.getByRole('button', { name: /^Session / }));
  return native;
}

const newRun = (overrides = {}) => sampleRun({ id: 'run_new', sessionId: NEW_SID, input: 'hola', ...overrides });
const ev = (seq: number, type: string, data: unknown) => ({ ...stateEvent(seq, type, data, NEW_SID), runId: 'run_new' });
const push = (native: FakeNative, events: unknown[]) =>
  act(() => native.push({ type: 'events', sessionId: NEW_SID, events }));

const ask = () => screen.getByRole('textbox', { name: 'Ask Stratum' }) as HTMLTextAreaElement;

describe('chat nuevo', () => {
  it('abre una sesión del daemon por el protocolo y no inventa nada hasta que el daemon la publica', async () => {
    const native = fakeNative();
    mount(native);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    // Qué se puede elegir lo dice el daemon: Dot no lee ninguna configuración.
    await waitFor(() => expect(screen.getByRole('option', { name: 'Default (test-model)' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'big-model · local' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'reviewer' })).toBeTruthy());
    // Un perfil que solo se delega no vale como agente de la sesión.
    expect(screen.queryByRole('option', { name: 'helper' })).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'First message' }), { target: { value: 'hola' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

    await waitFor(() => expect(native.calls.startRun).toHaveBeenCalledWith(NEW_SID, 'hola'));
    // Sin tocar nada: sin directorio, sin perfil y sin modelo. Decide el daemon.
    expect(native.calls.openSession).toHaveBeenCalledWith({});
    expect(native.calls.focusSession).toHaveBeenCalledWith(NEW_SID);
    // La sesión aún no existe para Dot: ni en la lista ni en el store.
    expect(useSessions.getState().sessions[NEW_SID]).toBeUndefined();
    expect(screen.queryByRole('button', { name: /^Session / })).toBeNull();
    expect(screen.getByText('Opening session…')).toBeTruthy();

    // El daemon la publica: ahora sí.
    act(() => {
      native.push({ type: 'sessions', sessionIds: [NEW_SID] });
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle() });
    });
    expect(screen.getAllByRole('button', { name: /^Session / })).toHaveLength(1);
    // El mensaje salió, pero la conversación sigue siendo la de la foto.
    expect(shown()).toEqual([]);
    expect(screen.getByText('Sending…')).toBeTruthy();

    push(native, [ev(4, 'run.started', { run: newRun() })]);
    expect(shown()).toEqual([['user', 'hola']]);
    expect(screen.queryByText('Sending…')).toBeNull();
  });

  it('lo elegido viaja tal cual; el directorio es un texto que valida el daemon', async () => {
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => expect(screen.getByRole('option', { name: 'reviewer' })).toBeTruthy());

    fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), {
      target: { value: '  /work/api ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'local/big-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));

    await waitFor(() =>
      expect(native.calls.openSession).toHaveBeenCalledWith({
        cwd: '/work/api',
        agent: 'reviewer',
        provider: 'local',
        model: 'big-model',
      }),
    );
    // Sin primer mensaje no hay run.
    expect(native.calls.startRun).not.toHaveBeenCalled();
    // El directorio se recuerda como preferencia; la conversación, no.
    expect(useUi.getState().lastCwd).toBe('/work/api');
    expect(native.calls.listAgents).toHaveBeenCalledWith(undefined);
  });

  it('si abrir falla no queda una sesión fantasma, y lo escrito no se pierde', async () => {
    const native = fakeNative();
    native.calls.openSession.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'INVALID_PARAMS',
      reason: null,
      message: 'cwd is not an existing directory',
    });
    mount(native);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    const message = screen.getByRole('textbox', { name: 'First message' }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: 'analiza esto' } });
    fireEvent.keyDown(message, { key: 'Enter' });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not an existing directory'));
    expect(useUi.getState().selectedId).toBeNull();
    expect(useSessions.getState().order).toEqual([]);
    expect(native.calls.startRun).not.toHaveBeenCalled();
    expect(message.value).toBe('analiza esto');
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeTruthy();
  });

  it('daemon.maxSessions: el error del daemon se enseña tal cual', async () => {
    const native = fakeNative();
    native.calls.openSession.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'UNAVAILABLE',
      reason: null,
      message: 'Too many live sessions.',
    });
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Too many live sessions.'));
  });

  it('sin conexión no se puede abrir', () => {
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'connection', state: { kind: 'reconnecting', attempt: 1 } }));
    expect((screen.getByRole('button', { name: 'New chat' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('conversación', () => {
  it('enviar es un run nuevo; el texto llega por fragmentos y lo cierra message.completed', async () => {
    const native = chatting();
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
    fireEvent.change(ask(), { target: { value: 'hola' } });
    fireEvent.keyDown(ask(), { key: 'Enter' });
    await waitFor(() => expect(native.calls.startRun).toHaveBeenCalledWith(NEW_SID, 'hola'));
    expect(native.calls.steerRun).not.toHaveBeenCalled();
    await waitFor(() => expect(ask().value).toBe(''));
    // Nada optimista: ni mensaje, ni run en marcha, hasta que lo dice el anfitrión.
    expect(shown()).toEqual([]);
    expect(document.querySelectorAll('[data-status="running"]')).toHaveLength(0);
    expect(screen.getByText('Sending…')).toBeTruthy();

    push(native, [ev(4, 'run.started', { run: newRun() })]);
    expect(shown()).toEqual([['user', 'hola']]);
    expect(document.querySelectorAll('[data-status="running"]').length).toBeGreaterThan(0);

    push(native, [delta(4, 'Hola, ', NEW_SID), delta(4, 'soy Strat', NEW_SID)]);
    expect(shown()).toEqual([
      ['user', 'hola'],
      ['partial', 'Hola, soy Strat'],
    ]);

    // El bloque cerrado sustituye al parcial: no hay duplicado.
    push(native, [ev(5, 'message.completed', { text: 'Hola, soy Stratum.' })]);
    expect(shown()).toEqual([
      ['user', 'hola'],
      ['assistant', 'Hola, soy Stratum.'],
    ]);
    push(native, [ev(6, 'run.completed', { run: newRun({ status: 'completed', stopReason: 'stop' }) })]);
    expect(shown()).toHaveLength(2);
    // Otra vez parada: el campo vuelve a ser para preguntar.
    expect(ask().disabled).toBe(false);
  });

  it('Shift+Enter es una línea nueva, no un envío', () => {
    const native = chatting();
    fireEvent.change(ask(), { target: { value: 'una línea' } });
    fireEvent.keyDown(ask(), { key: 'Enter', shiftKey: true });
    expect(native.calls.startRun).not.toHaveBeenCalled();
  });

  it('fragmentos perdidos: el mensaje completo llega igual', () => {
    const native = chatting();
    push(native, [ev(4, 'run.started', { run: newRun() }), delta(4, 'Ho', NEW_SID)]);
    // Los demás fragmentos no llegan nunca; el cierre trae el texto entero.
    push(native, [ev(5, 'message.completed', { text: 'Hola completo' })]);
    expect(shown()).toEqual([
      ['user', 'hola'],
      ['assistant', 'Hola completo'],
    ]);
  });

  it('reconexión a mitad de un mensaje: la foto manda y no hay duplicados', () => {
    const native = chatting();
    push(native, [ev(4, 'run.started', { run: newRun() }), delta(4, 'Voy por la mit', NEW_SID)]);
    act(() => native.push({ type: 'connection', state: { kind: 'reconnecting', attempt: 1 } }));
    // Lo último conocido sigue en pantalla, y no se puede escribir.
    expect(shown()).toHaveLength(2);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);

    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({
        type: 'snapshot',
        sessionId: NEW_SID,
        snapshot: hostedIdle({
          seq: 9,
          run: newRun({ status: 'completed', stopReason: 'stop' }),
          messages: [user('m4', 'hola', 'run_new'), assistant('m7', 'Voy por la mitad y termino.', 'run_new')],
        }),
      });
    });
    expect(shown()).toEqual([
      ['user', 'hola'],
      ['assistant', 'Voy por la mitad y termino.'],
    ]);
  });

  it('una conversación de cinco mensajes sobrevive a la reconexión: sale de la foto', () => {
    const five = [
      user('m2', 'uno'),
      assistant('m3', 'dos'),
      user('m5', 'tres', 'run_1b'),
      assistant('m6', 'cuatro', 'run_1b'),
      assistant('m7', 'cinco', 'run_1b'),
    ];
    const native = chatting(hostedIdle({ seq: 8, messages: five }));
    expect(shown().map(([, text]) => text)).toEqual(['uno', 'dos', 'tres', 'cuatro', 'cinco']);

    act(() => native.push({ type: 'connection', state: { kind: 'reconnecting', attempt: 2 } }));
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [NEW_SID] });
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle({ seq: 8, messages: five }) });
    });
    expect(shown().map(([, text]) => text)).toEqual(['uno', 'dos', 'tres', 'cuatro', 'cinco']);
    // Nada de la conversación se guardó en Dot.
    expect(JSON.stringify({ ...window.localStorage })).not.toMatch(/uno|cinco/);
  });

  it('las tools se ven sin decir «ejecutando», y un turno fallido queda como tal', () => {
    const native = chatting();
    const call = sampleToolCall({ runId: 'run_new', state: 'running', description: 'write hello.txt' });
    push(native, [ev(4, 'run.started', { run: newRun() }), ev(5, 'tool.started', { call })]);
    expect(shown()[1]).toEqual(['tool', expect.stringContaining('Active')]);
    expect(document.body.textContent).not.toMatch(/Executing/i);
    push(native, [
      ev(6, 'tool.completed', { call: { ...call, state: 'completed' } }),
      ev(7, 'run.failed', { run: newRun({ status: 'failed', stopReason: 'error', error: 'provider down' }) }),
    ]);
    expect(shown().map(([kind]) => kind)).toEqual(['user', 'tool', 'outcome']);
    expect(shown()[1]![1]).toContain('Done');
    expect(shown()[2]![1]).toBe('Run failed — provider down');
    // No se inventa una respuesta del asistente.
    expect(document.querySelector('[data-kind="assistant"]')).toBeNull();
  });

  it('una tool que quedó abierta en un run ya terminado no se enseña como activa', () => {
    const tool = (id: string, runId: string): ProtocolChatMessage => ({
      kind: 'tool',
      id,
      runId,
      at: AT,
      callId: 'call_0',
      name: 'exec',
      description: 'exec: ls',
      state: 'running',
    });
    chatting(
      hostedIdle({
        seq: 9,
        run: newRun(),
        messages: [tool('m2', 'run_viejo'), tool('m6', 'run_new')],
      }),
    );
    const states = [...document.querySelectorAll('[data-kind="tool"]')].map((li) => li.getAttribute('data-state'));
    expect(states).toEqual(['interrupted', 'running']);
    expect(shown()[0]![1]).toContain('Interrupted');
  });

  it('un perfil elegido en un directorio no se envía si en el siguiente no existe', async () => {
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'reviewer' })).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'reviewer' } });

    // Otro directorio, donde ese perfil no está.
    native.calls.listAgents.mockResolvedValueOnce({ agents: [] });
    const directory = screen.getByRole('textbox', { name: 'Working directory' });
    fireEvent.change(directory, { target: { value: '/otro' } });
    fireEvent.blur(directory);
    await waitFor(() => expect(screen.queryByRole('option', { name: 'reviewer' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(native.calls.openSession).toHaveBeenCalledWith({ cwd: '/otro' }));
  });

  it('salir del formulario mientras se abre no arrastra a la sesión nueva', async () => {
    const native = fakeNative();
    let finish: (value: unknown) => void = () => undefined;
    const opened = { session: hostedIdle().session };
    native.calls.openSession.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(native.calls.openSession).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
    await act(async () => finish(opened));
    expect(useUi.getState().selectedId).toBeNull();
  });

  it('una conversación larga dice que le falta el principio', () => {
    chatting(hostedIdle({ messages: [assistant('m90', 'lo último')], messagesTruncated: true }));
    expect(screen.getByText(/Earlier messages are not shown/)).toBeTruthy();
  });

  it('el markdown del modelo se pinta como texto y elementos seguros, nunca como HTML', () => {
    chatting(
      hostedIdle({
        messages: [
          assistant(
            'm4',
            'Antes <img src=x onerror="alert(1)"> **negrita** y `codigo`\n\n- uno\n- dos\n\n[sitio](https://example.com) [malo](javascript:alert(1))\n\n```\n<script>x</script>\n```',
          ),
        ],
      }),
    );
    const message = document.querySelector('[data-kind="assistant"]')!;
    expect(message.querySelector('img, script, a, iframe')).toBeNull();
    expect(message.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(message.querySelector('strong')?.textContent).toBe('negrita');
    expect(message.querySelectorAll('li')).toHaveLength(2);
    expect(message.querySelector('pre code')?.textContent).toBe('<script>x</script>');
    // Un enlace no navega: se ve su texto y, si es web, su dirección.
    expect(message.textContent).toContain('sitio (https://example.com)');
    expect(message.textContent).not.toContain('javascript:');
  });
});

describe('preguntar no es redirigir', () => {
  it('con un run en curso el campo es de steering, y lo dice', async () => {
    const native = chatting();
    push(native, [ev(4, 'run.started', { run: newRun() })]);
    expect(screen.queryByRole('textbox', { name: 'Ask Stratum' })).toBeNull();
    const steer = screen.getByRole('textbox', { name: /Steer this run/ }) as HTMLTextAreaElement;
    expect(steer.placeholder).toBe('Steer current run…');
    expect(screen.getByRole('note').textContent).toContain('does not start a new message');
    fireEvent.change(steer, { target: { value: 'mejor en inglés' } });
    fireEvent.keyDown(steer, { key: 'Enter' });
    await waitFor(() => expect(native.calls.steerRun).toHaveBeenCalledWith(NEW_SID, 'mejor en inglés'));
    expect(native.calls.startRun).not.toHaveBeenCalled();
  });

  it('en pausa o esperando una aprobación tampoco se abre otro run', async () => {
    const native = chatting();
    push(native, [
      ev(4, 'run.started', { run: newRun() }),
      ev(5, 'run.updated', { run: newRun({ status: 'paused' }) }),
    ]);
    expect(screen.getByRole('note').textContent).toContain('the run is paused');
    const steer = screen.getByRole('textbox', { name: /Steer this run/ });
    fireEvent.change(steer, { target: { value: 'cambia de plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send steering message' }));
    await waitFor(() => expect(native.calls.steerRun).toHaveBeenCalledTimes(1));
    expect(native.calls.startRun).not.toHaveBeenCalled();

    push(native, [ev(6, 'run.updated', { run: newRun({ status: 'waiting_approval' }) })]);
    expect(screen.getByRole('textbox', { name: /Steer this run/ })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Ask Stratum' })).toBeNull();
    // Dot enseña lo pendiente y no lo resuelve.
    expect(screen.queryByRole('button', { name: /approve|deny|allow/i })).toBeNull();
  });

  it('el daemon rechaza un segundo run (BUSY): se dice y el texto se conserva', async () => {
    const native = chatting();
    native.calls.startRun.mockRejectedValueOnce({ kind: 'rejected', code: 'BUSY', reason: null, message: 'busy' });
    fireEvent.change(ask(), { target: { value: 'otra cosa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('already has a run in progress'));
    expect(ask().value).toBe('otra cosa');
    expect(screen.queryByText('Sending…')).toBeNull();
  });

  it('resultado desconocido: no se reenvía, se pide una foto y decide ella', async () => {
    const native = chatting();
    native.calls.startRun.mockRejectedValueOnce({
      kind: 'unknown',
      code: null,
      reason: null,
      message: 'The connection was lost before the daemon answered.',
    });
    fireEvent.change(ask(), { target: { value: 'despliega' } });
    fireEvent.keyDown(ask(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Result unknown'));
    expect(native.calls.startRun).toHaveBeenCalledTimes(1);
    expect(native.calls.resyncSession).toHaveBeenCalledWith(NEW_SID);
    // El texto sigue ahí, pero la conversación no dice nada que no diga la foto.
    expect(ask().value).toBe('despliega');
    expect(shown()).toEqual([]);

    // La foto dice que el run sí existía: aparece, sin que Dot enviara nada más.
    act(() =>
      native.push({
        type: 'snapshot',
        sessionId: NEW_SID,
        snapshot: hostedIdle({ seq: 5, run: newRun({ input: 'despliega' }), messages: [user('m4', 'despliega', 'run_new')] }),
      }),
    );
    expect(shown()).toEqual([['user', 'despliega']]);
    expect(native.calls.startRun).toHaveBeenCalledTimes(1);
  });

  it('un mensaje que no cabe no se envía ni se recorta', async () => {
    const native = chatting();
    const huge = 'x'.repeat(LIMITS.inputChars + 1);
    fireEvent.change(ask(), { target: { value: huge } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Message too long'));
    expect(native.calls.startRun).not.toHaveBeenCalled();
    expect(ask().value).toHaveLength(huge.length);
  });

  it('una sesión de terminal parada no admite mensajes nuevos desde Dot', () => {
    const native = fakeNative();
    mount(native);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [SID] });
      native.push({
        type: 'snapshot',
        sessionId: SID,
        snapshot: snapshotOf({ run: null }, { state: 'idle', currentRunId: null }, null),
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /^Session / }));
    const field = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(field.disabled).toBe(true);
    expect(screen.getByText(/lives in a terminal/)).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(native.calls.startRun).not.toHaveBeenCalled();
  });
});

describe('varias sesiones', () => {
  function two(): FakeNative {
    const native = fakeNative();
    mount(native);
    act(() => {
      native.push({ type: 'connection', state: CONNECTED });
      native.push({ type: 'sessions', sessionIds: [NEW_SID, 'ses_b'] });
      native.push({
        type: 'snapshot',
        sessionId: NEW_SID,
        snapshot: hostedIdle({ messages: [user('m2', 'pregunta de A')] }, { title: 'chat A' }),
      });
      native.push({
        type: 'snapshot',
        sessionId: 'ses_b',
        snapshot: hostedIdle({ messages: [user('m2', 'pregunta de B')] }, { id: 'ses_b', title: 'chat B' }),
      });
    });
    return native;
  }

  it('cada chat enseña lo suyo, y lo que llega a uno no aparece en el otro', () => {
    const native = two();
    fireEvent.click(screen.getByRole('button', { name: /^Session chat A/ }));
    expect(shown()).toEqual([['user', 'pregunta de A']]);
    expect(native.calls.focusSession).toHaveBeenLastCalledWith(NEW_SID);

    // B contesta mientras se mira A.
    act(() =>
      native.push({
        type: 'events',
        sessionId: 'ses_b',
        events: [stateEvent(4, 'message.completed', { text: 'respuesta de B' }, 'ses_b')],
      }),
    );
    expect(shown()).toEqual([['user', 'pregunta de A']]);

    fireEvent.click(screen.getByRole('button', { name: /^Session chat B/ }));
    expect(native.calls.focusSession).toHaveBeenLastCalledWith('ses_b');
    expect(shown().map(([, text]) => text)).toEqual(['pregunta de B', 'respuesta de B']);
  });

  it('el borrador es de su sesión: cambiar de chat no lo mezcla ni lo envía', () => {
    const native = two();
    fireEvent.click(screen.getByRole('button', { name: /^Session chat A/ }));
    fireEvent.change(ask(), { target: { value: 'a medias en A' } });
    fireEvent.click(screen.getByRole('button', { name: /^Session chat B/ }));
    expect(ask().value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Session chat A/ }));
    expect(ask().value).toBe('a medias en A');
    expect(native.calls.startRun).not.toHaveBeenCalled();
  });

  it('dejar de mirar un chat no lo cierra: no se envía nada', () => {
    const native = two();
    fireEvent.click(screen.getByRole('button', { name: /^Session chat A/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
    expect(screen.getAllByRole('button', { name: /^Session / })).toHaveLength(2);
    expect(native.calls.cancelRun).not.toHaveBeenCalled();
    expect(Object.keys(native.calls)).not.toContain('closeSession');
  });
});

describe('la sesión desaparece', () => {
  it('con el chat abierto: se dice, y no queda dónde escribir', () => {
    const native = chatting(hostedIdle({ messages: [user('m2', 'hola')] }));
    expect(screen.getByRole('textbox', { name: 'Ask Stratum' })).toBeTruthy();
    // El daemon se reinició: sus sesiones no vuelven.
    act(() => native.push({ type: 'sessions', sessionIds: [] }));
    expect(screen.getByText('Session ended or unavailable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('hola')).toBeNull();
  });

  it('al arrancar, antes de saber qué sesiones hay, no se da ninguna por terminada', () => {
    useUi.setState({ selectedId: 'ses_de_ayer' });
    const native = fakeNative();
    mount(native);
    act(() => native.push({ type: 'connection', state: CONNECTED }));
    expect(screen.queryByText('Session ended or unavailable')).toBeNull();
    act(() => native.push({ type: 'sessions', sessionIds: [] }));
    expect(screen.getByText('Session ended or unavailable')).toBeTruthy();
  });
});
