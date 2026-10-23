import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  sampleRun,
  sampleSession,
  sampleSnapshot,
} from '../../stratum-cli/src/protocol/protocol.fixtures';
import { App } from './App';
import { initialProtocolState, protocolStore } from './client/protocol-store';
import { uiStore } from './client/ui-store';
import type { ConnectionState, DesktopEvent, NativeBridge } from './ipc/native';
import type { ProtocolChatMessage, ProtocolSession } from './protocol';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve([])), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => {}),
  }),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

/**
 * M12 — Desktop como cliente de `stratumd`, de punta a punta en el webview: lo
 * que se pinta sale de lo que cuenta el daemon (foto de conjunto, foto de la
 * sesión, eventos) y nada más.
 */

const SID = 'ses_20261012_abc123';
const DAEMON = { kind: 'daemon' as const, client: 'daemon' as const, connected: true };

function connected(capabilities = ['observe', 'control']): ConnectionState {
  return { kind: 'connected', serverVersion: '0.9', serverPlatform: 'x', protocol: 1, capabilities, features: [] };
}

const msg = (seq: number, kind: 'user' | 'assistant', text: string, runId = `run_${seq}`): ProtocolChatMessage => ({
  id: `m${seq}`,
  runId,
  at: seq,
  kind,
  text,
});

function idleSession(overrides: Partial<ProtocolSession> = {}): ProtocolSession {
  return sampleSession({
    title: 'Plan de viaje',
    host: DAEMON,
    origin: 'desktop',
    agent: 'assistant',
    state: 'idle',
    currentRunId: null,
    ...overrides,
  });
}

function rig() {
  let handler: ((e: DesktopEvent) => void) | null = null;
  const native: NativeBridge = {
    attach: vi.fn(async () => ({ desktopVersion: '0', protocol: 1 })),
    retry: vi.fn(async () => undefined),
    focusSession: vi.fn(async () => undefined),
    resyncSession: vi.fn(async () => undefined),
    pauseRun: vi.fn(async () => 'requested'),
    resumeRun: vi.fn(async () => 'resumed'),
    cancelRun: vi.fn(async () => 'cancelled'),
    steerRun: vi.fn(async () => 'accepted'),
    newChat: vi.fn(async () => ({ session: idleSession({ id: 'ses_new' }) })),
    startRun: vi.fn(async () => ({ run: sampleRun({ id: 'run_9', sessionId: SID }) })),
    listModels: vi.fn(async () => ({ models: [] })),
    setModel: vi.fn(async () => ({ session: idleSession() })),
    closeSession: vi.fn(async () => ({})),
    history: vi.fn(async () => ({ messages: [msg(1, 'user', 'lo primero')], hasMore: false, total: 3 })),
    context: vi.fn(async () => ({})),
    memory: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => ({ skills: [] })),
    prefs: vi.fn(async () => {
      throw new Error('sin prefs en el test');
    }),
    openConfig: vi.fn(async () => undefined),
    onEvent: vi.fn(async (h) => {
      handler = h;
      return () => (handler = null);
    }),
  };
  const emit = (event: DesktopEvent) => act(() => handler?.(event));
  return { native, emit };
}

beforeEach(() => {
  protocolStore.set(initialProtocolState);
  uiStore.set({ selectedId: SID, pending: [], notices: [] });
  localStorage.clear();
});
afterEach(cleanup);

describe('Desktop sobre stratumd (M12)', () => {
  it('reconstruye lista y conversación desde las fotos; tras reconectar manda la foto nueva', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    await waitFor(() => expect(native.attach).toHaveBeenCalled());
    // La sesión elegida la última vez se vuelve a mirar al abrir.
    expect(native.focusSession).toHaveBeenCalledWith(SID);

    await emit({ type: 'connection', state: connected() });
    await emit({ type: 'overview', overview: { sessions: [idleSession()], approvals: [], questions: [], plans: [] } });
    await emit({
      type: 'snapshot',
      sessionId: SID,
      snapshot: sampleSnapshot({
        session: idleSession(),
        run: null,
        messages: [msg(2, 'user', '¿Qué visito?'), msg(3, 'assistant', 'El Alfama.', 'run_2')],
        messagesTruncated: true,
      }),
    });
    expect(screen.getAllByText('Plan de viaje').length).toBeGreaterThan(0);
    expect(screen.getByText('¿Qué visito?')).toBeTruthy();
    expect(screen.getByText('El Alfama.')).toBeTruthy();

    // Lo anterior, bajo demanda (M11), antes de lo que trae la foto.
    fireEvent.click(screen.getByRole('button', { name: 'Ver mensajes anteriores' }));
    await waitFor(() => expect(screen.getByText('lo primero')).toBeTruthy());
    expect(native.history).toHaveBeenCalledWith(SID, 'm2', 50);

    // Se cae el daemon y vuelve: la foto que llega sustituye a lo que había.
    await emit({ type: 'connection', state: { kind: 'reconnecting', attempt: 1 } });
    expect(screen.getByRole('alert').textContent).toMatch(/Reconectando/);
    await emit({ type: 'connection', state: connected() });
    await emit({
      type: 'snapshot',
      sessionId: SID,
      snapshot: sampleSnapshot({
        session: idleSession({ seq: 9 }),
        seq: 9,
        run: null,
        messages: [msg(8, 'user', 'Después del reinicio')],
      }),
    });
    expect(screen.getByText('Después del reinicio')).toBeTruthy();
    expect(screen.queryByText('El Alfama.')).toBeNull();
  });

  it('un mensaje es una petición: no se pinta hasta que el daemon lo publica', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit({ type: 'overview', overview: { sessions: [idleSession()], approvals: [], questions: [], plans: [] } });
    await emit({ type: 'snapshot', sessionId: SID, snapshot: sampleSnapshot({ session: idleSession(), run: null, messages: [] }) });

    const box = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(box, { target: { value: 'Hola' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(native.startRun).toHaveBeenCalledWith(SID, 'Hola'));
    // Aceptado no es pintado: el mensaje no aparece hasta que llega en la foto.
    expect(screen.queryByText('Hola')).toBeNull();
    await emit({
      type: 'snapshot',
      sessionId: SID,
      snapshot: sampleSnapshot({
        session: idleSession({ state: 'running', currentRunId: 'run_9' }),
        run: sampleRun({ id: 'run_9', sessionId: SID }),
        messages: [msg(4, 'user', 'Hola', 'run_9')],
        partial: { text: 'Pensando', reasoning: '' },
      }),
    });
    expect(screen.getByText('Hola')).toBeTruthy();
    // Con un run en marcha, el campo redirige y hay controles del run.
    expect(screen.getByRole('group', { name: 'Trabajo en marcha' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(native.pauseRun).toHaveBeenCalledWith(SID, 'run_9'));
    expect(screen.getByText('Pausa pedida…')).toBeTruthy();
  });

  it('observar no es conducir: sin `control` se ve todo pero no se escribe', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected(['observe']) });
    await emit({ type: 'overview', overview: { sessions: [idleSession()], approvals: [], questions: [], plans: [] } });
    await emit({
      type: 'snapshot',
      sessionId: SID,
      snapshot: sampleSnapshot({ session: idleSession(), run: null, messages: [msg(2, 'user', 'visible')] }),
    });
    expect(screen.getByText('visible')).toBeTruthy();
    expect((screen.getByLabelText('Mensaje para el asistente') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/no permite a Desktop conducir/)).toBeTruthy();
  });

  it('lo pendiente de aprobar se ve, pero Desktop no lo resuelve', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    const waiting = sampleSnapshot({ session: idleSession({ state: 'waiting', currentRunId: 'run_1' }) });
    await emit({ type: 'overview', overview: { sessions: [waiting.session], approvals: waiting.approvals, questions: [], plans: [] } });
    await emit({ type: 'snapshot', sessionId: SID, snapshot: waiting });
    expect(screen.getByText(/La sesión espera una aprobación/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Aprobar/ })).toBeNull();
  });

  it('una sesión que se cierra desde otro cliente desaparece mientras se mira', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit({ type: 'overview', overview: { sessions: [idleSession()], approvals: [], questions: [], plans: [] } });
    await emit({ type: 'snapshot', sessionId: SID, snapshot: sampleSnapshot({ session: idleSession(), run: null }) });
    await emit({
      type: 'overview-events',
      events: [{ type: 'session.closed', sessionId: SID, seq: 20, at: 1, data: { reason: 'closed' } }],
    });
    expect(screen.getByText(/ya no existe o no está disponible/)).toBeTruthy();
  });
});

describe('elegir provider y modelo desde el composer', () => {
  const MODELS = {
    models: [
      { provider: 'local', id: 'test-model', contextWindow: null, default: true },
      { provider: 'local', id: 'otro-local', contextWindow: null },
      { provider: 'nube', id: 'grande', contextWindow: 128000 },
      { provider: 'nube', id: 'rapido', contextWindow: null },
    ],
  };

  it('en una sesión: primero el provider, después su modelo; cambiar de provider lo envía', async () => {
    const { native, emit } = rig();
    native.listModels = vi.fn(async () => MODELS);
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit({ type: 'overview', overview: { sessions: [idleSession()], approvals: [], questions: [], plans: [] } });
    await emit({ type: 'snapshot', sessionId: SID, snapshot: sampleSnapshot({ session: idleSession(), run: null, messages: [] }) });

    fireEvent.click(screen.getByRole('button', { name: /^Modelo: local · test-model/ }));
    const providers = await screen.findByRole('listbox', { name: 'Providers' });
    expect(providers.textContent).toMatch(/local.*2 modelos.*actual/);
    fireEvent.click(screen.getByRole('button', { name: /^nube/ }));
    const models = screen.getByRole('listbox', { name: 'Modelos disponibles' });
    expect(models.textContent).toBe('granderapido');
    fireEvent.click(screen.getByRole('button', { name: 'rapido' }));
    await waitFor(() => expect(native.setModel).toHaveBeenCalledWith(SID, 'rapido', 'nube'));
    expect(screen.queryByRole('listbox')).toBeNull();

    // El mismo provider: solo el modelo.
    fireEvent.click(screen.getByRole('button', { name: /^Modelo: local · test-model/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^local/ }));
    fireEvent.click(screen.getByRole('button', { name: 'otro-local' }));
    await waitFor(() => expect(native.setModel).toHaveBeenLastCalledWith(SID, 'otro-local', undefined));
  });

  it('en una conversación nueva: lo elegido abre la sesión con ese provider y modelo', async () => {
    uiStore.set({ selectedId: null, pending: [], notices: [] });
    const { native, emit } = rig();
    native.listModels = vi.fn(async () => MODELS);
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit({ type: 'overview', overview: { sessions: [], approvals: [], questions: [], plans: [] } });

    // Sin elegir nada, el de la config.
    const chip = await screen.findByRole('button', { name: /^Modelo: local · test-model/ });
    // `/model` también abre el selector, sin sesión.
    const box = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(box, { target: { value: '/model' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('button', { name: /^nube/ }));
    fireEvent.click(screen.getByRole('button', { name: 'grande' }));
    expect(chip.textContent).toBe('nube · grande');
    expect(native.setModel).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: 'Hola' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(native.newChat).toHaveBeenCalledWith({ provider: 'nube', model: 'grande' }));
  });
});
