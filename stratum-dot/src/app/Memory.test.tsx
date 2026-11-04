import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeProvider } from '../bridge/context';
import type { ProtocolDecision } from '../protocol';
import { useUi } from '../stores/uiStore';
import { App } from './App';
import {
  CONNECTED,
  NEW_SID,
  fakeNative,
  hostedIdle,
  resetStores,
  snapshotOf,
  type FakeNative,
} from '../testing/fixtures';

/**
 * M17 — inspector de la memoria del asistente (PRD §23.6): lo que contesta
 * `memory.decisions`, con su procedencia; buscar; olvidar con confirmación en la
 * página y sin estado optimista; y la memoria de sesión, en solo lectura.
 */

beforeEach(resetStores);
afterEach(cleanup);

function decision(overrides: Partial<ProtocolDecision> = {}): ProtocolDecision {
  return {
    id: 'dec_1',
    title: 'Prefers short answers',
    type: 'preference',
    tags: ['style', 'tone'],
    importance: 'high',
    timestamp: '2026-10-20T10:00:00.000Z',
    content: 'The user wants answers in two lines at most.',
    source: 'agent',
    ...overrides,
  };
}

const OTHER_SID = 'ses_20261001_other1';

function mounted(native: FakeNative, opts: { companion?: boolean } = {}): FakeNative {
  render(
    <NativeProvider value={native}>
      <App />
    </NativeProvider>,
  );
  act(() => {
    native.push({ type: 'connection', state: CONNECTED });
    native.push({ type: 'sessions', sessionIds: [] });
  });
  if (opts.companion) {
    act(() => {
      native.push({ type: 'sessions', sessionIds: [NEW_SID] });
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle({}, { agent: 'companion' }) });
    });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
  return native;
}

async function withPanel(native: FakeNative, opts: { companion?: boolean } = {}): Promise<FakeNative> {
  mounted(native, opts);
  await waitFor(() => expect(native.calls.memoryDecisions).toHaveBeenCalled());
  return native;
}

const panel = () => screen.getByRole('region', { name: 'Memory' });
const row = (id = 'dec_1') => panel().querySelector<HTMLElement>(`[data-decision="${id}"]`)!;
const expand = (title: string) => fireEvent.click(within(panel()).getByRole('button', { name: title }));
const flush = () => act(async () => undefined);

describe('lista de decisiones', () => {
  it('pide las últimas al abrir (sin consulta) y enseña título, tipo, importancia, fecha y tags', async () => {
    const native = fakeNative();
    native.calls.memoryDecisions.mockResolvedValue({ decisions: [decision()] });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Prefers short answers'));
    expect(native.calls.memoryDecisions).toHaveBeenCalledWith(undefined);
    expect(panel().textContent).toContain('preference · high');
    expect(panel().textContent).toContain(new Date('2026-10-20T10:00:00.000Z').toLocaleString());
    expect(panel().textContent).toContain('style, tone');
    // Plegada: ni el contenido ni la procedencia.
    expect(panel().textContent).not.toContain('two lines at most');
  });

  it('al desplegar enseña el contenido como texto plano y la procedencia de cada caso', async () => {
    const native = fakeNative();
    native.calls.memoryDecisions.mockResolvedValue({
      decisions: [
        decision({ content: '<b>bold</b> text', sessionId: OTHER_SID }),
        decision({ id: 'dec_2', title: 'Auto one', source: 'auto', content: undefined }),
        decision({ id: 'dec_3', title: 'Old one', source: undefined, content: undefined }),
      ],
    });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Auto one'));

    const toggle = within(panel()).getByRole('button', { name: 'Prefers short answers' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Texto, nunca HTML.
    expect(row().textContent).toContain('<b>bold</b> text');
    expect(row().querySelector('b')).toBeNull();
    expect(row().textContent).toContain(`Saved by the assistant in conversation ${OTHER_SID.slice(-8)}`);

    expand('Auto one');
    expect(row('dec_2').textContent).toContain('Extracted automatically from a conversation');
    expand('Old one');
    expect(row('dec_3').textContent).toContain('Origin not recorded');
    expect(row('dec_3').querySelector('.memory-content')).toBeNull();
  });

  it('Open solo si esa conversación está entre las sesiones de Dot', async () => {
    const native = fakeNative();
    native.calls.memoryDecisions.mockResolvedValue({
      decisions: [
        decision({ sessionId: OTHER_SID }),
        decision({ id: 'dec_2', title: 'Elsewhere', sessionId: 'ses_unknown_zzzz' }),
      ],
    });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Elsewhere'));
    act(() => {
      native.push({ type: 'sessions', sessionIds: [OTHER_SID] });
      native.push({ type: 'snapshot', sessionId: OTHER_SID, snapshot: snapshotOf({}, { id: OTHER_SID }) });
    });
    expand('Prefers short answers');
    expand('Elsewhere');
    expect(within(row('dec_2')).queryByRole('button', { name: /^Open/ })).toBeNull();
    fireEvent.click(within(row()).getByRole('button', { name: /^Open/ }));
    expect(useUi.getState().selectedId).toBe(OTHER_SID);
  });

  it('vacío: lo dice, y distingue una búsqueda sin resultados', async () => {
    const native = await withPanel(fakeNative());
    await waitFor(() => expect(panel().textContent).toContain('The assistant does not remember anything yet.'));
    fireEvent.change(within(panel()).getByRole('searchbox', { name: 'Search the memory' }), {
      target: { value: 'nothing' },
    });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(panel().textContent).toContain('Nothing matches.'));
    expect(native.calls.memoryDecisions).toHaveBeenLastCalledWith('nothing');
  });

  it('una respuesta que no valida se avisa y no se pinta', async () => {
    const native = fakeNative();
    native.calls.memoryDecisions.mockResolvedValue({ decisions: [{ id: 3 }] });
    await withPanel(native);
    await waitFor(() =>
      expect(within(panel()).getByRole('alert').textContent).toContain(
        'The daemon answered in a way this version of Dot cannot read.',
      ),
    );
  });

  it('un error del daemon se enseña', async () => {
    const native = fakeNative();
    native.calls.memoryDecisions.mockRejectedValue({
      kind: 'rejected',
      code: 'FORBIDDEN',
      reason: null,
      message: 'Nope.',
    });
    await withPanel(native);
    await waitFor(() => expect(within(panel()).getByRole('alert').textContent).toContain('not allowed'));
  });
});

describe('búsqueda', () => {
  it('envía la consulta (Enter incluido) y vaciarla vuelve a las últimas', async () => {
    const native = await withPanel(fakeNative());
    const box = within(panel()).getByRole('searchbox', { name: 'Search the memory' });
    fireEvent.change(box, { target: { value: '  postgres ' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(native.calls.memoryDecisions).toHaveBeenLastCalledWith('postgres'));
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(native.calls.memoryDecisions).toHaveBeenLastCalledWith(undefined));
  });

  it('mientras carga, avisa con role=status', async () => {
    const native = fakeNative();
    let release: (v: unknown) => void = () => undefined;
    native.calls.memoryDecisions.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    mounted(native);
    await waitFor(() => expect(within(panel()).getByRole('status').textContent).toContain('Loading memory'));
    await act(async () => release({ decisions: [] }));
    expect(within(panel()).queryByRole('status')).toBeNull();
  });
});

describe('olvidar', () => {
  async function withOne(): Promise<FakeNative> {
    const native = fakeNative();
    native.calls.memoryDecisions.mockResolvedValue({ decisions: [decision()] });
    await withPanel(native);
    await waitFor(() => expect(panel().textContent).toContain('Prefers short answers'));
    return native;
  }
  const askForget = () => fireEvent.click(within(row()).getByRole('button', { name: 'Forget Prefers short answers' }));

  it('pide confirmación en la página; Keep no llama', async () => {
    const native = await withOne();
    askForget();
    expect(panel().textContent).toContain('Forget “Prefers short answers”? The assistant will no longer recall it.');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Keep' }));
    expect(native.calls.memoryForget).not.toHaveBeenCalled();
    expect(within(row()).getByRole('button', { name: 'Forget Prefers short answers' })).toBeTruthy();
  });

  it('Forget llama con el id y vuelve a pedir la lista, sin quitar la fila a mano', async () => {
    const native = await withOne();
    const before = native.calls.memoryDecisions.mock.calls.length;
    askForget();
    // El daemon sigue devolviendo la decisión: la fila se queda, porque manda la lista.
    await act(async () => fireEvent.click(within(panel()).getByRole('button', { name: 'Forget' })));
    expect(native.calls.memoryForget).toHaveBeenCalledWith('dec_1');
    await waitFor(() => expect(native.calls.memoryDecisions.mock.calls.length).toBe(before + 1));
    expect(row()).toBeTruthy();
    // Cuando el daemon ya no la devuelve, se va.
    native.calls.memoryDecisions.mockResolvedValue({ decisions: [] });
    fireEvent.click(within(panel()).getByRole('button', { name: 'Refresh the memory' }));
    await waitFor(() => expect(panel().querySelector('[data-decision]')).toBeNull());
  });

  it('removed: false dice que ya no estaba', async () => {
    const native = await withOne();
    native.calls.memoryForget.mockResolvedValue({ removed: false });
    askForget();
    await act(async () => fireEvent.click(within(panel()).getByRole('button', { name: 'Forget' })));
    await waitFor(() => expect(panel().textContent).toContain('It was already gone.'));
  });

  it('sin respuesta: resultado desconocido, no se repite y se vuelve a pedir la lista', async () => {
    const native = await withOne();
    native.calls.memoryForget.mockRejectedValue({ kind: 'unknown', code: null, reason: null, message: 'x' });
    const before = native.calls.memoryDecisions.mock.calls.length;
    askForget();
    await act(async () => fireEvent.click(within(panel()).getByRole('button', { name: 'Forget' })));
    await waitFor(() => expect(panel().textContent).toContain('Result unknown'));
    expect(panel().textContent).toContain('Refresh to see whether it was forgotten.');
    await flush();
    expect(native.calls.memoryForget).toHaveBeenCalledTimes(1);
    expect(native.calls.memoryDecisions.mock.calls.length).toBe(before + 1);
  });

  it('sin control, el botón está deshabilitado', async () => {
    const native = fakeNative();
    native.calls.memoryDecisions.mockResolvedValue({ decisions: [decision()] });
    // Un cliente sin `control`: no puede abrir al asistente, pero el panel se ve.
    render(
      <NativeProvider value={native}>
        <App />
      </NativeProvider>,
    );
    act(() => {
      native.push({ type: 'connection', state: { ...CONNECTED, capabilities: ['observe'] } as typeof CONNECTED });
      native.push({ type: 'sessions', sessionIds: [] });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assistant' }));
    await waitFor(() => expect(panel().textContent).toContain('Prefers short answers'));
    expect(
      (within(row()).getByRole('button', { name: 'Forget Prefers short answers' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('This conversation', () => {
  const memory = {
    version: 2,
    updatedAt: null,
    summary: { text: 'We set up the backup job.', sourceCount: 4, firstSource: null, lastSource: null },
    items: [
      { id: 'm1', kind: 'fact', key: 'k1', text: 'Backups run at night', status: 'active', sources: [], updatedAt: 1 },
      { id: 'm2', kind: 'fact', key: 'k2', text: 'Backups run at noon', status: 'superseded', sources: [], updatedAt: 1 },
    ],
    sourceCursor: null,
  };

  it('no aparece sin la conversación del asistente', async () => {
    const native = fakeNative();
    // El daemon no abre al asistente: no hay conversación de la que enseñar memoria.
    native.calls.openSession.mockRejectedValue({ kind: 'rejected', code: 'UNAVAILABLE', reason: null, message: 'No.' });
    await withPanel(native);
    expect(useUi.getState().companionId).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Show' })).toBeNull();
  });

  it('pide la memoria de sesión con el id al abrirla y pinta solo lo activo', async () => {
    const native = fakeNative();
    native.calls.sessionMemory.mockResolvedValue({ memory });
    await withPanel(native, { companion: true });
    await waitFor(() => expect(useUi.getState().companionId).toBe(NEW_SID));
    expect(native.calls.sessionMemory).not.toHaveBeenCalled();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(native.calls.sessionMemory).toHaveBeenCalledWith(NEW_SID));
    await waitFor(() => expect(panel().textContent).toContain('We set up the backup job.'));
    expect(panel().textContent).toContain('Backups run at night');
    expect(panel().textContent).not.toContain('Backups run at noon');
    expect(panel().textContent).toContain('Kept only for this conversation; compacted from its older messages.');
    fireEvent.click(within(panel()).getByRole('button', { name: "Refresh this conversation's memory" }));
    await waitFor(() => expect(native.calls.sessionMemory).toHaveBeenCalledTimes(2));
  });

  it('sin resumen ni items: nada compactado todavía', async () => {
    const native = await withPanel(fakeNative(), { companion: true });
    await waitFor(() => expect(useUi.getState().companionId).toBe(NEW_SID));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(panel().textContent).toContain('Nothing compacted yet.'));
    expect(native.calls.sessionMemory).toHaveBeenCalledTimes(1);
  });

  it('una respuesta inválida se avisa', async () => {
    const native = fakeNative();
    native.calls.sessionMemory.mockResolvedValue({ memory: 7 });
    await withPanel(native, { companion: true });
    await waitFor(() => expect(useUi.getState().companionId).toBe(NEW_SID));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(panel().textContent).toContain('cannot read'));
  });
});

describe('refresco automático', () => {
  it('vuelve a pedir la lista cuando termina el run del asistente, y no antes', async () => {
    const native = fakeNative();
    await withPanel(native, { companion: true });
    await waitFor(() => expect(useUi.getState().companionId).toBe(NEW_SID));
    const calls = () => native.calls.memoryDecisions.mock.calls.length;
    const running = snapshotOf(
      { seq: 4 },
      { id: NEW_SID, state: 'running', currentRunId: 'run_1', host: { kind: 'daemon', client: 'daemon', connected: true } },
      { id: 'run_1', sessionId: NEW_SID, status: 'running' },
    );
    act(() => native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: running }));
    await flush();
    const during = calls();
    act(() =>
      native.push({ type: 'snapshot', sessionId: NEW_SID, snapshot: hostedIdle({ seq: 6 }, { agent: 'companion' }) }),
    );
    await waitFor(() => expect(calls()).toBe(during + 1));
  });
});
