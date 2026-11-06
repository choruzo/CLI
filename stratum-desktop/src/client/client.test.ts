import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  sampleApproval,
  sampleRun,
  sampleSession,
  sampleSnapshot,
} from '../../../stratum-cli/src/protocol/protocol.fixtures';
import type { ProtocolChatMessage, ProtocolSessionSnapshot } from '../protocol';
import type { ConnectionState, NativeBridge } from '../ipc/native';
import { carryOver, initialProtocolState, protocolActions, protocolStore } from './protocol-store';
import { uiStore } from './ui-store';
import { settlePending, stillPending } from './bridge';
import { loadOlder, newChat, sendMessage, startConversation, control } from './actions';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

const SID = 'ses_20261012_abc123';

const user = (seq: number, text = `u${seq}`, runId = `run_${seq}`): ProtocolChatMessage => ({
  id: `m${seq}`,
  runId,
  at: seq,
  kind: 'user',
  text,
});

function snap(messages: ProtocolChatMessage[], overrides: Partial<ProtocolSessionSnapshot> = {}): ProtocolSessionSnapshot {
  return sampleSnapshot({ messages, messagesTruncated: true, ...overrides });
}

function fakeNative(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return {
    attach: vi.fn(async () => ({ desktopVersion: '0', protocol: 1 })),
    retry: vi.fn(async () => undefined),
    focusSession: vi.fn(async () => undefined),
    resyncSession: vi.fn(async () => undefined),
    pauseRun: vi.fn(async () => 'requested'),
    resumeRun: vi.fn(async () => 'resumed'),
    cancelRun: vi.fn(async () => 'cancelled'),
    steerRun: vi.fn(async () => 'accepted'),
    newChat: vi.fn(async () => ({ session: sampleSession({ id: 'ses_new' }) })),
    startRun: vi.fn(async () => ({ run: sampleRun({ id: 'run_9' }) })),
    savePastedImage: vi.fn(async () => '/home/u/.stratum/images/1-abc.png'),
    listModels: vi.fn(async () => ({ models: [] })),
    setModel: vi.fn(async () => ({ session: sampleSession() })),
    closeSession: vi.fn(async () => ({})),
    history: vi.fn(async () => ({ messages: [], hasMore: false, total: 0 })),
    context: vi.fn(async () => ({})),
    memory: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => ({ skills: [] })),
    prefs: vi.fn(),
    openConfig: vi.fn(async () => undefined),
    onEvent: vi.fn(async () => () => undefined),
    ...overrides,
  } as NativeBridge;
}

const lost = (kind: 'unknown' | 'not-sent') => ({ kind, code: null, reason: null, message: 'x' });

beforeEach(() => {
  protocolStore.set(initialProtocolState);
  uiStore.set({ selectedId: null, pending: [], notices: [] });
});
afterEach(() => vi.clearAllMocks());

describe('protocol-store: la foto manda y nada se remienda', () => {
  it('una foto de una sesión que ya no se mira (llega tarde) no se pinta', () => {
    protocolActions.focus(SID);
    protocolActions.focus('otra');
    protocolActions.applySnapshot(SID, sampleSnapshot());
    expect(protocolStore.get().focused).toEqual({ sessionId: 'otra', snapshot: null, unreadable: false });
  });

  it('una foto que no cumple el contrato no se inventa; la siguiente válida sustituye', () => {
    protocolActions.focus(SID);
    protocolActions.applySnapshot(SID, { seq: 3 });
    expect(protocolStore.get().focused?.unreadable).toBe(true);
    protocolActions.applySnapshot(SID, sampleSnapshot());
    expect(protocolStore.get().focused?.snapshot?.seq).toBe(3);
    // Tras reconectar llega otra foto: sustituye entera, sea cual sea su `seq`.
    protocolActions.applySnapshot(SID, sampleSnapshot({ seq: 2, session: sampleSession({ seq: 2, state: 'idle' }) }));
    expect(protocolStore.get().focused?.snapshot?.session.state).toBe('idle');
  });

  it('un hueco en los eventos pide foto y deja lo aplicado hasta ahí', () => {
    protocolActions.focus(SID);
    protocolActions.applySnapshot(SID, sampleSnapshot());
    const ev = (seq: number) => ({ type: 'run.updated', sessionId: SID, seq, at: seq, data: { run: sampleRun({ status: 'paused' }) } });
    expect(protocolActions.applyEvents(SID, [ev(4)])).toBe(false);
    expect(protocolActions.applyEvents(SID, [ev(6)])).toBe(true);
    expect(protocolStore.get().focused?.snapshot?.seq).toBe(4);
  });

  it('la foto de conjunto avanza con sus eventos y la siguiente la sustituye', () => {
    protocolActions.applyOverview({ sessions: [sampleSession({ origin: 'desktop' })], approvals: [], questions: [], plans: [] });
    expect(protocolStore.get().listed).toBe(true);
    protocolActions.applyOverviewEvents([
      { type: 'approval.requested', sessionId: SID, seq: 9, at: 1, data: { approval: sampleApproval() } },
      { type: 'nada.que.ver', sessionId: SID, seq: 10, at: 1, data: {} },
    ]);
    expect(protocolStore.get().overview.approvals).toHaveLength(1);
    protocolActions.applyOverview({ sessions: [], approvals: [], questions: [], plans: [] });
    expect(protocolStore.get().overview).toEqual({ sessions: [], approvals: [], questions: [], plans: [] });
  });
});

describe('historial bajo demanda (M11): contiguo con la foto o nada', () => {
  it('lo que la foto deja de llevar al crecer pasa al historial; un salto lo descarta', () => {
    const h = { sessionId: SID, older: [user(1)], hasMore: false, loading: false, error: null };
    const prev = snap([user(2), user(3)]);
    const next = snap([user(3), user(4)]);
    expect(carryOver(h, prev, next)?.older.map((m) => m.id)).toEqual(['m1', 'm2']);
    // Sin solape: pudo haber mensajes que no se vieron. Fuera, y se puede volver a pedir.
    const jumped = carryOver(h, prev, snap([user(9)]));
    expect(jumped?.older).toEqual([]);
    expect(jumped?.hasMore).toBe(true);
  });

  it('una página que llega tras cambiar de sesión, o que ya no empalma, se descarta', async () => {
    let answer!: (v: unknown) => void;
    const native = fakeNative({ history: vi.fn(() => new Promise((r) => (answer = r))) });
    protocolActions.focus(SID);
    protocolActions.applySnapshot(SID, snap([user(5), user(6)]));
    const pending = loadOlder(native, SID);
    expect(native.history).toHaveBeenCalledWith(SID, 'm5', 50);
    // Mientras tanto se mira otra sesión.
    protocolActions.focus('otra');
    answer({ messages: [user(3), user(4)], hasMore: false, total: 4 });
    await pending;
    expect(protocolStore.get().history).toBeNull();

    // Una que sí empalma se antepone.
    protocolActions.focus(SID);
    protocolActions.applySnapshot(SID, snap([user(5), user(6)]));
    const native2 = fakeNative({ history: vi.fn(async () => ({ messages: [user(3), user(4)], hasMore: true, total: 6 })) });
    await loadOlder(native2, SID);
    expect(protocolStore.get().history?.older.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(protocolStore.get().history?.hasMore).toBe(true);
  });
});

describe('lo pendiente se retira cuando la foto lo alcanza, no antes', () => {
  it('un mensaje enviado espera a que su run aparezca; una pausa, a que el run esté en pausa', () => {
    const state = {
      ...initialProtocolState,
      overview: { sessions: [sampleSession({ currentRunId: 'run_1' })], approvals: [], questions: [], plans: [] },
      focused: { sessionId: SID, snapshot: sampleSnapshot(), unreadable: false },
    };
    expect(stillPending({ kind: 'send', sessionId: SID, runId: null }, state)).toBe(true);
    expect(stillPending({ kind: 'send', sessionId: SID, runId: 'run_1' }, state)).toBe(false);
    expect(stillPending({ kind: 'control', sessionId: SID, action: 'pause', runId: 'run_1' }, state)).toBe(true);
    const paused = { ...state, focused: { ...state.focused, snapshot: sampleSnapshot({ run: sampleRun({ status: 'paused' }) }) } };
    expect(stillPending({ kind: 'control', sessionId: SID, action: 'pause', runId: 'run_1' }, paused)).toBe(false);
    expect(stillPending({ kind: 'close', sessionId: SID }, state)).toBe(true);
    expect(stillPending({ kind: 'close', sessionId: SID }, { ...state, overview: { ...state.overview, sessions: [] } })).toBe(false);
  });
});

describe('acciones: pedir no es aplicar, y lo desconocido no se repite', () => {
  it('un mensaje sin respuesta no se reenvía ni vuelve al campo; uno que no salió, sí vuelve', async () => {
    const native = fakeNative({ startRun: vi.fn(async () => Promise.reject(lost('unknown'))) });
    const outcome = await sendMessage(native, { sessionId: SID, cwd: null, mode: 'ask', text: 'hola', attachments: [] });
    expect(outcome.restore).toBe(false);
    expect(native.startRun).toHaveBeenCalledTimes(1);
    expect(uiStore.get().notices.at(-1)?.text).toMatch(/no se sabe si se aplicó/);
    expect(uiStore.get().pending).toEqual([]);

    const notSent = fakeNative({ startRun: vi.fn(async () => Promise.reject(lost('not-sent'))) });
    expect((await sendMessage(notSent, { sessionId: SID, cwd: null, mode: 'ask', text: 'hola', attachments: [] })).restore).toBe(true);
  });

  it('antes de un run se restaura la carpeta de la conversación (retención); si falla no se envía', async () => {
    const CWD = '/home/u/.stratum/desktop/workspaces/0b5b2c7e-5c1a-4f7e-8d3a-000000000001';
    const order: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      order.push(cmd);
      return cmd === 'workspace_restore' ? 'archived' : undefined;
    });
    const native = fakeNative({
      startRun: vi.fn(async () => {
        order.push('startRun');
        return { run: sampleRun({ id: 'run_9' }) };
      }),
    });
    await sendMessage(native, { sessionId: SID, cwd: CWD, mode: 'ask', text: 'hola', attachments: [] });
    expect(order.slice(0, 2)).toEqual(['workspace_restore', 'startRun']);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('workspace_restore', { cwd: CWD });

    // Redirigir un run en marcha no restaura nada: la carpeta está en uso.
    vi.mocked(invoke).mockClear();
    await sendMessage(native, { sessionId: SID, cwd: CWD, mode: 'steer', text: 'otra cosa', attachments: [] });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('workspace_restore', expect.anything());

    // Si no se puede restaurar, el mensaje no sale y vuelve al campo.
    uiStore.set({ selectedId: null, pending: [], notices: [] });
    vi.mocked(invoke).mockImplementation(async () => Promise.reject('disco lleno'));
    const failing = fakeNative();
    const outcome = await sendMessage(failing, { sessionId: SID, cwd: CWD, mode: 'ask', text: 'hola', attachments: [] });
    expect(outcome.restore).toBe(true);
    expect(failing.startRun).not.toHaveBeenCalled();
    expect(uiStore.get().notices.at(-1)?.text).toMatch(/No se pudieron restaurar los ficheros.*disco lleno/);
    expect(uiStore.get().pending).toEqual([]);
    vi.mocked(invoke).mockImplementation(() => Promise.resolve(undefined));
  });

  it('enviado y aceptado: queda «enviando» hasta que la foto trae su run', async () => {
    const native = fakeNative();
    await sendMessage(native, { sessionId: SID, cwd: null, mode: 'ask', text: 'hola', attachments: ['inputs/a.csv'] });
    expect(native.startRun).toHaveBeenCalledWith(SID, expect.stringContaining('- inputs/a.csv'), []);
    expect(uiStore.get().pending).toEqual([{ kind: 'send', sessionId: SID, runId: 'run_9' }]);
    protocolActions.focus(SID);
    protocolActions.applySnapshot(SID, sampleSnapshot({ run: sampleRun({ id: 'run_9' }) }));
    settlePending();
    expect(uiStore.get().pending).toEqual([]);
  });

  it('las imágenes viajan en images: adjuntos de imagen y pegadas, máx 5, y se siguen listando en el texto', async () => {
    const native = fakeNative();
    await sendMessage(native, {
      sessionId: SID,
      cwd: null,
      mode: 'ask',
      text: 'mira',
      attachments: ['inputs/a.csv', 'inputs/b.PNG', 'inputs/c.jpeg'],
      pasted: ['/home/u/.stratum/images/1-abc.png'],
    });
    expect(native.startRun).toHaveBeenCalledWith(SID, expect.stringContaining('- inputs/b.PNG'), [
      '/home/u/.stratum/images/1-abc.png',
      'inputs/b.PNG',
      'inputs/c.jpeg',
    ]);
    // La pegada no se lista en el texto.
    expect(vi.mocked(native.startRun).mock.calls[0]![1]).not.toContain('.stratum/images');
  });

  it('más de 5 imágenes: solo las 5 primeras y un aviso', async () => {
    const native = fakeNative();
    const attachments = ['1', '2', '3', '4', '5', '6', '7'].map((n) => `inputs/${n}.webp`);
    await sendMessage(native, { sessionId: SID, cwd: null, mode: 'ask', text: 'todas', attachments });
    expect(vi.mocked(native.startRun).mock.calls[0]![2]).toEqual(attachments.slice(0, 5));
    expect(uiStore.get().notices.at(-1)?.text).toMatch(/Solo se envían 5 imágenes/);
  });

  it('sin imágenes, images va vacío', async () => {
    const native = fakeNative();
    await sendMessage(native, { sessionId: SID, cwd: null, mode: 'ask', text: 'hola', attachments: ['inputs/a.csv'] });
    expect(vi.mocked(native.startRun).mock.calls[0]![2]).toEqual([]);
  });

  it('con un run en marcha, escribir redirige (steer), no abre otro run', async () => {
    const native = fakeNative();
    await sendMessage(native, { sessionId: SID, cwd: null, mode: 'steer', text: 'mejor en tabla', attachments: [] });
    expect(native.steerRun).toHaveBeenCalledWith(SID, 'mejor en tabla', []);
    expect(native.startRun).not.toHaveBeenCalled();
  });

  it('abrir una conversación sin respuesta no envía el primer mensaje a ciegas', async () => {
    const native = fakeNative({ newChat: vi.fn(async () => Promise.reject(lost('unknown'))) });
    const outcome = await startConversation(native, 'hola');
    expect(outcome.restore).toBe(true);
    expect(native.startRun).not.toHaveBeenCalled();
    expect(uiStore.get().notices.at(-1)?.text).toMatch(/aparecerá en la lista/);
    // Abierta: se selecciona (y se mira) la sesión que devolvió el daemon.
    expect(await newChat(fakeNative())).toBe('ses_new');
    expect(uiStore.get().selectedId).toBe('ses_new');
  });

  it('una orden en vuelo no se pide dos veces', async () => {
    let release!: () => void;
    const native = fakeNative({ pauseRun: vi.fn(() => new Promise<string>((r) => (release = () => r('requested')))) });
    const first = control(native, SID, 'pause', 'run_1');
    await control(native, SID, 'pause', 'run_1');
    expect(native.pauseRun).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

export const connected: ConnectionState = {
  kind: 'connected',
  serverVersion: '0',
  serverPlatform: 'x',
  protocol: 1,
  capabilities: ['observe', 'control'],
  features: [],
};
