import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { PURGE_WARNING_DAYS as PROTOCOL_PURGE_WARNING_DAYS } from '../../../../stratum-cli/src/desktop/protocol';
import {
  PURGE_WARNING_DAYS,
  RetentionBanner,
  describePurge,
  purgeIsNear,
} from './RetentionBanner';
import { FileCard, isExpired } from './files/FileCard';
import { workspaceStatus } from '../../ipc/validate';
import { frameToAction } from '../../hooks/useAgentStream';
import {
  conversationReducer as reduce,
  initialConversationState,
} from '../../hooks/conversation-reducer';
import type { SidecarFrame, WorkspaceStatus } from '../../ipc/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const CID = '6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-22T12:00:00Z');

function status(patch: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  return {
    state: 'active',
    pinned: false,
    lastUsedAt: new Date(NOW - 28 * DAY).toISOString(),
    purgeAt: new Date(NOW + 2 * DAY).toISOString(),
    filesExpiredAt: null,
    ...patch,
  };
}

describe('estado de retención (D3)', () => {
  it('el umbral del aviso es el del protocolo', () => {
    expect(PURGE_WARNING_DAYS).toBe(PROTOCOL_PURGE_WARNING_DAYS);
  });

  it('valida el estado y descarta lo que no encaja', () => {
    expect(workspaceStatus(status())).toEqual(status());
    expect(workspaceStatus({ ...status(), state: 'borrado' })).toBeNull();
    expect(workspaceStatus({ ...status(), pinned: 'sí' })).toBeNull();
    expect(workspaceStatus({ ...status(), purgeAt: 'mañana' })).toBeNull();
    expect(workspaceStatus(undefined)).toBeNull();
  });

  it('conversation_opened y workspace_status llegan al reducer', () => {
    const opened = frameToAction(
      {
        type: 'conversation_opened',
        conversationId: CID,
        resumed: true,
        messageCount: 2,
        workspace: status(),
      } as SidecarFrame,
      CID,
    );
    expect(opened).toEqual({ type: 'opened', workspace: status() });
    let state = reduce(initialConversationState, opened!);
    expect(state.workspace).toEqual(status());

    const restoring = frameToAction(
      { type: 'workspace_status', conversationId: CID, status: status({ state: 'restoring' }) } as SidecarFrame,
      CID,
    );
    state = reduce(state, restoring!);
    expect(state.workspace?.state).toBe('restoring');
    expect(
      frameToAction(
        { type: 'workspace_status', conversationId: CID, status: { state: 'x' } } as unknown as SidecarFrame,
        CID,
      ),
    ).toBeNull();
    // Sin workspace (conversación sin ficheros): null.
    expect(
      reduce(state, { type: 'opened' }).workspace,
    ).toBeNull();
  });

  it('avisa solo en los últimos días, y nunca si está fijada o sin fecha', () => {
    expect(purgeIsNear(status(), NOW)).toBe(true);
    expect(purgeIsNear(status({ purgeAt: new Date(NOW + 5 * DAY).toISOString() }), NOW)).toBe(false);
    expect(purgeIsNear(status({ pinned: true, purgeAt: null }), NOW)).toBe(false);
    expect(purgeIsNear(status({ purgeAt: null }), NOW)).toBe(false);
    expect(purgeIsNear(null, NOW)).toBe(false);
    expect(describePurge(new Date(NOW + 2 * DAY).toISOString(), NOW)).toMatch(/^en 2 días/);
    expect(describePurge(new Date(NOW + 3_600_000).toISOString(), NOW)).toMatch(/^mañana/);
  });

  it('una tarjeta anterior a la purga se marca caducada y no tiene acciones', () => {
    const file = {
      path: 'outputs/resumen.csv',
      name: 'resumen.csv',
      size: 10,
      mime: 'text/csv',
      modifiedAt: '2026-09-01T10:00:00.000Z',
    };
    expect(isExpired(file, null)).toBe(false);
    expect(isExpired(file, '2026-09-20T00:00:00.000Z')).toBe(true);
    expect(isExpired({ ...file, modifiedAt: '2026-09-21T00:00:00.000Z' }, '2026-09-20T00:00:00.000Z')).toBe(false);
    expect(isExpired({ ...file, modifiedAt: '' }, '2026-09-20T00:00:00.000Z')).toBe(true);

    render(<FileCard conversationId={CID} file={file} expired />);
    expect(screen.getByText(/Caducado/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('<RetentionBanner>', () => {
  it('indica la restauración en curso', () => {
    render(
      <RetentionBanner status={status({ state: 'restoring' })} conversationId={CID} onPin={() => {}} />,
    );
    expect(screen.getByRole('status').textContent).toMatch(/Restaurando/);
  });

  it('nada si la purga queda lejos', () => {
    const { container } = render(
      <RetentionBanner
        status={status({ purgeAt: new Date(Date.now() + 20 * DAY).toISOString() })}
        conversationId={CID}
        onPin={() => {}}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('cerca de la purga: «Fijar» fija y «Descargar todo» pide el zip a Rust', async () => {
    const onPin = vi.fn();
    vi.mocked(invoke).mockResolvedValue(true);
    render(
      <RetentionBanner
        status={status({ purgeAt: new Date(Date.now() + DAY).toISOString() })}
        conversationId={CID}
        onPin={onPin}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/se eliminarán/);
    fireEvent.click(screen.getByRole('button', { name: 'Fijar' }));
    expect(onPin).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: /Descargar todo/ }));
    expect(invoke).toHaveBeenCalledWith('workspace_export', { conversationId: CID });
    await waitFor(() => expect(screen.getByText('Descargado.')).toBeTruthy());
  });

  it('un fallo al descargar se muestra', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('disco lleno'));
    render(
      <RetentionBanner
        status={status({ purgeAt: new Date(Date.now() + DAY).toISOString() })}
        conversationId={CID}
        onPin={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Descargar todo/ }));
    await waitFor(() => expect(screen.getByText('disco lleno')).toBeTruthy());
  });
});
