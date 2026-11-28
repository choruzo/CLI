import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunActions } from '../app/actions';
import { NativeProvider } from '../bridge/context';
import { SID, fakeNative, resetStores, type FakeNative } from '../testing/fixtures';
import { Composer } from './Composer';

beforeEach(resetStores);
afterEach(cleanup);

function mount(native: FakeNative = fakeNative()) {
  const actions: RunActions = {
    control: vi.fn(async () => undefined),
    steer: vi.fn(async () => true),
    send: vi.fn(async () => true),
  };
  render(
    <NativeProvider value={native}>
      <Composer
        sessionId={SID}
        mode={{ kind: 'ask' }}
        shownRunId={null}
        sending={false}
        target="daemon"
        actions={actions}
      />
    </NativeProvider>,
  );
  return { native, actions };
}

const field = () => screen.getByRole('textbox', { name: 'Ask Stratum' }) as HTMLTextAreaElement;
const mic = () => screen.getByRole('button', { name: /voice note/ });
const sendButton = () => screen.getByRole('button', { name: 'Send message' });

/** Pulsar y soltar el micro, que es lo que graba una nota (el puntero se queda pulsado). */
async function record(native: FakeNative) {
  const button = mic();
  await act(async () => {
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
  });
  expect(native.calls.voiceStart).toHaveBeenCalledWith(SID);
  await act(async () => {
    fireEvent.pointerUp(button, { button: 0, pointerId: 1 });
  });
  expect(native.calls.voiceStop).toHaveBeenCalledTimes(1);
}

async function send(native: FakeNative, actions: RunActions, expected: string) {
  await act(async () => {
    fireEvent.click(sendButton());
  });
  expect(actions.send).toHaveBeenCalledWith(expected, null);
  // Lo enviado se vacía: el siguiente mensaje empieza limpio.
  expect(field().value).toBe('');
  expect(native.calls.startRun).not.toHaveBeenCalled();
}

describe('nota de voz en el campo', () => {
  it('mantener pulsado graba y soltar pone el texto en el campo', async () => {
    const { native } = mount();
    expect(field().value).toBe('');

    await act(async () => {
      fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    });
    // Mientras se escucha, se dice y el cronómetro es del campo, no del nativo.
    const listening = screen.getByRole('status');
    expect(listening.textContent).toBe('Listening… 0:00');
    expect(mic().getAttribute('data-state')).toBe('listening');
    expect(mic().getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 });
    });
    expect(native.calls.voiceStop).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('hola');
    // Ya no queda nada que contar de la nota.
    expect(screen.queryByRole('status')).toBeNull();
    expect(mic().getAttribute('aria-pressed')).toBe('false');
  });

  it('con el foco en el micro, mantener Space graba y soltarlo termina', async () => {
    const { native } = mount();
    const button = mic();
    await act(async () => {
      fireEvent.keyDown(button, { key: ' ' });
    });
    expect(native.calls.voiceStart).toHaveBeenCalledWith(SID);
    // Otra pulsación sin haber soltado no arranca una segunda grabación.
    await act(async () => {
      fireEvent.keyDown(button, { key: ' ' });
    });
    await act(async () => {
      fireEvent.keyUp(button, { key: ' ' });
    });
    expect(native.calls.voiceStart).toHaveBeenCalledTimes(1);
    expect(native.calls.voiceStop).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('hola');
  });

  it('soltar antes de que el micrófono abra: se para en cuanto abre', async () => {
    const { native } = mount();
    let open: () => void = () => undefined;
    native.calls.voiceStart.mockImplementationOnce(() => new Promise<void>((resolve) => (open = resolve)));
    await act(async () => {
      fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    });
    fireEvent.pointerUp(mic(), { button: 0, pointerId: 1 });
    // Aún no hay nada grabando que parar.
    expect(native.calls.voiceStop).not.toHaveBeenCalled();
    await act(async () => open());
    expect(native.calls.voiceStop).toHaveBeenCalledTimes(1);
    expect(field().value).toBe('hola');
  });

  it('enviar tal cual dice de dónde salió el texto', async () => {
    const { native, actions } = mount();
    await record(native);
    expect(field().value).toBe('hola');
    await send(native, actions, '[nota de voz, 0:01] hola');
  });

  it('si se corrige lo dictado, se envía sin marca: lo que se toca ya es de la persona', async () => {
    const { native, actions } = mount();
    await record(native);
    fireEvent.change(field(), { target: { value: 'holi, qué tal' } });
    await send(native, actions, 'holi, qué tal');
  });

  it('lo escrito antes se queda delante, y la marca va al principio de todo', async () => {
    const { native, actions } = mount();
    fireEvent.change(field(), { target: { value: 'hey' } });
    await record(native);
    expect(field().value).toBe('hey hola');
    await send(native, actions, '[nota de voz, 0:01] hey hola');
  });

  it('el segundo mensaje no arrastra la marca del primero', async () => {
    const { native, actions } = mount();
    await record(native);
    await send(native, actions, '[nota de voz, 0:01] hola');
    fireEvent.change(field(), { target: { value: 'otra cosa' } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    expect(actions.send).toHaveBeenLastCalledWith('otra cosa', null);
  });
});

describe('cuando la nota no sale', () => {
  it('si el micrófono no arranca se dice por qué y no se pide parar nada', async () => {
    const { native } = mount();
    native.calls.voiceStart.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'VOICE_UNAVAILABLE',
      reason: null,
      message: 'There is no microphone to record with.',
    });

    await act(async () => {
      fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    });
    const line = screen.getByRole('status');
    expect(line.textContent).toBe('There is no microphone to record with.');
    expect(line.className).toContain('bad');
    expect(native.calls.voiceStop).not.toHaveBeenCalled();
    // A reposo: el botón vuelve a estar para grabar.
    expect(mic().getAttribute('data-state')).toBeNull();
    expect(field().value).toBe('');
  });

  it('cancelar con el puntero tira la nota y no deja texto', async () => {
    const { native } = mount();
    await act(async () => {
      fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.pointerCancel(mic(), { pointerId: 1 });
    });
    expect(native.calls.voiceCancel).toHaveBeenCalledTimes(1);
    expect(native.calls.voiceStop).not.toHaveBeenCalled();
    expect(field().value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('perder el foco de la ventana mientras se escucha tira la nota', async () => {
    const { native } = mount();
    await act(async () => {
      fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    });
    await act(async () => {
      fireEvent.blur(window);
    });
    expect(native.calls.voiceCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(field().value).toBe('');
  });

  it('una transcripción que no valida se dice y no toca el borrador', async () => {
    const { native } = mount();
    fireEvent.change(field(), { target: { value: 'lo mío' } });
    native.calls.voiceStop.mockResolvedValueOnce({ transcript: { text: 'hola' } });

    await record(native);
    expect(screen.getByRole('status').textContent).toBe('The note could not be read.');
    expect(field().value).toBe('lo mío');
  });

  it('si el nativo falla al parar, el motivo se ve en la línea del campo', async () => {
    const { native } = mount();
    native.calls.voiceStop.mockRejectedValueOnce({
      kind: 'rejected',
      code: 'VOICE_EMPTY',
      reason: null,
      message: 'The note was too short to transcribe.',
    });
    await record(native);
    expect(screen.getByRole('status').textContent).toBe('The note was too short to transcribe.');
    expect(field().value).toBe('');
  });
});

describe('el micro no siempre está', () => {
  it('con la sesión sin admitir mensajes, el micro está deshabilitado', () => {
    const actions: RunActions = {
      control: vi.fn(async () => undefined),
      steer: vi.fn(async () => true),
      send: vi.fn(async () => true),
    };
    render(
      <NativeProvider value={fakeNative()}>
        <Composer
          sessionId={SID}
          mode={{ kind: 'off', reason: 'This session has ended' }}
          shownRunId={null}
          sending={false}
          target="daemon"
          actions={actions}
        />
      </NativeProvider>,
    );
    expect((mic() as HTMLButtonElement).disabled).toBe(true);
  });
});
