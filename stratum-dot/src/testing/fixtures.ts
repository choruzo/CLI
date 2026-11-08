/**
 * Para los tests del frontend: valores del contrato (los de
 * `stratum-cli/src/protocol/protocol.fixtures.ts`, no copias) y un lado nativo
 * de mentira que registra lo que se le pide.
 */
import { vi } from 'vitest';
import type { AppInfo, ApproverStatus, ConnectionState, DotEvent, NativeBridge } from '../bridge/native';
import { handleDotEvent } from '../bridge/connect';
import { resetRoutineWatch } from '../app/routines';
import type {
  ProtocolBoxScreen,
  ProtocolBoxStatus,
  ProtocolRoutine,
  ProtocolRun,
  ProtocolSharedImage,
  ProtocolSession,
  ProtocolSessionSnapshot,
} from '../protocol';
import { useApprover } from '../stores/approverStore';
import { useConnection } from '../stores/connectionStore';
import { useRoutines } from '../stores/routineStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import {
  sampleRun,
  sampleSession,
  sampleSnapshot,
} from '../../../stratum-cli/src/protocol/protocol.fixtures';

export { sampleApproval, sampleRun, sampleSession, sampleToolCall } from '../../../stratum-cli/src/protocol/protocol.fixtures';

/** M18 — el canal de Telegram sin configurar (lo que contesta un daemon recién instalado). */
export const TELEGRAM_OFF = {
  state: 'not-configured',
  bot: null,
  paired: [],
  pairing: null,
  lastError: null,
  lastPollAt: null,
};

export const SID = 'ses_20261012_abc123';
/** La sesión que «abre» el lado nativo de mentira. */
export const NEW_SID = 'ses_20261013_new001';

/** Una sesión del daemon parada: como queda un chat recién abierto o entre turnos. */
export function hostedIdle(
  overrides: Partial<ProtocolSessionSnapshot> = {},
  session: Partial<ProtocolSession> = {},
): ProtocolSessionSnapshot {
  return snapshotOf(
    { ...overrides },
    {
      id: NEW_SID,
      title: '',
      state: 'idle',
      currentRunId: null,
      host: { kind: 'daemon', client: 'daemon', connected: true },
      ...session,
    },
    null,
  );
}

/** Una foto válida, sin nada pendiente ni texto a medias. */
export function snapshotOf(
  overrides: Partial<ProtocolSessionSnapshot> = {},
  session: Partial<ProtocolSession> = {},
  run: Partial<ProtocolRun> | null = {},
): ProtocolSessionSnapshot {
  const seq = overrides.seq ?? 3;
  return sampleSnapshot({
    session: sampleSession({ seq, ...session }),
    run: run === null ? null : sampleRun(run),
    partial: { text: '', reasoning: '' },
    toolCalls: [],
    approvals: [],
    ...overrides,
    seq,
  });
}

/** Un evento de estado tal como viaja (JSON sin tipar). */
export function stateEvent(seq: number, type: string, data: unknown, sessionId = SID): Record<string, unknown> {
  return { type, sessionId, runId: 'run_1', at: 1_760_000_002_000 + seq, seq, data };
}

export function delta(after: number, text: string, sessionId = SID): Record<string, unknown> {
  return { type: 'message.delta', sessionId, at: 1_760_000_002_000, after, data: { text } };
}

export function runUpdated(seq: number, status: ProtocolRun['status']): Record<string, unknown> {
  return stateEvent(seq, 'run.updated', { run: sampleRun({ status }) });
}

/** M14 — la caja del asistente, como la describe `box.status`. */
export function sampleBox(overrides: Partial<ProtocolBoxStatus> = {}): ProtocolBoxStatus {
  return {
    name: 'box',
    state: 'stopped',
    runtime: 'podman',
    image: 'stratum-box:1',
    network: true,
    outdated: false,
    enabled: true,
    exchangeDir: '/home/ana/.stratum/companion/exchange',
    desktop: true,
    ...overrides,
  };
}

/** M15 — la pantalla de la caja, como la devuelve `box.screen`. */
export function sampleScreen(overrides: Partial<ProtocolBoxScreen> = {}): ProtocolBoxScreen {
  return {
    mime: 'image/jpeg',
    data: '/9j/AAAA',
    width: 1280,
    height: 800,
    screenWidth: 1280,
    screenHeight: 800,
    takenAt: 1_760_000_000_000,
    ...overrides,
  };
}

/** Una imagen que el asistente compartió (la referencia que viaja en la conversación). */
export function sampleSharedImage(overrides: Partial<ProtocolSharedImage> = {}): ProtocolSharedImage {
  return {
    id: '20261105T101500Z-0123456789abcdef',
    mime: 'image/png',
    bytes: 6,
    ...overrides,
  };
}

/** Un trozo de `images.get` (por defecto, la imagen entera: 6 bytes, `AQIDBAUG`). */
export function sampleImageChunk(overrides: Record<string, unknown> = {}): unknown {
  const image = sampleSharedImage();
  return {
    image: { id: image.id, mime: image.mime, bytes: image.bytes },
    offset: 0,
    data: 'AQIDBAUG',
    next: null,
    ...overrides,
  };
}

/** M16 — una rutina, como la devuelve `routines.list`. */
export function sampleRoutine(overrides: Partial<ProtocolRoutine> = {}): ProtocolRoutine {
  return {
    id: 'rt_abc1234567',
    name: 'Morning summary',
    schedule: '1d',
    prompt: 'Summarise my day',
    enabled: true,
    createdAt: 1_760_000_000_000,
    nextFireAt: 1_760_086_400_000,
    scheduleError: null,
    sessionId: null,
    running: false,
    lastFire: null,
    lastResult: null,
    ...overrides,
  };
}

export const CONNECTED: ConnectionState = {
  kind: 'connected',
  serverVersion: '0.9.0',
  serverPlatform: 'win32',
  protocol: 1,
  capabilities: ['observe', 'control'],
  features: [],
};

/** Conectado a un daemon que acredita aprobadores. */
export const CONNECTED_APPROVALS: ConnectionState = { ...CONNECTED, features: ['remote-approvals'] };

export const READY: ApproverStatus = { kind: 'ready', expiresAt: 1_760_000_600_000 };
export const LOCKED: ApproverStatus = { kind: 'locked', reason: 'initial' };

export const APP_INFO: AppInfo = { dotVersion: '0.1.0', protocol: 1, trayAvailable: true };

export type FakeNative = NativeBridge & {
  /** Hace llegar un evento como si viniera del lado nativo. */
  push(event: DotEvent): void;
  calls: Record<Exclude<keyof NativeBridge, 'onEvent'>, ReturnType<typeof vi.fn>>;
};

export function fakeNative(): FakeNative {
  const calls = {
    attach: vi.fn(async () => APP_INFO),
    retry: vi.fn(async () => undefined),
    focusSession: vi.fn(async () => undefined),
    resyncSession: vi.fn(async () => undefined),
    pauseRun: vi.fn(async () => 'requested'),
    resumeRun: vi.fn(async () => 'resumed'),
    cancelRun: vi.fn(async () => 'cancelled'),
    steerRun: vi.fn(async () => 'accepted'),
    openSession: vi.fn(async (): Promise<unknown> => ({
      session: sampleSession({
        id: NEW_SID,
        title: '',
        state: 'idle',
        currentRunId: null,
        seq: 1,
        host: { kind: 'daemon', client: 'daemon', connected: true },
      }),
    })),
    startRun: vi.fn(async (sessionId: string): Promise<unknown> => ({
      run: sampleRun({ id: 'run_new', sessionId }),
    })),
    listAgents: vi.fn(async (): Promise<unknown> => ({
      agents: [
        { name: 'general', description: '', mode: 'all', origin: 'builtin', allowedTools: null },
        { name: 'reviewer', description: 'Reviews changes', mode: 'primary', origin: 'project', allowedTools: null },
        { name: 'helper', description: 'Only delegated', mode: 'subagent', origin: 'global', allowedTools: null },
      ],
    })),
    listModels: vi.fn(async (): Promise<unknown> => ({
      models: [
        { provider: 'local', id: 'test-model', contextWindow: null, default: true },
        { provider: 'local', id: 'big-model', contextWindow: 128000 },
      ],
    })),
    boxStatus: vi.fn(async (): Promise<unknown> => ({ box: sampleBox() })),
    boxStart: vi.fn(async (): Promise<unknown> => ({ box: sampleBox({ state: 'running' }) })),
    boxStop: vi.fn(async (): Promise<unknown> => ({ box: sampleBox({ state: 'stopped' }) })),
    boxScreen: vi.fn(async (): Promise<unknown> => ({ screen: sampleScreen() })),
    imagesGet: vi.fn(async (_imageId: string, _offset?: number): Promise<unknown> => sampleImageChunk()),
    routinesList: vi.fn(async (): Promise<unknown> => ({ routines: [], readOnly: false })),
    routinesAdd: vi.fn(async (): Promise<unknown> => ({ routine: sampleRoutine() })),
    routinesUpdate: vi.fn(async (): Promise<unknown> => ({ routine: sampleRoutine() })),
    routinesRemove: vi.fn(async (): Promise<unknown> => ({ routine: sampleRoutine() })),
    routinesRun: vi.fn(
      async (): Promise<unknown> => ({
        fire: { at: 1_760_000_000_000, outcome: 'started', manual: true },
        routine: sampleRoutine({ running: true }),
      }),
    ),
    grantsRevoke: vi.fn(async (): Promise<unknown> => ({ grant: {} })),
    memoryDecisions: vi.fn(async (_query?: string): Promise<unknown> => ({ decisions: [] })),
    memoryForget: vi.fn(async (_decisionId: string): Promise<unknown> => ({ removed: true })),
    memoryMove: vi.fn(
      async (_decisionId: string, _section: string): Promise<unknown> => ({ updated: true }),
    ),
    memoryProposals: vi.fn(async (): Promise<unknown> => ({ proposals: [] })),
    memoryDream: vi.fn(
      async (_force: boolean): Promise<unknown> => ({
        status: 'done',
        message: 'ok',
        proposals: [],
        discarded: 0,
        tokens: null,
      }),
    ),
    memoryApplyProposal: vi.fn(
      async (_proposalId: string): Promise<unknown> => ({ applied: true, message: 'ok' }),
    ),
    memoryRejectProposal: vi.fn(
      async (_proposalId: string): Promise<unknown> => ({ rejected: true, message: 'ok' }),
    ),
    channelsStatus: vi.fn(async (): Promise<unknown> => ({ telegram: TELEGRAM_OFF })),
    channelsPairBegin: vi.fn(async (): Promise<unknown> => ({
      code: 'ABCDEFGHJK',
      link: 'https://t.me/mi_dot_bot?start=ABCDEFGHJK',
      expiresAt: Date.now() + 600_000,
    })),
    channelsPairConfirm: vi.fn(async (_userId: number): Promise<void> => undefined),
    channelsUnpair: vi.fn(async (_userId: number): Promise<unknown> => ({ removed: true })),
    newCompanionConversation: vi.fn(async (): Promise<unknown> => ({})),
    sessionMemory: vi.fn(
      async (_sessionId: string): Promise<unknown> => ({
        memory: { version: 1, updatedAt: null, summary: null, items: [], sourceCursor: null },
      }),
    ),
    notifyRoutine: vi.fn(async () => undefined),
    approverStatus: vi.fn(async (): Promise<ApproverStatus> => useApprover.getState().status),
    unlockApprovals: vi.fn(async () => undefined),
    lockApprovals: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    deny: vi.fn(async () => undefined),
    answerQuestions: vi.fn(async () => undefined),
    decidePlan: vi.fn(async () => undefined),
    setAttention: vi.fn(async () => undefined),
    hideWindow: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
  };
  const native: FakeNative = {
    ...(calls as unknown as Omit<NativeBridge, 'onEvent'>),
    calls,
    onEvent: async () => () => undefined,
    push: (event) => handleDotEvent(native, event),
  };
  return native;
}

/**
 * Deja los stores como al arrancar, salvo la vista: los tests parten de la
 * cabina (`sessions`); que Dot arranque en el asistente lo prueba `App.test`.
 */
export function resetStores(): void {
  useConnection.setState({ state: { kind: 'starting' }, info: null, lastServerVersion: null });
  useSessions.getState().reset();
  useRoutines.getState().reset();
  resetRoutineWatch();
  useUi.setState({
    selectedId: null,
    tab: 'chat',
    composingNew: false,
    lastCwd: '',
    drafts: {},
    pending: {},
    sends: {},
    opening: {},
    notices: {},
    view: 'sessions',
    assistantTab: 'chat',
    pendingAsk: null,
    companionId: null,
    focusItem: null,
    resolutions: {},
  });
  useApprover.setState({ status: { kind: 'unavailable', reason: 'not-connected' } });
  try {
    window.localStorage.clear();
  } catch {
    /* sin almacenamiento */
  }
}
