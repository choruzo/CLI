import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  sampleRun,
  sampleSession,
  sampleSnapshot,
} from '../../stratum-cli/src/protocol/protocol.fixtures';
import { App } from './App';
import { approvalsStore } from './client/approvals';
import { initialProtocolState, protocolStore } from './client/protocol-store';
import { uiStore } from './client/ui-store';
import type { ApproverStatus, ConnectionState, DesktopEvent, NativeBridge } from './ipc/native';
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
    traceSession: vi.fn(async () => undefined),
    pauseRun: vi.fn(async () => 'requested'),
    resumeRun: vi.fn(async () => 'resumed'),
    cancelRun: vi.fn(async () => 'cancelled'),
    steerRun: vi.fn(async () => 'accepted'),
    newChat: vi.fn(async () => ({ session: idleSession({ id: 'ses_new' }) })),
    startRun: vi.fn(async () => ({ run: sampleRun({ id: 'run_9', sessionId: SID }) })),
    savePastedImage: vi.fn(async () => '/home/u/.stratum/images/1-abc.png'),
    listModels: vi.fn(async () => ({ models: [] })),
    setModel: vi.fn(async () => ({ session: idleSession() })),
    closeSession: vi.fn(async () => ({})),
    history: vi.fn(async () => ({ messages: [msg(1, 'user', 'lo primero')], hasMore: false, total: 3 })),
    context: vi.fn(async () => ({})),
    memory: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => ({ skills: [] })),
    memoryDecisions: vi.fn(async () => ({ decisions: [] })),
    memoryForget: vi.fn(async () => ({ removed: true })),
    memoryMove: vi.fn(async () => ({ updated: true })),
    memoryProposals: vi.fn(async () => ({ proposals: [] })),
    memoryDream: vi.fn(async () => ({
      status: 'done',
      message: 'ok',
      proposals: [],
      discarded: 0,
      tokens: null,
    })),
    memoryApplyProposal: vi.fn(async () => ({ applied: true, message: 'ok' })),
    memoryRejectProposal: vi.fn(async () => ({ rejected: true, message: 'ok' })),
    prefs: vi.fn(async () => {
      throw new Error('sin prefs en el test');
    }),
    openConfig: vi.fn(async () => undefined),
    settingsGet: vi.fn(async () => {
      throw new Error('sin ajustes en el test');
    }),
    settingsSet: vi.fn(async () => {
      throw new Error('sin ajustes en el test');
    }),
    settingsAddProvider: vi.fn(async () => {
      throw new Error('sin ajustes en el test');
    }),
    approverStatus: vi.fn(async (): Promise<ApproverStatus> => ({ kind: 'locked', reason: 'initial' })),
    unlockApprovals: vi.fn(async () => undefined),
    lockApprovals: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    deny: vi.fn(async () => undefined),
    answerQuestions: vi.fn(async () => undefined),
    decidePlan: vi.fn(async () => undefined),
    pickProjectFolder: vi.fn(async () => null),
    newCodeSession: vi.fn(async () => ({ session: idleSession({ id: 'ses_code', agent: 'general' }) })),
    listAgents: vi.fn(async () => ({ agents: [] })),
    setAgent: vi.fn(async () => ({ session: idleSession() })),
    setReadOnly: vi.fn(async () => ({ session: idleSession() })),
    setSessionProfile: vi.fn(async () => ({ session: idleSession() })),
    inspectSession: vi.fn(async () => ({
      inspection: {
        profile: {
          requested: 'auto',
          active: 'code',
          detection: { detected: false, reasons: [] },
          available: [
            { name: 'code', description: 'desarrollo', allowedTools: null, hiddenTools: ['ssh_exec'], source: 'builtin' },
            { name: 'infra', description: 'infraestructura', allowedTools: null, hiddenTools: [], source: 'builtin' },
          ],
        },
        tools: [
          { name: 'read_file', source: 'builtin' },
          { name: 'mcp__docs__search', source: 'mcp' },
        ],
        mcp: [{ name: 'docs', status: 'connected', tools: 1 }],
        plugins: { enabled: true, loaded: [], skipped: [] },
        environments: [],
        truncated: false,
      },
    })),
    cancelJob: vi.fn(async () => ({})),
    gitChanges: vi.fn(async () => ({
      changes: { isRepo: false, files: 0, added: 0, deleted: 0, changes: [], truncated: false },
    })),
    gitDiff: vi.fn(async () => ({ diff: '', truncated: false, binary: false })),
    browserScreen: vi.fn(async () => ({ browser: { state: 'closed' }, screen: null })),
    browserNavigate: vi.fn(async () => ({ browser: { state: 'closed' } })),
    revertPlan: vi.fn(async () => ({ status: 'nothing', plan: null })),
    revert: vi.fn(async () => ({ status: 'nothing', plan: null })),
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
  approvalsStore.set({ status: { kind: 'unavailable', reason: 'not-connected' }, resolutions: {} });
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
    await waitFor(() => expect(native.startRun).toHaveBeenCalledWith(SID, 'Hola', []));
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

  it('la trayectoria se pide solo con el panel abierto, conectado y con la sesión elegida', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    // Con el panel cerrado (por defecto) no se pide ninguna traza.
    await emit({ type: 'connection', state: connected() });
    await emit({ type: 'overview', overview: { sessions: [idleSession()], approvals: [], questions: [], plans: [] } });
    expect(native.traceSession).toHaveBeenLastCalledWith(null);
    expect(screen.queryByLabelText('Trayectoria', { selector: 'aside' })).toBeNull();

    // El botón del raíl la abre y se pide la traza de la sesión que se mira.
    fireEvent.click(screen.getByRole('button', { name: 'Trayectoria (Ctrl+J)' }));
    await waitFor(() => expect(native.traceSession).toHaveBeenLastCalledWith(SID));
    expect(screen.getByText('Cargando la trayectoria…')).toBeTruthy();

    // Lo que llega se pinta; lo de otra sesión, no.
    await emit({
      type: 'trace-records',
      sessionId: SID,
      reset: true,
      format: 1,
      records: [
        { t: 'turn', at: 1000, input: 'lee a.txt' },
        { t: 'begin', at: 1010, id: 'm1', kind: 'model', name: 'qwen', data: { origin: 'agent' } },
        { t: 'end', at: 1200, id: 'm1', status: 'ok', data: { text: 'hecho', usage: { promptTokens: 900, completionTokens: 22, totalTokens: 922 } } },
      ],
    });
    await emit({ type: 'trace-records', sessionId: 'otra', reset: true, format: 1, records: [{ t: 'turn', at: 1, input: 'no soy yo' }] });
    expect(screen.getByText('lee a.txt')).toBeTruthy();
    expect(screen.queryByText('no soy yo')).toBeNull();
    expect(screen.getByText('922 tok')).toBeTruthy();

    // Perder la conexión suelta la traza; al volver se pide otra vez.
    await emit({ type: 'connection', state: { kind: 'reconnecting', attempt: 1 } });
    await waitFor(() => expect(native.traceSession).toHaveBeenLastCalledWith(null));
    await emit({ type: 'connection', state: connected() });
    await waitFor(() => expect(native.traceSession).toHaveBeenLastCalledWith(SID));

    // Ctrl+J la cierra y deja de pedirse.
    fireEvent.keyDown(document.body, { key: 'j', code: 'KeyJ', ctrlKey: true });
    await waitFor(() => expect(native.traceSession).toHaveBeenLastCalledWith(null));
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

  async function waitingRig() {
    const r = rig();
    render(<App native={r.native} />);
    await r.emit({ type: 'connection', state: connected() });
    const waiting = sampleSnapshot({ session: idleSession({ state: 'waiting', currentRunId: 'run_1' }) });
    await r.emit({
      type: 'overview',
      overview: { sessions: [waiting.session], approvals: waiting.approvals, questions: [], plans: [] },
    });
    await r.emit({ type: 'snapshot', sessionId: SID, snapshot: waiting });
    return r;
  }

  it('lo pendiente se ve con su tarjeta; bloqueado no se resuelve, y desbloquear abre la ventana nativa', async () => {
    const { native, emit } = await waitingRig();
    await emit({ type: 'approver', status: { kind: 'locked', reason: 'initial' } });
    expect(screen.getByText('Necesita tu aprobación')).toBeTruthy();
    expect(screen.getByText('git push origin main')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Denegar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Desbloquea las aprobaciones/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear' }));
    expect(native.unlockApprovals).toHaveBeenCalledTimes(1);
    expect(native.approve).not.toHaveBeenCalled();
  });

  it('desbloqueado: aprobar pide la confirmación nativa, una vez, y no marca nada hasta la foto', async () => {
    const { native, emit } = await waitingRig();
    let confirm: () => void = () => undefined;
    vi.mocked(native.approve).mockImplementation(() => new Promise<void>((resolve) => (confirm = resolve)));
    await emit({ type: 'approver', status: { kind: 'ready', expiresAt: Date.now() + 600_000 } });
    fireEvent.click(screen.getByRole('button', { name: 'Aprobar' }));
    expect(native.approve).toHaveBeenCalledWith(SID, 'call_2', { forSession: false });
    expect(screen.getByText(/confírmalo en la ventana de confirmación/)).toBeTruthy();
    // Mientras tanto, nada más sale de la tarjeta.
    expect((screen.getByRole('button', { name: 'Denegar' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => confirm());
    expect(screen.getByText(/enviado\. Esperando a que la sesión lo confirme/)).toBeTruthy();
    // La sesión lo publica: la tarjeta desaparece.
    await emit({
      type: 'snapshot',
      sessionId: SID,
      snapshot: sampleSnapshot({ session: idleSession({ state: 'running', currentRunId: 'run_1' }), approvals: [] }),
    });
    expect(screen.queryByText('Necesita tu aprobación')).toBeNull();
  });

  it('cancelar la confirmación no es un error; un resultado desconocido se dice y pide una foto', async () => {
    const { native, emit } = await waitingRig();
    await emit({ type: 'approver', status: { kind: 'ready', expiresAt: Date.now() + 600_000 } });
    vi.mocked(native.approve).mockRejectedValueOnce({
      kind: 'not-confirmed',
      code: null,
      reason: 'cancelled',
      message: 'Not confirmed. Nothing was sent.',
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Aprobar' })));
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Aprobar' }) as HTMLButtonElement).disabled).toBe(false);

    vi.mocked(native.deny).mockRejectedValueOnce({ kind: 'unknown', code: null, reason: null, message: 'x' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Denegar' })));
    expect(screen.getByText(/Resultado desconocido/)).toBeTruthy();
    expect(native.resyncSession).toHaveBeenCalledWith(SID);
    expect(native.deny).toHaveBeenCalledTimes(1);
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

describe('modo Chat | Código', () => {
  const CODE = 'ses_code';
  const codeSession = (over: Partial<ProtocolSession> = {}) =>
    idleSession({ id: CODE, title: 'Arreglar el carrito', agent: 'general', cwd: '/src/tienda', ...over });
  const radio = (name: string) => screen.getByRole('radio', { name });
  const overview = (sessions: ProtocolSession[]) =>
    ({ type: 'overview', overview: { sessions, approvals: [], questions: [], plans: [] } }) as const;

  it('cada modo lista sus sesiones; cambiar de modo deja de mirar la del otro', async () => {
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit(overview([idleSession(), codeSession()]));
    await emit({ type: 'snapshot', sessionId: SID, snapshot: sampleSnapshot({ session: idleSession(), run: null, messages: [] }) });

    expect(radio('Chat').getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByText('Plan de viaje').length).toBeGreaterThan(0);
    expect(screen.queryByText('Arreglar el carrito')).toBeNull();

    fireEvent.click(radio('Código'));
    expect(radio('Código').getAttribute('aria-checked')).toBe('true');
    expect(native.focusSession).toHaveBeenLastCalledWith(null);
    expect(screen.getByText('Arreglar el carrito')).toBeTruthy();
    expect(screen.queryByText('Plan de viaje')).toBeNull();
    // Sin sesión elegida, el modo código pide la carpeta antes de nada.
    expect(screen.getByText('Elige la carpeta del proyecto para empezar')).toBeTruthy();

    // De vuelta, se retoma la conversación que se miraba.
    fireEvent.click(radio('Chat'));
    expect(native.focusSession).toHaveBeenLastCalledWith(SID);
  });

  it('una sesión de código abierta al arrancar pone el modo Código', async () => {
    uiStore.set({ selectedId: CODE, pending: [], notices: [] });
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit(overview([idleSession(), codeSession()]));
    await emit({ type: 'snapshot', sessionId: CODE, snapshot: sampleSnapshot({ session: codeSession(), run: null, messages: [] }) });
    await waitFor(() => expect(radio('Código').getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByRole('combobox', { name: 'Perfil de agente' })).toBeTruthy();
    await waitFor(() => expect(native.gitChanges).toHaveBeenCalledWith(CODE));
  });

  it('el primer mensaje abre la sesión en la carpeta elegida; sin carpeta no se envía', async () => {
    uiStore.set({ selectedId: null, pending: [], notices: [] });
    const { native, emit } = rig();
    native.pickProjectFolder = vi.fn(async () => '/src/tienda');
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit(overview([]));
    fireEvent.click(radio('Código'));

    const box = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(box, { target: { value: 'arregla el carrito' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Elige primero la carpeta del proyecto/)).toBeTruthy();
    expect(native.newCodeSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Elegir carpeta…' }));
    expect(await screen.findByText('/src/tienda')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'arregla el carrito' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(native.newCodeSession).toHaveBeenCalledWith({ cwd: '/src/tienda' }));
    await waitFor(() => expect(native.startRun).toHaveBeenCalledWith(CODE, 'arregla el carrito', []));
    expect(native.newChat).not.toHaveBeenCalled();
  });

  it('/plan arranca el turno en modo plan; en Chat ese comando no existe', async () => {
    uiStore.set({ selectedId: CODE, pending: [], notices: [] });
    const { native, emit } = rig();
    render(<App native={native} />);
    await emit({ type: 'connection', state: connected() });
    await emit(overview([idleSession(), codeSession()]));
    await emit({ type: 'snapshot', sessionId: CODE, snapshot: sampleSnapshot({ session: codeSession(), run: null, messages: [] }) });
    await waitFor(() => expect(radio('Código').getAttribute('aria-checked')).toBe('true'));

    const box = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(box, { target: { value: '/plan migrar a pnpm' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(native.startRun).toHaveBeenCalledWith(CODE, 'migrar a pnpm', [], { plan: true }));

    fireEvent.click(radio('Chat'));
    const chat = screen.getByLabelText('Mensaje para el asistente');
    fireEvent.change(chat, { target: { value: '/plan otra cosa' } });
    fireEvent.keyDown(chat, { key: 'Enter' });
    expect(await screen.findByText(/\/plan es del modo Código/)).toBeTruthy();
    expect(native.startRun).toHaveBeenCalledTimes(1);
  });
});
