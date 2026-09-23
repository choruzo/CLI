import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ConversationSummary } from '../../ipc/types';
import { ConversationsPanel } from './ConversationsPanel';
import { OutlinePanel, outlineLabel } from './OutlinePanel';
import { MemoryPanel } from './MemoryPanel';
import { StatusBar, contextTone, formatTokens } from './StatusBar';
import { togglePanel } from './Sidebar';
import { InputArea } from '../chat/InputArea';
import { matchCommands, parseCommand } from '../chat/commands';
import { initialSidecarState } from '../../hooks/useSidecar';
import type { Memory } from '../../hooks/useMemory';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const A = '6f1c1c0e-3d2a-4b8e-9c1d-00000000000a';
const B = '6f1c1c0e-3d2a-4b8e-9c1d-00000000000b';
const now = new Date().toISOString();
const item = (id: string, title: string): ConversationSummary => ({
  conversationId: id,
  title,
  titleEdited: false,
  createdAt: now,
  updatedAt: now,
  provider: 'local',
  model: 'gemma',
  turnCount: 2,
  workspace: null,
});

function panel(overrides: Partial<Parameters<typeof ConversationsPanel>[0]> = {}) {
  const props = {
    list: [item(A, 'Plan de viaje a Lisboa'), item(B, 'Receta de pan')],
    loaded: true,
    activeId: A,
    byId: {},
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    ...overrides,
  };
  render(<ConversationsPanel {...props} />);
  return props;
}

describe('ConversationsPanel (§7.1)', () => {
  it('lista agrupada, marca la activa y filtra al buscar', () => {
    const props = panel();
    expect(screen.getByRole('heading', { name: 'Hoy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Plan de viaje/ }).getAttribute('aria-current')).toBe('page');
    fireEvent.change(screen.getByLabelText('Buscar conversaciones'), { target: { value: 'pan' } });
    expect(screen.queryByText('Plan de viaje a Lisboa')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Receta de pan/ }));
    expect(props.onSelect).toHaveBeenCalledWith(B);
    fireEvent.change(screen.getByLabelText('Buscar conversaciones'), { target: { value: 'zzz' } });
    expect(screen.getByText(/No se encontraron conversaciones para «zzz»/)).toBeTruthy();
  });

  it('empty state sin conversaciones guardadas', () => {
    panel({ list: [] });
    expect(screen.getByText(/Sin conversaciones guardadas/)).toBeTruthy();
  });

  it('renombrar en el sitio: Enter guarda, Escape cancela', () => {
    const props = panel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Renombrar' })[1]!);
    const input = screen.getByLabelText('Nuevo título');
    fireEvent.change(input, { target: { value: 'Pan de centeno' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRename).toHaveBeenCalledWith(B, 'Pan de centeno');
    fireEvent.click(screen.getAllByRole('button', { name: 'Renombrar' })[0]!);
    fireEvent.keyDown(screen.getByLabelText('Nuevo título'), { key: 'Escape' });
    expect(props.onRename).toHaveBeenCalledTimes(1);
  });

  it('eliminar pide confirmación en línea', () => {
    const props = panel();
    fireEvent.click(screen.getAllByRole('button', { name: 'Eliminar' })[0]!);
    expect(screen.getByText(/¿Eliminar esta conversación y sus ficheros\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(props.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Eliminar' })[0]!);
    const group = screen.getByRole('group');
    fireEvent.click(within(group).getByRole('button', { name: 'Eliminar' }));
    expect(props.onDelete).toHaveBeenCalledWith(A);
  });

  it('no se puede eliminar una conversación que está generando', () => {
    panel({
      byId: {
        [A]: {
          messages: [],
          activeTurnId: 't1',
          pendingQuestions: null,
          pendingConfirm: null,
          todos: [],
          opened: true,
          notice: null,
          workspace: null,
          title: null,
          stats: null,
          info: null,
        },
      },
    });
    const del = screen.getAllByRole('button', { name: 'Eliminar' })[0] as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(screen.getByLabelText('Generando')).toBeTruthy();
  });
});

describe('OutlinePanel (§7.2)', () => {
  it('solo mensajes del usuario, recortados; clic salta al mensaje', () => {
    const onJump = vi.fn();
    render(
      <OutlinePanel
        messages={[
          { role: 'user', turnId: 't1', text: 'a'.repeat(80) },
          { role: 'agent', turnId: 't1', parts: [], toolCalls: {}, status: 'done' },
          { role: 'user', turnId: 't2', text: 'segunda' },
        ]}
        visibleTurnId="t2"
        onJump={onJump}
      />,
    );
    const items = screen.getAllByRole('button');
    expect(items).toHaveLength(2);
    expect(items[1]!.getAttribute('aria-current')).toBe('location');
    fireEvent.click(items[0]!);
    expect(onJump).toHaveBeenCalledWith('t1');
    expect(outlineLabel('  hola\n  mundo ', 'x')).toBe('hola mundo');
  });
});

describe('MemoryPanel (§7.3)', () => {
  function memory(patch: Partial<Memory> = {}): Memory {
    return {
      global: { path: '/h/.stratum/STRATUM.md', exists: true, content: '# Yo', mtimeMs: 111 },
      decisions: [
        {
          id: 'd1',
          title: 'Usa tablas',
          content: 'Prefiere tablas',
          type: 'user_preference',
          tags: ['formato'],
          importance: 'medium',
          timestamp: now,
        },
      ],
      conflict: null,
      error: null,
      saving: false,
      savedAt: null,
      refresh: vi.fn(),
      save: vi.fn(),
      forget: vi.fn(),
      dismissConflict: vi.fn(),
      ...patch,
    };
  }

  it('edita el STRATUM.md y guarda sobre la versión leída', () => {
    const m = memory();
    render(<MemoryPanel memory={m} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    fireEvent.change(screen.getByLabelText('Contenido de STRATUM.md'), { target: { value: '# Nuevo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(m.save).toHaveBeenCalledWith('# Nuevo', 111);
  });

  it('conflicto: se puede cargar la versión del disco o sobrescribir', () => {
    const m = memory({ conflict: { content: '# CLI', mtimeMs: 222 } });
    render(<MemoryPanel memory={m} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByText(/cambió en disco/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sobrescribir con la mía' }));
    expect(m.save).toHaveBeenCalledWith('# Yo', 222);
  });

  it('busca y olvida decisiones con confirmación', () => {
    const m = memory();
    render(<MemoryPanel memory={m} />);
    fireEvent.change(screen.getByLabelText('Buscar decisiones'), { target: { value: 'formato' } });
    expect(screen.getByText('Usa tablas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Olvidar «Usa tablas»' }));
    fireEvent.click(screen.getByRole('button', { name: 'Olvidar' }));
    expect(m.forget).toHaveBeenCalledWith('d1');
  });
});

describe('StatusBar', () => {
  it('modelo, contexto con los umbrales de la CLI y tamaño de ficheros', () => {
    render(
      <StatusBar
        sidecar={initialSidecarState}
        stats={{ provider: 'local', model: 'gemma', context: { used: 28_000, max: 32_000, pct: 88, estimated: false } }}
        workspace={{
          state: 'active',
          pinned: false,
          lastUsedAt: now,
          purgeAt: null,
          filesExpiredAt: null,
          sizeBytes: 2048,
        }}
        generating={1}
        queued={1}
      />,
    );
    const bar = screen.getByRole('contentinfo');
    expect(bar.textContent).toContain('gemma');
    expect(bar.textContent).toContain('28k / 32k');
    expect(bar.textContent).toContain('2.0 KB');
    expect(bar.textContent).toContain('1 generando · 1 en cola');
    expect(contextTone(59)).toBe('ok');
    expect(contextTone(60)).toBe('warn');
    expect(contextTone(85)).toBe('error');
    expect(formatTokens(4200)).toBe('4.2k');
  });
});

describe('Sidebar', () => {
  it('clic en el icono activo pliega; en otro, abre ese panel', () => {
    expect(togglePanel({ open: true, panel: 'memory' }, 'memory')).toEqual({ open: false, panel: 'memory' });
    expect(togglePanel({ open: false, panel: 'memory' }, 'files')).toEqual({ open: true, panel: 'files' });
  });
});

describe('slash-commands', () => {
  it('menú mientras se escribe el nombre; parseo con argumentos', () => {
    expect(matchCommands('/c')?.map((c) => c.name)).toEqual(['clear', 'compact']);
    expect(matchCommands('/model gemma')).toBeNull();
    expect(matchCommands('hola')).toBeNull();
    expect(parseCommand('/model  gemma-4 ')).toEqual({ ok: true, name: 'model', arg: 'gemma-4' });
    expect(parseCommand('/clear ya')).toMatchObject({ ok: false });
    expect(parseCommand('/init')).toMatchObject({ ok: false, error: expect.stringContaining('desconocido') });
    // Una ruta no es un comando: se envía como mensaje.
    expect(parseCommand('/etc/hosts no resuelve')).toBeNull();
    expect(parseCommand('hola')).toBeNull();
  });

  it('InputArea: / abre el menú, Enter ejecuta y un comando no se envía como mensaje', () => {
    const onSend = vi.fn();
    const onCommand = vi.fn();
    render(
      <InputArea disabled={false} generating={false} onSend={onSend} onCancel={vi.fn()} onCommand={onCommand} />,
    );
    const box = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(box, { target: { value: '/cl' } });
    expect(screen.getByRole('listbox', { name: 'Comandos' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('clear', '');
    // /model con argumento: Tab completa y Enter envía el comando.
    fireEvent.change(box, { target: { value: '/mo' } });
    fireEvent.keyDown(box, { key: 'Tab' });
    expect((box as HTMLTextAreaElement).value).toBe('/model ');
    fireEvent.change(box, { target: { value: '/model gemma' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommand).toHaveBeenLastCalledWith('model', 'gemma');
    // Desconocido: aviso, nada enviado.
    fireEvent.change(box, { target: { value: '/nada' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toContain('desconocido');
    expect(onSend).not.toHaveBeenCalled();
    // Un mensaje normal sí se envía.
    fireEvent.change(box, { target: { value: 'hola' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hola', []);
  });
});
