import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeBridge } from '../../ipc/native';
import type { ProtocolMemoryChange } from '../../protocol';
import { MemoryChanges } from './MemoryChanges';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const change = (over: Partial<ProtocolMemoryChange> = {}): ProtocolMemoryChange => ({
  id: 'chg_20261120_abc123',
  at: '2026-11-20T10:00:00.000Z',
  action: 'corrected',
  by: 'agent',
  decisionId: 'dec_1',
  title: 'Lucía vive en Valencia',
  content: 'Su hermana Lucía vive en Valencia.',
  newTitle: 'Lucía vive en Sevilla',
  newContent: 'Su hermana Lucía vive en Sevilla.',
  reason: 'Ella dijo que se mudó.',
  undone: false,
  undoable: true,
  ...over,
});

type Mocks = { [K in 'memoryChanges' | 'memoryUndoChange']: ReturnType<typeof vi.fn> };

function bridge(list: ProtocolMemoryChange[] = [change()]): NativeBridge & Mocks {
  return {
    memoryChanges: vi.fn(async () => ({ changes: list })),
    memoryUndoChange: vi.fn(async () => ({ undone: true, message: 'ok' })),
  } as unknown as NativeBridge & Mocks;
}

const mount = (native: NativeBridge, props: { connected?: boolean; onUndone?: () => void } = {}) =>
  render(
    <MemoryChanges native={native} connected={props.connected ?? true} onUndone={props.onUndone ?? (() => undefined)} />,
  );
const section = () => screen.getByRole('region', { name: 'Cambios recientes del asistente' });
const click = (name: string | RegExp) =>
  act(async () => fireEvent.click(screen.getByRole('button', { name })));
const flush = () => act(async () => undefined);

describe('MemoryChanges', () => {
  it('sin cambios no pinta la sección', async () => {
    const native = bridge([]);
    mount(native);
    await waitFor(() => expect(native.memoryChanges).toHaveBeenCalled());
    await flush();
    expect(screen.queryByRole('region', { name: 'Cambios recientes del asistente' })).toBeNull();
  });

  it('enseña qué hizo, quién y por qué; Deshacer solo si se puede', async () => {
    mount(
      bridge([
        change(),
        change({ id: 'c2', action: 'retired', by: 'dreaming', title: 'Ayer llovió', newTitle: undefined, newContent: undefined }),
        change({ id: 'c3', undone: true, undoable: false, title: 'Cosa vieja', newTitle: undefined }),
      ]),
    );
    await waitFor(() => expect(section().textContent).toContain('Corregido «Lucía vive en Valencia» → «Lucía vive en Sevilla»'));
    const text = section().textContent ?? '';
    expect(text).toContain('Ella dijo que se mudó.');
    expect(text).toContain('Retirado «Ayer llovió»');
    expect(text).toContain('Retirado por dreaming');
    expect(text).toContain('Deshecho');
    expect(screen.getAllByRole('button', { name: /^Deshacer:/ })).toHaveLength(2);
  });

  it('Deshacer llama con el id, avisa al panel y vuelve a pedir la lista', async () => {
    const native = bridge();
    const onUndone = vi.fn();
    mount(native, { onUndone });
    await waitFor(() => expect(section().textContent).toContain('Lucía vive en Valencia'));
    const before = native.memoryChanges.mock.calls.length;
    await click(/^Deshacer:/);
    expect(native.memoryUndoChange).toHaveBeenCalledWith('chg_20261120_abc123');
    expect(onUndone).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(native.memoryChanges.mock.calls.length).toBe(before + 1));
    // Sin optimismo: manda la lista del daemon, no lo que se supone.
    expect(section().querySelector('[data-change="chg_20261120_abc123"]')).toBeTruthy();
  });

  it('undone: false enseña el motivo y no avisa al panel', async () => {
    const native = bridge();
    native.memoryUndoChange.mockResolvedValue({ undone: false, message: 'El recuerdo cambió después.' });
    const onUndone = vi.fn();
    mount(native, { onUndone });
    await waitFor(() => expect(section().textContent).toContain('Lucía vive en Valencia'));
    await click(/^Deshacer:/);
    await waitFor(() => expect(section().textContent).toContain('El recuerdo cambió después.'));
    expect(onUndone).not.toHaveBeenCalled();
  });

  it('sin respuesta: resultado desconocido, sin reintento', async () => {
    const native = bridge();
    native.memoryUndoChange.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'x' });
    mount(native);
    await waitFor(() => expect(section().textContent).toContain('Lucía vive en Valencia'));
    await click(/^Deshacer:/);
    await waitFor(() => expect(section().textContent).toContain('Resultado desconocido'));
    await flush();
    expect(native.memoryUndoChange).toHaveBeenCalledTimes(1);
  });

  it('una respuesta ilegible se dice', async () => {
    const broken = bridge();
    broken.memoryChanges.mockResolvedValue({ changes: [{ id: 3 }] });
    mount(broken);
    await waitFor(() => expect(section().textContent).toContain('no entiende'));
  });
});
