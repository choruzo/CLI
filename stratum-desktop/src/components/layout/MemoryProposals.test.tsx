import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeBridge } from '../../ipc/native';
import type { ProtocolProposal } from '../../protocol';
import { MemoryProposals } from './MemoryProposals';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const proposal = (over: Partial<ProtocolProposal> = {}): ProtocolProposal => ({
  id: 'prop_1',
  kind: 'correct',
  createdAt: '2026-11-08T10:00:00.000Z',
  expiresAt: '2026-11-22T10:00:00.000Z',
  rationale: 'Ella dijo que se mudó a Sevilla.',
  evidence: [{ sessionId: 'sess_20261101_aaaaaa', messageId: 'm1' }],
  targets: [{ id: 'dec_1', title: 'Lucía vive en Valencia' }],
  content: 'Su hermana Lucía vive en Sevilla.',
  ...over,
});

type Mocks = {
  [K in 'memoryProposals' | 'memoryDream' | 'memoryApplyProposal' | 'memoryRejectProposal']: ReturnType<typeof vi.fn>;
};

function bridge(list: ProtocolProposal[] = [proposal()]): NativeBridge & Mocks {
  return {
    memoryProposals: vi.fn(async () => ({ proposals: list })),
    memoryDream: vi.fn(async () => ({ status: 'done', message: 'ok', proposals: [], discarded: 0, tokens: null })),
    memoryApplyProposal: vi.fn(async () => ({ applied: true, message: 'ok' })),
    memoryRejectProposal: vi.fn(async () => ({ rejected: true, message: 'ok' })),
  } as unknown as NativeBridge & Mocks;
}

const mount = (native: NativeBridge, props: { connected?: boolean; onApplied?: () => void } = {}) =>
  render(
    <MemoryProposals native={native} connected={props.connected ?? true} onApplied={props.onApplied ?? (() => undefined)} />,
  );
const section = () => screen.getByRole('region', { name: 'Cambios sugeridos' });
const click = (name: string | RegExp) =>
  act(async () => fireEvent.click(screen.getByRole('button', { name })));
const flush = () => act(async () => undefined);

describe('MemoryProposals (M19 fase 5)', () => {
  it('sin sugerencias lo dice; con ellas, qué cambiaría, por qué y de dónde sale', async () => {
    mount(bridge([]));
    await waitFor(() => expect(section().textContent).toContain('No hay sugerencias ahora mismo.'));
    cleanup();
    mount(
      bridge([
        proposal(),
        proposal({ id: 'p2', kind: 'create', targets: [], title: 'Gato Miso', content: 'Su gato es Miso.', evidence: [] }),
        proposal({ id: 'p3', kind: 'prune', targets: [{ id: 'd9', title: 'Ayer llovió' }], content: undefined }),
        proposal({ id: 'p4', kind: 'reclassify', type: 'person', content: undefined }),
        proposal({ id: 'p5', kind: 'promote', content: undefined }),
        proposal({ id: 'p6', kind: 'merge', title: 'Café solo', targets: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }] }),
      ]),
    );
    await waitFor(() => expect(section().textContent).toContain('Actualizar «Lucía vive en Valencia»'));
    const text = section().textContent ?? '';
    expect(text).toContain('Su hermana Lucía vive en Sevilla.');
    expect(text).toContain('Ella dijo que se mudó a Sevilla.');
    expect(text).toContain('De 1 mensaje');
    expect(text).toContain('Recordar «Gato Miso»');
    expect(text).toContain('Olvidar «Ayer llovió»');
    expect(text).toContain('Mover «Lucía vive en Valencia» a Personas');
    expect(text).toContain('Marcar «Lucía vive en Valencia» como importante');
    expect(text).toContain('Fusionar 2 recuerdos en «Café solo»');
  });

  it('Aplicar llama con el id, avisa a la memoria y vuelve a pedir la lista sin quitar nada a mano', async () => {
    const native = bridge();
    const onApplied = vi.fn();
    mount(native, { onApplied });
    await waitFor(() => expect(section().textContent).toContain('Actualizar'));
    const before = native.memoryProposals.mock.calls.length;
    await click(/^Aplicar:/);
    expect(native.memoryApplyProposal).toHaveBeenCalledWith('prop_1');
    expect(onApplied).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(native.memoryProposals.mock.calls.length).toBe(before + 1));
    expect(section().querySelector('[data-proposal="prop_1"]')).toBeTruthy();
  });

  it('applied: false enseña el motivo y no avisa a la memoria', async () => {
    const native = bridge();
    native.memoryApplyProposal.mockResolvedValue({ applied: false, message: 'La propuesta caducó.' });
    const onApplied = vi.fn();
    mount(native, { onApplied });
    await waitFor(() => expect(section().textContent).toContain('Actualizar'));
    await click(/^Aplicar:/);
    await waitFor(() => expect(screen.getByText('La propuesta caducó.')).toBeTruthy());
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('Descartar rechaza con el id y vuelve a pedir la lista', async () => {
    const native = bridge();
    mount(native);
    await waitFor(() => expect(section().textContent).toContain('Actualizar'));
    const before = native.memoryProposals.mock.calls.length;
    await click(/^Descartar:/);
    expect(native.memoryRejectProposal).toHaveBeenCalledWith('prop_1');
    await waitFor(() => expect(native.memoryProposals.mock.calls.length).toBe(before + 1));
  });

  it('sin respuesta: resultado desconocido y sin reintento', async () => {
    const native = bridge();
    native.memoryApplyProposal.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'x' });
    mount(native);
    await waitFor(() => expect(section().textContent).toContain('Actualizar'));
    await click(/^Aplicar:/);
    await waitFor(() => expect(screen.getByText(/Resultado desconocido/)).toBeTruthy());
    await flush();
    expect(native.memoryApplyProposal).toHaveBeenCalledTimes(1);
  });

  it('Revisar ahora pide una pasada sin force y cuenta lo que propuso', async () => {
    const native = bridge([]);
    native.memoryDream.mockResolvedValue({
      status: 'done',
      message: 'ok',
      proposals: [proposal(), proposal({ id: 'p2' })],
      discarded: 0,
      tokens: null,
    });
    mount(native);
    await waitFor(() => expect(native.memoryProposals).toHaveBeenCalled());
    await click('Revisar la memoria ahora');
    expect(native.memoryDream).toHaveBeenCalledWith(false);
    await waitFor(() => expect(screen.getByText('Revisado: 2 cambios sugeridos.')).toBeTruthy());
  });

  it('dice lo que no se pudo: nada nuevo, tope diario, sin modelo, fallo del modelo', async () => {
    const native = bridge([]);
    mount(native);
    await waitFor(() => expect(native.memoryProposals).toHaveBeenCalled());
    const ask = async (result: Record<string, unknown>) => {
      native.memoryDream.mockResolvedValue({ message: 'm', proposals: [], discarded: 0, tokens: null, ...result });
      await click('Revisar la memoria ahora');
    };
    await ask({ status: 'skipped', reason: 'nothing-new' });
    await waitFor(() => expect(section().textContent).toContain('No hay conversaciones nuevas'));
    await ask({ status: 'skipped', reason: 'budget' });
    await waitFor(() => expect(section().textContent).toContain('límite de revisiones'));
    await ask({ status: 'skipped', reason: 'no-model' });
    await waitFor(() => expect(section().textContent).toContain('ningún modelo'));
    await ask({ status: 'failed', reason: 'model-failed', message: 'El modelo falló: boom' });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'));
    await ask({ status: 'done' });
    await waitFor(() => expect(section().textContent).toContain('Revisado: no hay nada que cambiar.'));
  });

  it('una revisión sin respuesta es resultado desconocido y no se repite', async () => {
    const native = bridge([]);
    native.memoryDream.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'x' });
    mount(native);
    await waitFor(() => expect(native.memoryProposals).toHaveBeenCalled());
    await click('Revisar la memoria ahora');
    await waitFor(() => expect(screen.getByText(/Resultado desconocido/)).toBeTruthy());
    await flush();
    expect(native.memoryDream).toHaveBeenCalledTimes(1);
  });

  it('sin conexión los botones están deshabilitados; una respuesta ilegible se dice', async () => {
    mount(bridge(), { connected: true });
    await waitFor(() => expect(section().textContent).toContain('Actualizar'));
    cleanup();
    const offline = bridge();
    mount(offline, { connected: false });
    await flush();
    expect(offline.memoryProposals).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Revisar la memoria ahora' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const broken = bridge();
    broken.memoryProposals.mockResolvedValue({ proposals: [{ id: 3 }] });
    mount(broken);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no entiende'));
  });
});
