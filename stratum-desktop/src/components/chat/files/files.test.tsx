import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { FileCard, kindLabel } from './FileCard';
import { DraftChips } from './AttachmentChips';
import { parseDelimited } from './csv';
import { InputArea } from '../InputArea';
import { canOpen } from '../../../ipc/files';
import { workspaceFiles } from '../../../ipc/validate';
import { frameToAction } from '../../../hooks/useAgentStream';
import { candidatesToDrafts, type Attachments } from '../../../hooks/useAttachments';
import {
  conversationReducer as reduce,
  initialConversationState,
  type AgentTurn,
  type ConversationAction,
} from '../../../hooks/conversation-reducer';
import type { SidecarFrame } from '../../../ipc/types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const CID = '6f1c1c0e-3d2a-4b8e-9c1d-2f3a4b5c6d7e';
const CSV = {
  path: 'outputs/resumen.csv',
  name: 'resumen.csv',
  size: 2048,
  mime: 'text/csv',
  modifiedAt: '2026-09-22T10:00:00.000Z',
};

describe('parseDelimited', () => {
  it('respeta comillas, comillas escapadas y saltos dentro de un campo', () => {
    expect(parseDelimited('a,b\n"x, y","di ""hola""\nadiós"\n', ',')).toEqual([
      ['a', 'b'],
      ['x, y', 'di "hola"\nadiós'],
    ]);
    expect(parseDelimited('a\tb\r\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('1\n2\n3\n', ',', 2)).toHaveLength(2);
  });
});

describe('workspace_files en el webview', () => {
  it('solo acepta rutas de outputs/ sin ..', () => {
    const files = workspaceFiles([
      CSV,
      { ...CSV, path: 'inputs/orig.csv' },
      { ...CSV, path: 'outputs/../inputs/x' },
      { ...CSV, path: '/etc/passwd' },
      { nada: 1 },
    ]);
    expect(files?.map((f) => f.path)).toEqual(['outputs/resumen.csv']);
  });

  it('frameToAction y el reducer adjuntan los ficheros al turno', () => {
    const action = frameToAction(
      {
        type: 'workspace_files',
        conversationId: CID,
        turnId: 't1',
        files: [CSV],
      } as unknown as SidecarFrame,
      CID,
    );
    expect(action).toEqual({ type: 'workspace_files', turnId: 't1', files: [CSV] });
    const actions: ConversationAction[] = [
      {
        type: 'user_sent',
        turnId: 't1',
        text: '',
        attachments: [{ path: 'inputs/a.csv', name: 'a.csv', size: 3 }],
      },
      action!,
      // Reescrito en el mismo turno: sustituye a la tarjeta anterior.
      { type: 'workspace_files', turnId: 't1', files: [{ ...CSV, size: 10 }] },
    ];
    const state = actions.reduce(reduce, initialConversationState);
    const user = state.messages[0];
    expect(user?.role === 'user' && user.attachments?.[0]?.path).toBe('inputs/a.csv');
    const turn = state.messages[1] as AgentTurn;
    expect(turn.files).toEqual([{ ...CSV, size: 10 }]);
  });
});

describe('FileCard', () => {
  it('muestra nombre, tipo y tamaño, y guarda con el diálogo de Rust', async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    render(<FileCard conversationId={CID} file={CSV} />);
    expect(screen.getByText('resumen.csv')).toBeTruthy();
    expect(screen.getByText('CSV · 2.0 KB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Guardar como…' }));
    await waitFor(() => expect(screen.getByText('Guardado.')).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith('output_save', {
      conversationId: CID,
      path: 'outputs/resumen.csv',
    });
  });

  it('la vista previa de un CSV se pinta como tabla', async () => {
    vi.mocked(invoke).mockResolvedValue({
      kind: 'text',
      text: 'mes,total\nenero,10\n',
      truncated: false,
    });
    render(<FileCard conversationId={CID} file={CSV} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vista previa' }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(screen.getByRole('columnheader', { name: 'total' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'enero' })).toBeTruthy();
  });

  it('no ofrece «Abrir» para ficheros activos (html, svg, scripts)', () => {
    for (const name of ['x.html', 'x.svg', 'x.bat', 'x.ps1', 'x.js']) {
      expect(canOpen(name), name).toBe(false);
      cleanup();
      render(
        <FileCard
          conversationId={CID}
          file={{ ...CSV, name, path: `outputs/${name}`, mime: 'text/html' }}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Abrir' })).toBeNull();
    }
    expect(kindLabel({ ...CSV, name: 'a.png', mime: 'image/png' })).toBe('Imagen PNG');
  });

  it('cancelar el diálogo de guardar no dice «Guardado»', async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    render(<FileCard conversationId={CID} file={CSV} />);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar como…' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('Guardado.')).toBeNull();
  });
});

function attachments(partial: Partial<Attachments>): Attachments {
  return {
    items: [],
    dragging: false,
    readyPaths: [],
    busy: false,
    pick: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    error: null,
    ...partial,
  };
}

describe('adjuntos en el InputArea', () => {
  it('un candidato por encima del límite se muestra rechazado y no se copia', () => {
    const drafts = candidatesToDrafts([
      { id: 'a', name: 'ok.csv', size: 10 },
      { id: 'b', name: 'enorme.bin', size: 99, error: 'supera el límite de 25.0 MB por fichero' },
    ]);
    expect(drafts.map((d) => d.status)).toEqual(['copying', 'rejected']);
    render(<DraftChips items={drafts} onRemove={vi.fn()} />);
    expect(screen.getByText(/No se adjuntará: supera el límite/)).toBeTruthy();
  });

  it('envía las rutas listas del workspace y limpia los adjuntos', () => {
    const onSend = vi.fn();
    const clear = vi.fn();
    render(
      <InputArea
        disabled={false}
        generating={false}
        onSend={onSend}
        onCancel={vi.fn()}
        attachments={attachments({
          clear,
          items: [
            { id: 'a', name: 'ventas.csv', size: 5, status: 'ready', path: 'inputs/ventas.csv' },
            { id: 'b', name: 'x.bin', size: 5, status: 'rejected', error: 'no' },
          ],
        })}
      />,
    );
    // Sin texto también se puede enviar: lleva un fichero.
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSend).toHaveBeenCalledWith('', [
      { path: 'inputs/ventas.csv', name: 'ventas.csv', size: 5 },
    ]);
    expect(clear).toHaveBeenCalled();
  });

  it('no se puede enviar mientras un adjunto se está copiando', () => {
    const pick = vi.fn();
    render(
      <InputArea
        disabled={false}
        generating={false}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        attachments={attachments({
          busy: true,
          pick,
          items: [{ id: 'a', name: 'grande.pdf', size: 5, status: 'copying' }],
        })}
      />,
    );
    const send = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Adjuntar ficheros' }));
    expect(pick).toHaveBeenCalled();
  });
});
