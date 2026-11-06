import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { FilesPanel } from './FilesPanel';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const CWD = '/home/u/.stratum/desktop/workspaces/0b5b2c7e-5c1a-4f7e-8d3a-000000000001';
const FILE = { path: 'outputs/informe.md', name: 'informe.md', size: 12, area: 'outputs', modifiedMs: 1 };

type Reply = { state: string; files: unknown[] };

/** `workspace_files` va devolviendo `listings` en orden (el último se repite). */
function backend(listings: Reply[], restore: () => Promise<string> = async () => 'archived') {
  const queue = [...listings];
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'workspace_files') return queue.length > 1 ? queue.shift() : queue[0];
    if (cmd === 'workspace_restore') return restore();
    throw new Error(`comando inesperado: ${cmd}`);
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(cleanup);

describe('FilesPanel: retención de la carpeta', () => {
  it('una carpeta activa lista sus ficheros y no avisa de nada', async () => {
    backend([{ state: 'active', files: [FILE] }]);
    render(<FilesPanel cwd={CWD} refreshKey="a" />);
    expect(await screen.findByText('informe.md')).toBeTruthy();
    expect(screen.queryByText(/archivados/)).toBeNull();
    expect(screen.queryByText(/eliminaron por antigüedad/)).toBeNull();
  });

  it('archivada: lo dice y ofrece restaurar; al restaurar recarga los ficheros', async () => {
    backend([
      { state: 'archived', files: [] },
      { state: 'active', files: [FILE] },
    ]);
    render(<FilesPanel cwd={CWD} refreshKey="a" />);
    expect(await screen.findByText(/están archivados por falta de uso/)).toBeTruthy();
    // Archivada no es «sin ficheros»: no se confunden.
    expect(screen.queryByText(/no tiene ficheros/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar' }));
    expect(await screen.findByText('informe.md')).toBeTruthy();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('workspace_restore', { cwd: CWD });
    expect(screen.queryByText(/están archivados/)).toBeNull();
  });

  it('si restaurar falla se enseña el error y se puede reintentar', async () => {
    backend([{ state: 'archived', files: [] }], async () => {
      throw 'no se pudo restaurar los ficheros: disco lleno';
    });
    render(<FilesPanel cwd={CWD} refreshKey="a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurar' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('disco lleno');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Restaurar' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('eliminada por antigüedad: lo dice y no ofrece restaurar', async () => {
    backend([{ state: 'purged', files: [] }]);
    render(<FilesPanel cwd={CWD} refreshKey="a" />);
    expect(await screen.findByText(/se eliminaron por antigüedad/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restaurar' })).toBeNull();
  });
});
