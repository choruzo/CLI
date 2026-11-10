// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approvalsStore } from '../../client/approvals';
import type { Changes, Loaded } from '../../client/code-actions';
import type { ChangesState } from '../../hooks/useChanges';
import type { NativeBridge } from '../../ipc/native';
import { ChangesPanel } from './ChangesPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(cleanup);
beforeEach(() => {
  approvalsStore.set(() => ({ status: { kind: 'ready', expiresAt: Date.now() + 60_000 }, resolutions: {} }));
});

const SID = 'ses_code';

const CHANGES: Changes = {
  isRepo: true,
  files: 2,
  added: 12,
  deleted: 3,
  truncated: false,
  changes: [
    { path: 'src/app.ts', added: 10, deleted: 3, status: 'modified' },
    { path: 'logo.png', added: 0, deleted: 0, status: 'untracked', binary: true },
  ],
};

const PLAN = { turns: [4], restore: ['src/app.ts'], remove: ['src/nuevo.ts'], conflicts: [], skipped: [], truncated: false };

function setup(over: { changes?: Loaded<Changes> | null; undoBlocked?: string | null; native?: Partial<NativeBridge> } = {}) {
  const refresh = vi.fn();
  const native = {
    gitDiff: vi.fn(async () => ({ diff: '@@ -1 +1 @@\n-a\n+b\n', truncated: false, binary: false })),
    revertPlan: vi.fn(async () => ({ status: 'planned', plan: PLAN })),
    revert: vi.fn(async () => ({ status: 'reverted', plan: PLAN })),
    unlockApprovals: vi.fn(async () => undefined),
    resyncSession: vi.fn(async () => undefined),
    ...over.native,
  } as unknown as NativeBridge;
  const state: ChangesState = {
    changes: over.changes === undefined ? { ok: true, value: CHANGES } : over.changes,
    loading: false,
    refresh,
  };
  render(<ChangesPanel native={native} sessionId={SID} state={state} connected undoBlocked={over.undoBlocked ?? null} />);
  return { native, refresh };
}

describe('ChangesPanel', () => {
  it('lista los cambios y pide el diff al abrir un fichero', async () => {
    const { native } = setup();
    expect(screen.getByText(/2 ficheros/)).toBeTruthy();
    expect(screen.getByText('bin')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /app\.ts/ }));
    expect(native.gitDiff).toHaveBeenCalledWith(SID, 'src/app.ts');
    await waitFor(() => expect(document.querySelector('.diff__line[data-kind="add"]')?.textContent).toContain('+b'));
    // Cerrarlo y volver a abrirlo no lo pide otra vez mientras la lista no cambie.
    fireEvent.click(screen.getByRole('button', { name: /app\.ts/ }));
    fireEvent.click(screen.getByRole('button', { name: /app\.ts/ }));
    expect(native.gitDiff).toHaveBeenCalledTimes(1);
  });

  it('un diff que no llega se dice en su fila', async () => {
    setup({
      native: {
        gitDiff: vi.fn(async () => {
          throw { kind: 'rejected', code: 'INVALID_PARAMS', message: 'Invalid path.' };
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /app\.ts/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo leer el diff');
  });

  it('sin repositorio, limpio, sin leer y con error', () => {
    setup({ changes: { ok: true, value: { ...CHANGES, isRepo: false, files: 0, changes: [] } } });
    expect(screen.getByText(/no es un repositorio git/)).toBeTruthy();
    cleanup();
    setup({ changes: { ok: true, value: { ...CHANGES, files: 0, added: 0, deleted: 0, changes: [] } } });
    expect(screen.getByText('El árbol de trabajo está limpio.')).toBeTruthy();
    cleanup();
    setup({ changes: null });
    expect(screen.getByText('Leyendo los cambios…')).toBeTruthy();
    cleanup();
    setup({ changes: { ok: false, message: 'No se pudieron leer los cambios: sin conexión' } });
    expect(screen.getByRole('alert').textContent).toContain('sin conexión');
  });

  it('actualizar vuelve a pedir la lista', () => {
    const { refresh } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar los cambios' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('deshacer turnos', () => {
  it('primero enseña el plan (sin tocar nada) y deshacer pasa por la confirmación nativa', async () => {
    const { native, refresh } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué se desharía' }));
    expect(native.revertPlan).toHaveBeenCalledWith(SID, 1);
    expect(await screen.findByText('Se restauran (1)')).toBeTruthy();
    expect(screen.getByText('Se borran (1)')).toBeTruthy();
    expect(native.revert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer…' }));
    expect(native.revert).toHaveBeenCalledWith(SID, 1);
    expect(await screen.findByText(/Hecho: los ficheros han vuelto/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('con conflictos no ofrece deshacer: desde Desktop no se fuerza', async () => {
    const { native } = setup({
      native: {
        revertPlan: vi.fn(async () => ({ status: 'conflicts', plan: { ...PLAN, conflicts: ['src/app.ts'] } })),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué se desharía' }));
    expect(await screen.findByText('Cambiados después (conflicto) (1)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Deshacer…' })).toBeNull();
    expect(native.revert).not.toHaveBeenCalled();
  });

  it('cancelar la confirmación deja el plan como estaba, sin error', async () => {
    setup({
      native: {
        revert: vi.fn(async () => {
          throw { kind: 'not-confirmed', reason: 'cancelled', message: 'cancelled' };
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué se desharía' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deshacer…' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Deshacer…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sin respuesta: resultado desconocido, no se repite y se pide una foto', async () => {
    const { native } = setup({
      native: {
        revert: vi.fn(async () => {
          throw { kind: 'unknown', message: 'no answer' };
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué se desharía' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deshacer…' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Resultado desconocido');
    expect(native.revert).toHaveBeenCalledTimes(1);
    expect(native.resyncSession).toHaveBeenCalledWith(SID);
  });

  it('con las aprobaciones bloqueadas pide desbloquear, no calcula nada', () => {
    const { native } = setup();
    act(() => approvalsStore.set((s) => ({ ...s, status: { kind: 'locked', reason: 'idle' } })));
    expect(screen.queryByRole('button', { name: 'Ver qué se desharía' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear para deshacer' }));
    expect(native.unlockApprovals).toHaveBeenCalledOnce();
    expect(native.revertPlan).not.toHaveBeenCalled();
  });

  it('con un turno en marcha no se puede y se dice por qué', () => {
    setup({ undoBlocked: 'Se podrá cambiar cuando acabe el turno en marcha.' });
    expect((screen.getByRole('button', { name: 'Ver qué se desharía' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Se podrá cambiar cuando acabe el turno en marcha.')).toBeTruthy();
  });
});
