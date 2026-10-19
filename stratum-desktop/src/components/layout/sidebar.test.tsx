import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SessionsPanel } from './SessionsPanel';
import { OutlinePanel, outlineLabel } from './OutlinePanel';
import { StatusBar, contextTone, formatTokens } from './StatusBar';
import { togglePanel } from './Sidebar';
import { InputArea } from '../chat/InputArea';
import { matchCommands, parseCommand } from '../chat/commands';
import { sampleSession } from '../../../../stratum-cli/src/protocol/protocol.fixtures';
import { sessionItems, type SessionItem } from '../../view/sessions';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

afterEach(cleanup);

const now = Date.now();
const items: SessionItem[] = sessionItems({
  sessions: [
    sampleSession({ id: 'a', title: 'Plan de viaje a Lisboa', agent: 'assistant', origin: 'desktop', currentRunId: null, state: 'idle', host: { kind: 'daemon', client: 'daemon', connected: true }, updatedAt: now }),
    sampleSession({ id: 'b', title: 'Refactor del parser', agent: 'general', origin: 'cli', state: 'running', currentRunId: 'run_1', host: { kind: 'peer', client: 'cli', connected: true }, updatedAt: now - 1000 }),
    sampleSession({ id: 'c', title: '', agent: 'assistant', origin: 'dot', currentRunId: null, state: 'idle', host: { kind: 'daemon', client: 'daemon', connected: true }, updatedAt: now - 2000 }),
  ],
  approvals: [],
  questions: [{ id: 'q1', sessionId: 'c', runId: 'r', questions: [], requestedAt: now, expiresAt: null }],
  plans: [],
});

function panel(overrides: Partial<Parameters<typeof SessionsPanel>[0]> = {}) {
  const props = {
    items,
    listed: true,
    selectedId: 'a',
    creating: false,
    closing: new Set<string>(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<SessionsPanel {...props} />);
  return props;
}

describe('SessionsPanel (§7.1, M12)', () => {
  it('lista todas las sesiones del daemon con su procedencia, marca la activa y filtra al buscar', () => {
    const props = panel();
    expect(screen.getByRole('button', { name: /Plan de viaje/ }).getAttribute('aria-current')).toBe('page');
    // Las de otros clientes también están, y dicen de dónde vinieron.
    expect(screen.getByText(/código · desde terminal · en su terminal/)).toBeTruthy();
    expect(screen.getByText('Conversación nueva')).toBeTruthy();
    expect(screen.getByTitle('Espera a una persona')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Refactor/ }));
    expect(props.onSelect).toHaveBeenCalledWith('b');
    fireEvent.change(screen.getByLabelText('Buscar sesiones'), { target: { value: 'lisboa' } });
    expect(screen.queryByText('Refactor del parser')).toBeNull();
  });

  it('cerrar pide confirmación; no se ofrece con un run en marcha ni en una sesión de la terminal', () => {
    const props = panel();
    const rows = screen.getAllByRole('listitem');
    const closeA = within(rows[0]!).getByRole('button', { name: 'Cerrar la sesión' });
    fireEvent.click(closeA);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
    expect(props.onClose).toHaveBeenCalledWith('a');
    // La de la terminal (par) no se cierra desde aquí.
    expect(within(screen.getAllByRole('listitem')[1]!).queryByRole('button', { name: 'Cerrar la sesión' })).toBeNull();
  });

  it('antes de saber qué sesiones hay no dice que no hay ninguna', () => {
    panel({ items: [], listed: false });
    expect(screen.getByText('Esperando a Stratum…')).toBeTruthy();
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

describe('StatusBar (M12)', () => {
  it('modelo y contexto de la foto, dónde corre y desde dónde vino', () => {
    render(
      <StatusBar
        connection={{ kind: 'connected', serverVersion: '1', serverPlatform: 'x', protocol: 1, capabilities: [], features: [] }}
        session={sampleSession({
          model: 'gemma',
          origin: 'desktop',
          host: { kind: 'daemon', client: 'daemon', connected: true },
          context: { used: 28_000, max: 32_000, pct: 88, estimated: false },
        })}
        working={2}
      />,
    );
    const bar = screen.getByRole('contentinfo');
    expect(bar.textContent).toContain('gemma');
    expect(bar.textContent).toContain('28k / 32k');
    expect(bar.textContent).toContain('en el daemon · desde Desktop');
    expect(bar.textContent).toContain('2 sesiones trabajando');
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
    expect(matchCommands('/c')?.map((c) => c.name)).toEqual(['context']);
    expect(matchCommands('/model gemma')).toBeNull();
    expect(matchCommands('hola')).toBeNull();
    expect(parseCommand('/model  gemma-4 ')).toEqual({ ok: true, name: 'model', arg: 'gemma-4' });
    expect(parseCommand('/context ya')).toMatchObject({ ok: false });
    // Lo que era del runtime propio de Desktop ya no existe (M12).
    expect(parseCommand('/clear')).toMatchObject({ ok: false });
    expect(parseCommand('/compact')).toMatchObject({ ok: false });
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
    fireEvent.change(box, { target: { value: '/con' } });
    expect(screen.getByRole('listbox', { name: 'Comandos' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('context', '');
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

describe('InputArea con un run en marcha (M12)', () => {
  it('sin steer solo se puede detener; con steer, escribir redirige y vacío sigue siendo detener', () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <InputArea disabled={false} generating onSend={onSend} onCancel={onCancel} />,
    );
    const box = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(box, { target: { value: 'otra cosa' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Detener' })).toBeTruthy();

    rerender(<InputArea disabled={false} generating steer onSend={onSend} onCancel={onCancel} />);
    expect(screen.getByRole('button', { name: 'Redirigir' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('otra cosa', []);
    expect(screen.getByRole('button', { name: 'Detener' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detener' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
