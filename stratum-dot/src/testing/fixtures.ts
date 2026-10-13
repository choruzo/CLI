/**
 * Para los tests del frontend: valores del contrato (los de
 * `stratum-cli/src/protocol/protocol.fixtures.ts`, no copias) y un lado nativo
 * de mentira que registra lo que se le pide.
 */
import { vi } from 'vitest';
import type { AppInfo, ConnectionState, DotEvent, NativeBridge } from '../bridge/native';
import { handleDotEvent } from '../bridge/connect';
import type { ProtocolRun, ProtocolSession, ProtocolSessionSnapshot } from '../protocol';
import { useConnection } from '../stores/connectionStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import {
  sampleRun,
  sampleSession,
  sampleSnapshot,
} from '../../../stratum-cli/src/protocol/protocol.fixtures';

export { sampleApproval, sampleRun, sampleSession, sampleToolCall } from '../../../stratum-cli/src/protocol/protocol.fixtures';

export const SID = 'ses_20261012_abc123';

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

export const CONNECTED: ConnectionState = {
  kind: 'connected',
  serverVersion: '0.9.0',
  serverPlatform: 'win32',
  protocol: 1,
  capabilities: ['observe', 'control'],
  features: [],
};

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

/** Deja los stores como al arrancar. */
export function resetStores(): void {
  useConnection.setState({ state: { kind: 'starting' }, info: null, lastServerVersion: null });
  useSessions.getState().reset();
  useUi.setState({ selectedId: null, pending: {}, notices: {} });
  try {
    window.localStorage.clear();
  } catch {
    /* sin almacenamiento */
  }
}
