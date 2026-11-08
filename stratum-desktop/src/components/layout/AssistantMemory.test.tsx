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
    memoryMove: vi.fn(async () => ({ updated: true })),
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

  it('M19: agrupa por sección, enseña el resumen plegado y manda lo desconocido a Temas', async () => {
    const native = bridge({
      memoryDecisions: vi.fn(async () => ({
        decisions: [
          decision({ id: 'd1', title: 'Le gusta el té', type: 'profile', summary: 'Té, sin azúcar' }),
          decision({ id: 'd2', title: 'Lucía', type: 'person' }),
          decision({ id: 'd3', title: 'Tipo viejo', type: 'bug_fix' }),
        ],
      })),
    });
    mount(native);
    await waitFor(() => expect(screen.getByText('Le gusta el té')).toBeTruthy());
    const sections = Array.from(document.querySelectorAll('[data-section]')).map((n) =>
      n.getAttribute('data-section'),
    );
    expect(sections).toEqual(['profile', 'person', 'topic']);
    expect(screen.getByRole('group', { name: 'Tú' }).textContent).toContain('Té, sin azúcar');
    expect(screen.getByRole('group', { name: 'Temas' }).textContent).toContain('Tipo viejo');
    fireEvent.click(screen.getByText('Le gusta el té'));
    expect(screen.getByRole('group', { name: 'Tú' }).textContent).not.toContain('Té, sin azúcar');
  });

  describe('M19 — reclasificar', () => {
    const topic = () => ({ decisions: [decision({ type: 'topic' })] });
    const select = () =>
      screen.getByRole('combobox', {
        name: 'Mover Prefiere vuelos de mañana a otra sección',
      }) as HTMLSelectElement;
    const moveTo = (section: string) =>
      act(async () => fireEvent.change(select(), { target: { value: section } }));
    const calls = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.length;

    it('ofrece las cinco secciones con la actual seleccionada, y mover llama con id y sección', async () => {
      const native = bridge({ memoryDecisions: vi.fn(async () => topic()) });
      mount(native);
      await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
      expect(Array.from(select().options).map((o) => o.value)).toEqual([
        'profile',
        'person',
        'project',
        'topic',
        'area',
      ]);
      expect(select().value).toBe('topic');
      const before = calls(native.memoryDecisions);
      await moveTo('person');
      expect(native.memoryMove).toHaveBeenCalledWith('dec_1', 'person');
      // Sin optimismo: se vuelve a pedir la lista y la fila no se mueve a mano.
      await waitFor(() => expect(calls(native.memoryDecisions)).toBe(before + 1));
      expect(
        document.querySelector('[data-section="topic"] [data-decision="dec_1"]'),
      ).toBeTruthy();
    });

    it('elegir la sección actual no llama a nada', async () => {
      const native = bridge({ memoryDecisions: vi.fn(async () => topic()) });
      mount(native);
      await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
      await moveTo('topic');
      expect(native.memoryMove).not.toHaveBeenCalled();
    });

    it('updated: false dice que ya no estaba; sin respuesta, resultado desconocido y sin reintento', async () => {
      const native = bridge({
        memoryDecisions: vi.fn(async () => topic()),
        memoryMove: vi.fn(async () => ({ updated: false })),
      });
      mount(native);
      await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
      await moveTo('area');
      await waitFor(() => expect(screen.getByText('Ya no estaba.')).toBeTruthy());

      (native.memoryMove as ReturnType<typeof vi.fn>).mockRejectedValue({
        kind: 'unknown',
        code: null,
        reason: null,
        message: 'x',
      });
      await moveTo('project');
      await waitFor(() => expect(screen.getByText(/Resultado desconocido/)).toBeTruthy());
      expect(native.memoryMove).toHaveBeenCalledTimes(2);
    });

    it('sin conexión, el selector está deshabilitado', async () => {
      const native = bridge({ memoryDecisions: vi.fn(async () => topic()) });
      const view = mount(native);
      await waitFor(() => expect(screen.getByText('Prefiere vuelos de mañana')).toBeTruthy());
      view.rerender(
        <AssistantMemory
          native={native}
          connected={false}
          refreshKey="k"
          knownSessions={new Set(['ses_1'])}
          onOpenSession={() => undefined}
        />,
      );
      expect(select().disabled).toBe(true);
    });
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
