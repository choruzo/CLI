import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeBridge } from '../../ipc/native';
import type { ProtocolDecision } from '../../protocol';
import { AssistantMemory } from './AssistantMemory';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const decision = (overrides: Partial<ProtocolDecision> = {}): ProtocolDecision => ({
  id: 'dec_1',
  title: 'Prefiere vuelos de mañana',
  type: 'preference',
  tags: ['viajes'],
  importance: 'medium',
  timestamp: '2026-11-01T10:00:00.000Z',
  content: 'El usuario prefiere salir antes de las 10.',
  source: 'agent',
  sessionId: 'ses_1',
  ...overrides,
});

function bridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return {
    memoryDecisions: vi.fn(async () => ({ decisions: [decision()] })),
    memoryForget: vi.fn(async () => ({ removed: true })),
    ...overrides,
  } as unknown as NativeBridge;
}

const mount = (native: NativeBridge, props: Partial<Parameters<typeof AssistantMemory>[0]> = {}) =>
  render(
    <AssistantMemory
      native={native}
      connected
      refreshKey="k"
      knownSessions={new Set(['ses_1'])}
      onOpenSession={() => undefined}
      {...props}
    />,
  );

describe('AssistantMemory: la memoria global del asistente', () => {
  it('lista lo que recuerda con su procedencia, y deja abrir la conversación de origen', async () => {
    const open = vi.fn();
    const native = bridge();
    mount(native, { onOpenSession: open });
    await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
    expect(native.memoryDecisions).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getByText('Prefiere vuelos de mañana'));
    expect(screen.getByText('El usuario prefiere salir antes de las 10.')).toBeTruthy();
    expect(screen.getByText('La guardó el asistente')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Abrir la conversación de/ }));
    expect(open).toHaveBeenCalledWith('ses_1');
  });

  it('buscar pide la búsqueda al daemon, recortada', async () => {
    const native = bridge();
    mount(native);
    await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Buscar en la memoria del asistente'), { target: { value: '  vuelos ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(native.memoryDecisions).toHaveBeenLastCalledWith('vuelos'));
  });

  it('olvidar pide confirmación en la página y después vuelve a pedir la lista (sin optimismo)', async () => {
    let remembered = [decision()];
    const native = bridge({
      memoryDecisions: vi.fn(async () => ({ decisions: remembered })),
      memoryForget: vi.fn(async () => {
        remembered = [];
        return { removed: true };
      }),
    });
    mount(native);
    await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Olvidar Prefiere vuelos de mañana' }));
    // Primero pregunta; conservar no envía nada.
    expect(native.memoryForget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conservar' }));
    expect(native.memoryForget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Olvidar Prefiere vuelos de mañana' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Olvidar' }));
    });
    expect(native.memoryForget).toHaveBeenCalledWith('dec_1');
    await waitFor(() => expect(screen.getByText('El asistente aún no recuerda nada.')).toBeTruthy());
    expect(native.memoryDecisions).toHaveBeenCalledTimes(2);
  });

  it('un olvido sin respuesta se dice y no se repite; la fila sigue hasta que el daemon diga otra cosa', async () => {
    const native = bridge({
      memoryForget: vi.fn(async () => {
        throw { kind: 'unknown', code: null, reason: null, message: 'sin respuesta' };
      }),
    });
    mount(native);
    await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Olvidar Prefiere vuelos de mañana' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Olvidar' }));
    });
    await waitFor(() => expect(screen.getByText(/Resultado desconocido/)).toBeTruthy());
    expect(native.memoryForget).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy();
  });

  it('una conversación que ya no está no se ofrece para abrir', async () => {
    mount(bridge(), { knownSessions: new Set() });
    await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
    fireEvent.click(screen.getByText('Prefiere vuelos de mañana'));
    expect(screen.queryByRole('button', { name: /Abrir la conversación de/ })).toBeNull();
    expect(screen.getByText(/en una conversación que ya no está/)).toBeTruthy();
  });

  it('lo que no cumple el contrato no se pinta', async () => {
    mount(bridge({ memoryDecisions: vi.fn(async () => ({ decisions: [{ id: 1 }] })) }));
    await waitFor(() => expect(screen.getByText(/no entiende/)).toBeTruthy());
  });

  it('sin conexión no pide nada', async () => {
    const native = bridge();
    mount(native, { connected: false });
    expect(screen.getByText('Sin conexión con el daemon de Stratum.')).toBeTruthy();
    expect(native.memoryDecisions).not.toHaveBeenCalled();
  });
});
