/**
 * Valores de ejemplo del protocolo, para tests (los de aquí, los del códec y
 * los del cliente). No forma parte de la superficie pública.
 */
import type {
  ProtocolApproval,
  ProtocolRun,
  ProtocolSession,
  ProtocolSessionSnapshot,
  ProtocolToolCall,
} from './index.js';

export function sampleSession(overrides: Partial<ProtocolSession> = {}): ProtocolSession {
  return {
    id: 'ses_20261012_abc123',
    title: 'Implement authentication',
    cwd: '/work/api',
    host: { kind: 'peer', client: 'cli', connected: true },
    state: 'running',
    agent: 'general',
    provider: 'local',
    model: 'test-model',
    sessionProfile: 'auto',
    readOnly: false,
    activeTarget: 'local',
    context: { used: 1200, max: 32768, pct: 3.7, estimated: false },
    tokens: { total: null, status: 'unavailable' },
    currentRunId: 'run_1',
    seq: 3,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_001_000,
    ...overrides,
  };
}

export function sampleRun(overrides: Partial<ProtocolRun> = {}): ProtocolRun {
  return {
    id: 'run_1',
    sessionId: 'ses_20261012_abc123',
    kind: 'run',
    input: 'Implement authentication',
    mode: 'normal',
    status: 'running',
    startedAt: 1_760_000_000_500,
    counters: {
      llmCalls: 2,
      toolCalls: 1,
      toolErrors: 0,
      blocked: 0,
      memoryReads: 0,
      memoryWrites: 0,
      subagents: 0,
      jobs: 0,
    },
    ...overrides,
  };
}

export function sampleToolCall(overrides: Partial<ProtocolToolCall> = {}): ProtocolToolCall {
  return {
    id: 'call_1',
    runId: 'run_1',
    name: 'exec',
    target: 'local',
    state: 'completed',
    description: 'git status',
    output: 'clean',
    startedAt: 1_760_000_000_600,
    durationMs: 42,
    ...overrides,
  };
}

export function sampleApproval(overrides: Partial<ProtocolApproval> = {}): ProtocolApproval {
  return {
    id: 'call_2',
    kind: 'tool',
    sessionId: 'ses_20261012_abc123',
    runId: 'run_1',
    tool: 'exec',
    description: 'git push origin main',
    forced: false,
    resolvable: 'anywhere',
    requestedAt: 1_760_000_000_700,
    expiresAt: null,
    status: 'pending',
    ...overrides,
  };
}

export function sampleSnapshot(
  overrides: Partial<ProtocolSessionSnapshot> = {},
): ProtocolSessionSnapshot {
  return {
    session: sampleSession(),
    seq: 3,
    run: sampleRun(),
    partial: { text: 'Voy a', reasoning: '' },
    toolCalls: [sampleToolCall()],
    subagents: [],
    todos: [],
    jobs: [],
    approvals: [sampleApproval()],
    questions: [],
    plans: [],
    ...overrides,
  };
}
