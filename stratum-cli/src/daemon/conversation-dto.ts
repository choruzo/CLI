/**
 * M11 — de la conversación, el contexto y la memoria de una sesión del daemon
 * a los DTOs de `sessions.history`, `sessions.context` y `sessions.memory`. Los
 * DTOs no son los tipos internos: aquí se decide qué sale y con qué topes.
 */
import type { ContextBreakdown, ContextBudget } from '../agent/context-builder.js';
import type { ContextState } from '../conversation/files.js';
import type { ConversationStats } from '../conversation/session-conversation.js';
import { memoryCounts, type SessionMemory } from '../conversation/session-memory.js';
import type { ConversationStore } from '../conversation/store.js';
import { ProtocolError } from '../ipc/codec.js';
import {
  HISTORY_LIMITS,
  type ProtocolContextReport,
  type ProtocolConversationStats,
  type ProtocolHistoryPage,
  type ProtocolSessionMemory,
  type ProtocolSessionMemoryStats,
} from '../protocol/index.js';

/** Lo que da `StratumAgent.getContextReport()` (el daemon no importa el agente). */
interface ContextReport {
  budget: ContextBudget;
  breakdown: ContextBreakdown;
  conversation: ConversationStats | null;
  sessionMemory: boolean;
}

/** Fuentes de una entrada que viajan: las primeras. El resto está en disco. */
const MAX_SOURCES = 50;
const DEFAULT_PAGE = 50;

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Una página de la conversación guardada, que cabe en un mensaje. */
export function historyPage(
  store: ConversationStore,
  before: string | undefined,
  limit: number | undefined,
): ProtocolHistoryPage {
  if (before !== undefined && store.getChat(before) === null) {
    throw new ProtocolError('INVALID_PARAMS', 'before is not a message of this session', {
      issues: [{ path: 'before', message: 'unknown message id' }],
    });
  }
  const n = Math.min(limit ?? DEFAULT_PAGE, HISTORY_LIMITS.pageMessages);
  const page = store.listChatBefore(before ?? null, n);
  const messages = page.messages;
  let hasMore = page.hasMore;
  // Lo más antiguo de la página se deja para la siguiente si no cabe.
  while (
    messages.length > 1 &&
    Buffer.byteLength(JSON.stringify(messages), 'utf8') > HISTORY_LIMITS.pageBytes
  ) {
    messages.shift();
    hasMore = true;
  }
  return { messages, hasMore, total: store.chatCount() };
}

export function memoryStats(memory: SessionMemory, enabled: boolean): ProtocolSessionMemoryStats {
  return {
    enabled,
    version: memory.version,
    updatedAt: ms(memory.updatedAt),
    hasSummary: memory.summary !== null,
    items: memoryCounts(memory),
  };
}

function conversationStats(stats: ConversationStats): ProtocolConversationStats {
  return {
    storedMessages: stats.storedMessages,
    storedAgentMessages: stats.storedAgentMessages,
    activeMessages: stats.activeMessages,
    compactions: stats.compactions,
    lastCompactionAt: stats.lastCompactionAt,
    lastCompactionError: stats.lastCompactionError,
    compacting: stats.compacting,
  };
}

/** Informe de una sesión montada. */
export function liveContextReport(
  sessionId: string,
  report: ContextReport,
  memory: SessionMemory | null,
): ProtocolContextReport {
  const { budget, breakdown } = report;
  return {
    sessionId,
    context: {
      window: breakdown.window,
      reserveOutput: breakdown.reserveOutput,
      usableInput: breakdown.usableInput,
      input: breakdown.input,
      system: breakdown.system,
      tools: breakdown.tools,
      globalMemory: breakdown.globalMemory,
      projectMemory: breakdown.projectMemory,
      sessionMemory: breakdown.sessionMemory,
      recent: breakdown.recent,
      activeMessages: breakdown.activeMessages,
      estimated: breakdown.estimated,
      budgets: {
        recent: budget.recent,
        sessionMemory: budget.sessionMemory,
        projectMemory: budget.projectMemory,
        globalMemory: budget.globalMemory,
        compactAt: budget.compactAt,
        target: budget.target,
      },
    },
    conversation: report.conversation ? conversationStats(report.conversation) : null,
    memory: memory ? memoryStats(memory, report.sessionMemory) : null,
  };
}

/** Informe de una sesión guardada que aún no se ha montado: sin desglose del contexto. */
export function archivedContextReport(
  sessionId: string,
  store: ConversationStore,
  state: ContextState,
  memory: SessionMemory,
  enabled: boolean,
): ProtocolContextReport {
  return {
    sessionId,
    context: null,
    conversation: {
      storedMessages: store.chatCount(),
      storedAgentMessages: store.agentCount(),
      activeMessages: state.activeIds.length,
      compactions: state.compactionCount,
      lastCompactionAt: state.lastCompactionAt,
      lastCompactionError: state.lastCompactionError,
      compacting: false,
    },
    memory: memoryStats(memory, enabled),
  };
}

export function protocolMemory(memory: SessionMemory): ProtocolSessionMemory {
  const summary = memory.summary;
  return {
    version: memory.version,
    updatedAt: ms(memory.updatedAt),
    summary: summary
      ? {
          text: summary.text,
          sourceCount: summary.sources.length,
          firstSource: summary.sources[0] ?? null,
          lastSource: summary.sources.at(-1) ?? null,
        }
      : null,
    items: memory.items.map((i) => ({
      id: i.id,
      kind: i.kind,
      key: i.key,
      text: i.text,
      status: i.status,
      sources: i.sources.slice(0, MAX_SOURCES),
      ...(i.supersedes ? { supersedes: i.supersedes } : {}),
      ...(i.supersededBy ? { supersededBy: i.supersededBy } : {}),
      updatedAt: ms(i.updatedAt) ?? 0,
    })),
    sourceCursor: memory.sourceCursor,
  };
}
