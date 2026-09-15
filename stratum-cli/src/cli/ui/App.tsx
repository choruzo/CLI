import React, { useReducer, useCallback, useRef, useState, useEffect } from 'react';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { StratumAgent } from '../../agent/core.js';
import type {
  AgentEvent,
  AgentMode,
  ConfirmRequest,
  DestructiveDecision,
  Message,
  Plan,
  PlanDecision,
  QuestionAnswer,
  QuestionItem,
  RunOptions,
  TokenAccounting,
} from '../../agent/types.js';
import type { ProviderConfig } from '../../config/schema.js';
import { StratumConfigSchema } from '../../config/schema.js';
import { expandEnvVars, findConfigFile } from '../../config/loader.js';
import { getByDotPath, setByDotPath, formatConfigValue } from '../../config/dot-path.js';
import { resolveMemoryPaths } from '../../config/paths.js';
import { SessionStore } from '../../session/store.js';
import { upsertProvider, readRawProvider } from '../../config/writer.js';
import { detectCapabilities } from '../../providers/utils.js';
import type { ProviderStatus } from './StatusBar.js';
import type { McpManager, McpStatusSummary } from '../../tools/mcp/manager.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { parseMcpToolName } from '../../tools/mcp/bridge.js';
import type { ToolCallState } from './ToolCallBlock.js';
import type { SubagentBlockState } from './SubagentBlock.js';
import { SubagentView, type SubagentTranscript } from './SubagentView.js';
import { applyToolEvent } from './tool-call-reducer.js';
import { DELEGATE_TASK_TOOL } from '../../tools/agent/delegate.js';
import { TODO_TOOL } from '../../tools/todo.js';
import type { TodoItem } from '../../agent/todo.js';
import {
  collectWorkingTreeChanges,
  formatChangesReport,
  formatCompact,
  EMPTY_SUMMARY,
  type ChangesSummary,
} from '../../git/changes.js';
import { Banner } from './Banner.js';
import type { InitStep } from './InitProgressBlock.js';
import { ConversationView } from './ConversationView.js';
import { CommandPalette } from './CommandPalette.js';
import { ProviderWizard } from './ProviderWizard.js';
import { SelectList } from './components/SelectList.js';
import { SESSION_COMMANDS, filterCommands, filterProfiles } from './session-commands.js';
import { describeProfile, strictestPolicy } from '../../agent/profiles.js';
import { formatProfilesReport } from '../../agent/profiles-report.js';
import { pushHistory, historyPrev, historyNext } from './input-history.js';
import { theme } from './theme.js';
import { useAgentStream } from './useAgentStream.js';
import { INITIALIZE_PROMPT } from '../../agent/initialize-prompt.js';
import { PLAN_MODE_PROMPT } from '../../agent/plan.js';
import { PlanStore, generatePlanId } from '../../session/plan-store.js';
import { SubagentStore } from '../../session/subagent-store.js';

/** Overlays interactivos de sesión (Hito 3.5): /model y /config_provider. */
type OverlayState =
  | { kind: 'model-loading' }
  | { kind: 'model-select'; models: string[] }
  | { kind: 'model-manual'; note?: string }
  | {
      kind: 'wizard';
      initial: {
        name: string;
        baseUrl: string;
        apiKey: string;
        model: string;
        contextWindow: number;
      };
    };

export type AgentConvItem = {
  kind: 'agent';
  text: string;
  toolCalls: ToolCallState[];
  /** Pasos de `/init` (UI §5.2). Presente solo en el item que ejecuta `/init`. */
  initSteps?: InitStep[];
  /** Resumen de `/init` una vez terminado: colapsa el bloque de progreso. */
  initSummary?: string;
  /** Bloques `⊙ thinking` del turno; solo se pintan con `/debug` activo (§11). */
  thinkingBlocks?: string[];
  /** Subagentes delegados en este turno (Hito 8A). Opcional: items previos no lo traen. */
  subagents?: SubagentBlockState[];
  /** Subagente que emitió el evento más reciente (Hito 8C, marcador ▶ del árbol). */
  speakingSubagentId?: string | null;
  /** maxConcurrency del turno (Hito 8C, cabecera de `<AgentTree>`). */
  maxConcurrency?: number;
  streaming: boolean;
};

export type ConvItem = { kind: 'user'; text: string } | AgentConvItem;

export interface PendingConfirm {
  callId: string;
  toolName: string;
  description: string;
}

interface AppState {
  phase: 'banner' | 'conversation';
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  inputValue: string;
  thinking: boolean;
  contextUsed: number;
  contextMax: number;
  contextEstimated: boolean;
  /** Máquina de foco (§10): input ↔ block-focus ↔ subagent-view (§5.7). */
  focusState: 'input' | 'block-focus' | 'subagent-view';
  focusedBlockIndex: number;
  /** ids de tool call blocks con output expandido (Space). */
  expandedBlockIds: ReadonlySet<string>;
  /** Confirmación destructiva pendiente (UI §12). */
  pendingConfirm: PendingConfirm | null;
  // ----- Plan & Execute (Hito 7, UI §5.4) -----
  planMode: AgentMode;
  plan: Plan | null;
  pendingApproval: boolean;
  /** Tanda de preguntas pendiente (Hito 2.5, F7); null fuera del gate. */
  pendingQuestions: QuestionItem[] | null;
  // ----- Inspector de subagentes (Hito 8C, §5.7) -----
  /** Transcripts en memoria de los subagentes de la sesión (por subagentId). */
  subagentTranscripts: Map<string, SubagentTranscript>;
  /** Desplegable de selección de subagente abierto (`/subagents`). */
  subagentPicker: boolean;
  /** Subagente cuyo transcript se está inspeccionando; null fuera de la vista. */
  viewingSubagentId: string | null;
  /** `agents.maxConcurrency` de la config (Hito 8C, cabecera del árbol). */
  maxConcurrency: number;
  /** Error fatal del agente (UI §11): bloquea el input de forma permanente. */
  fatalError: { message: string } | null;
  /** `/debug` (UI §5.2): muestra los bloques `⊙ thinking` del agente. */
  debug: boolean;
  // ----- Lista de tareas (Hito 11, UI §5.9) -----
  /** Tareas vivas del turno; vacía cuando el agente no lleva lista. */
  todos: TodoItem[];
  /** Turnos con tareas abiertas sin que el modelo tocara la lista. */
  todoStale: number;
  /** `/todo` y Ctrl+T colapsan el panel sin borrar la lista. */
  todoCollapsed: boolean;
  // ----- Working tree y tokens (Hito 13) -----
  /** Estado del working tree; alimenta el `+N/-M` de la barra y `/changes`. */
  changes: ChangesSummary;
  /** Contabilidad de tokens de la sesión para el medidor de la barra. */
  tokens: TokenAccounting;
}

/**
 * Texto del contador de tokens para `/context` (Hito 13). Nunca inventa un
 * número: cuando no hay dato dice por qué no lo hay.
 */
function describeTokenUsage(usage: TokenAccounting): string {
  if (usage.status === 'reported') return `${usage.tokens ?? 0} (reportado por el provider)`;
  if (usage.status === 'unsupported') {
    return 'sin dato — este backend no devuelve `usage` en el stream';
  }
  return 'sin dato todavía';
}

export type AppAction =
  | { type: 'AGENT_START'; input: string }
  | { type: 'AGENT_EVENT'; event: AgentEvent }
  | {
      type: 'CONTEXT_UPDATE';
      used: number;
      max: number;
      estimated: boolean;
      tokens?: TokenAccounting;
    }
  | { type: 'CHANGES_UPDATE'; summary: ChangesSummary }
  | { type: 'INPUT_CHANGE'; value: string }
  | { type: 'SYSTEM_MESSAGE'; text: string }
  | { type: 'INIT_START' }
  | { type: 'INIT_STEP'; step: InitStep }
  | { type: 'INIT_DONE'; summary?: string }
  | { type: 'CLEAR' }
  | { type: 'TOGGLE_DEBUG' }
  | { type: 'TOGGLE_TODO' }
  | { type: 'RESTORE_HISTORY'; items: ConvItem[] }
  | { type: 'CONFIRM_SHOW'; request: PendingConfirm }
  | { type: 'CONFIRM_RESOLVE' }
  | { type: 'QUESTIONS_RESOLVE' }
  | { type: 'PLAN_MODE_START' }
  | { type: 'APPROVE_PLAN'; plan: Plan }
  | { type: 'REJECT_PLAN' }
  | { type: 'FOCUS_BLOCKS' }
  | { type: 'FOCUS_MOVE'; delta: number }
  | { type: 'FOCUS_EXIT' }
  | { type: 'TOGGLE_EXPAND' }
  | { type: 'OPEN_SUBAGENT_PICKER' }
  | { type: 'CLOSE_SUBAGENT_PICKER' }
  | { type: 'ENTER_SUBAGENT_VIEW'; id: string }
  | { type: 'EXIT_SUBAGENT_VIEW' };

/**
 * Bloques navegables con Tab: los del turno en curso, o los del último turno
 * completado (que MessageList mantiene fuera de <Static> precisamente para esto).
 * Incluye tool calls y bloques de subagente (Hito 8A), ambos con `.id`.
 */
function blocksOf(item: AgentConvItem): Array<{ id: string }> {
  return [...item.toolCalls, ...(item.subagents ?? [])];
}

function getActiveBlocks(state: AppState): Array<{ id: string }> {
  if (state.currentItem?.kind === 'agent' && blocksOf(state.currentItem).length > 0) {
    return blocksOf(state.currentItem);
  }
  const last = state.completedItems[state.completedItems.length - 1];
  if (last?.kind === 'agent') return blocksOf(last);
  return [];
}

/**
 * Traduce el historial guardado de una sesión a items de conversación para
 * `/sessions resume <id>` en caliente. El system prompt y los mensajes de tool
 * no se pintan: no son turnos visibles de la conversación.
 */
function messagesToConvItems(messages: Message[]): ConvItem[] {
  const items: ConvItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      items.push({ kind: 'user', text: msg.content });
    } else if (msg.role === 'assistant' && msg.content) {
      items.push({ kind: 'agent', text: msg.content, toolCalls: [], streaming: false });
    }
  }
  return items;
}

function updateCurrentAgent(
  current: ConvItem | null,
  updater: (item: AgentConvItem) => AgentConvItem,
): ConvItem | null {
  if (!current || current.kind !== 'agent') return current;
  return updater(current);
}

function updateToolCall(
  toolCalls: ToolCallState[],
  id: string,
  updater: (tc: ToolCallState) => ToolCallState,
): ToolCallState[] {
  return toolCalls.map((tc) => (tc.id === id ? updater(tc) : tc));
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'AGENT_START': {
      const userItem: ConvItem = { kind: 'user', text: action.input };
      const agentItem: AgentConvItem = { kind: 'agent', text: '', toolCalls: [], streaming: true };
      return {
        ...state,
        phase: 'conversation',
        completedItems: [...state.completedItems, userItem],
        currentItem: agentItem,
        inputValue: '',
        thinking: true,
        focusState: 'input',
        focusedBlockIndex: 0,
      };
    }

    case 'SYSTEM_MESSAGE': {
      const item: ConvItem = { kind: 'agent', text: action.text, toolCalls: [], streaming: false };
      return {
        ...state,
        phase: 'conversation',
        completedItems: [...state.completedItems, item],
      };
    }

    case 'INIT_START': {
      const item: AgentConvItem = {
        kind: 'agent',
        text: '',
        toolCalls: [],
        initSteps: [],
        streaming: true,
      };
      return {
        ...state,
        phase: 'conversation',
        completedItems: [...state.completedItems],
        currentItem: item,
        inputValue: '',
        thinking: true,
      };
    }

    // Upsert por `id`: el mismo paso pasa de 'running' a su estado terminal
    // sin duplicarse en el bloque de progreso (§5.2).
    case 'INIT_STEP': {
      return {
        ...state,
        currentItem: updateCurrentAgent(state.currentItem, (item) => {
          const steps = item.initSteps ?? [];
          const idx = steps.findIndex((s) => s.id === action.step.id);
          const next =
            idx >= 0
              ? steps.map((s, i) => (i === idx ? { ...s, ...action.step } : s))
              : [...steps, action.step];
          return { ...item, initSteps: next };
        }),
      };
    }

    case 'INIT_DONE': {
      const finalItem =
        state.currentItem && state.currentItem.kind === 'agent'
          ? { ...state.currentItem, streaming: false, initSummary: action.summary }
          : state.currentItem;
      return {
        ...state,
        completedItems: finalItem ? [...state.completedItems, finalItem] : state.completedItems,
        currentItem: null,
        thinking: false,
      };
    }

    // `/clear` y Ctrl+L (§5.2, §10). Mantiene el sessionId; el historial del LLM
    // lo purga por separado `agent.clearHistory()` en el handler.
    case 'CLEAR': {
      return {
        ...state,
        completedItems: [],
        currentItem: null,
        inputValue: '',
        thinking: false,
        focusState: 'input',
        focusedBlockIndex: 0,
        expandedBlockIds: new Set(),
        plan: null,
        planMode: 'normal',
        pendingApproval: false,
        subagentTranscripts: new Map(),
        subagentPicker: false,
        viewingSubagentId: null,
        fatalError: null,
        todos: [],
        todoStale: 0,
      };
    }

    case 'TOGGLE_DEBUG':
      return { ...state, debug: !state.debug };

    case 'TOGGLE_TODO':
      return { ...state, todoCollapsed: !state.todoCollapsed };

    // `/sessions resume <id>` en caliente: repinta el historial cargado.
    case 'RESTORE_HISTORY':
      return { ...state, phase: 'conversation', completedItems: action.items };

    case 'CONFIRM_SHOW':
      return { ...state, pendingConfirm: action.request };

    case 'CONFIRM_RESOLVE':
      return { ...state, pendingConfirm: null };

    case 'QUESTIONS_RESOLVE':
      return { ...state, pendingQuestions: null };

    case 'PLAN_MODE_START':
      return { ...state, planMode: 'plan', plan: null, pendingApproval: false };

    case 'APPROVE_PLAN':
      return { ...state, planMode: 'execute', plan: action.plan, pendingApproval: false };

    case 'REJECT_PLAN':
      return { ...state, planMode: 'normal', plan: null, pendingApproval: false };

    case 'FOCUS_BLOCKS': {
      const blocks = getActiveBlocks(state);
      if (blocks.length === 0) return state;
      return { ...state, focusState: 'block-focus', focusedBlockIndex: 0 };
    }

    case 'FOCUS_MOVE': {
      const blocks = getActiveBlocks(state);
      if (blocks.length === 0) return { ...state, focusState: 'input' };
      const next = (state.focusedBlockIndex + action.delta + blocks.length) % blocks.length;
      return { ...state, focusedBlockIndex: next };
    }

    case 'FOCUS_EXIT':
      return { ...state, focusState: 'input' };

    case 'TOGGLE_EXPAND': {
      const blocks = getActiveBlocks(state);
      const block = blocks[state.focusedBlockIndex];
      if (!block) return state;
      const expanded = new Set(state.expandedBlockIds);
      if (expanded.has(block.id)) expanded.delete(block.id);
      else expanded.add(block.id);
      return { ...state, expandedBlockIds: expanded };
    }

    case 'AGENT_EVENT': {
      const ev = action.event;

      if (ev.type === 'text_delta') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            text: item.text + ev.delta,
          })),
        };
      }

      if (ev.type === 'tool_call_start') {
        // delegate_task se intercepta en el loop y se renderiza como SubagentBlock
        // (vía subagent_started/completed), no como tool call crudo (Hito 8A).
        if (ev.name === DELEGATE_TASK_TOOL) return state;
        // `todo` se intercepta en el loop y se pinta como <TodoView> (Hito 11),
        // no como tool call crudo: el bloque repetiría la misma información.
        if (ev.name === TODO_TOOL) return state;
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => {
            const exists = item.toolCalls.find((tc) => tc.id === ev.id);
            if (exists) {
              return {
                ...item,
                toolCalls: updateToolCall(item.toolCalls, ev.id, (tc) => ({
                  ...tc,
                  inputSoFar: ev.input_so_far,
                })),
              };
            }
            return {
              ...item,
              toolCalls: [
                ...item.toolCalls,
                {
                  id: ev.id,
                  name: ev.name,
                  // §5.1: pending = en cola (args aún streameando / esperando dispatch)
                  status: 'pending' as const,
                  inputSoFar: ev.input_so_far,
                },
              ],
            };
          }),
        };
      }

      if (ev.type === 'tool_call_ready') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            toolCalls: updateToolCall(item.toolCalls, ev.id, (tc) => ({
              ...tc,
              status: 'running' as const,
              input: ev.input,
            })),
          })),
        };
      }

      if (ev.type === 'tool_result') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            toolCalls: updateToolCall(item.toolCalls, ev.id, (tc) => ({
              ...tc,
              status: 'completed' as const,
              output: ev.result,
              durationMs: ev.durationMs,
            })),
          })),
        };
      }

      if (ev.type === 'tool_error') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            toolCalls: updateToolCall(item.toolCalls, ev.id, (tc) => ({
              ...tc,
              status: 'error' as const,
              errorMsg: ev.error,
            })),
          })),
        };
      }

      if (ev.type === 'memory_retrieved') {
        // Indicador discreto (§UI 11): el agente recuperó memoria semántica.
        const n = ev.decisions.length;
        const note: ConvItem = {
          kind: 'agent',
          text: `↳ memoria recuperada: ${n} decisión${n === 1 ? '' : 'es'} relevante${n === 1 ? '' : 's'}`,
          toolCalls: [],
          streaming: false,
        };
        return { ...state, completedItems: [...state.completedItems, note] };
      }

      // Hito 8A/8C — el agente delegó una subtarea: añadir un bloque/nodo de
      // subagente en estado running al turno en curso, e iniciar su transcript
      // en memoria (§5.7) para el inspector `/subagents`.
      if (ev.type === 'subagent_started') {
        const existingSubs =
          state.currentItem?.kind === 'agent' ? (state.currentItem.subagents ?? []) : [];
        const n = existingSubs.length + 1;
        const transcripts = new Map(state.subagentTranscripts);
        transcripts.set(ev.subagentId, {
          id: ev.subagentId,
          profile: ev.profile,
          n,
          task: ev.task,
          status: 'running',
          events: [],
        });
        return {
          ...state,
          subagentTranscripts: transcripts,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            maxConcurrency: state.maxConcurrency,
            speakingSubagentId: ev.subagentId,
            subagents: [
              ...(item.subagents ?? []),
              {
                id: ev.subagentId,
                profile: ev.profile,
                task: ev.task,
                n,
                status: 'running' as const,
                toolCalls: [],
              },
            ],
          })),
        };
      }

      // Hito 8C — evento del loop hijo re-emitido envuelto: alimenta los tool
      // calls del nodo del árbol (ignora text_delta ahí) y acumula el evento en
      // el transcript del subagente (§5.6/§5.7). Marca `speakingSubagentId`.
      if (ev.type === 'subagent_event') {
        const transcripts = new Map(state.subagentTranscripts);
        const prev = transcripts.get(ev.subagentId);
        if (prev) {
          transcripts.set(ev.subagentId, { ...prev, events: [...prev.events, ev.event] });
        }
        const inner = ev.event;
        const affectsToolCalls =
          inner.type === 'tool_call_start' ||
          inner.type === 'tool_call_ready' ||
          inner.type === 'tool_result' ||
          inner.type === 'tool_error';
        return {
          ...state,
          subagentTranscripts: transcripts,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            speakingSubagentId: ev.subagentId,
            subagents: affectsToolCalls
              ? (item.subagents ?? []).map((s) =>
                  s.id === ev.subagentId
                    ? { ...s, toolCalls: applyToolEvent(s.toolCalls ?? [], inner) }
                    : s,
                )
              : (item.subagents ?? []),
          })),
        };
      }

      // Hito 8A/8C — el subagente terminó: fijar estado final + resumen + ficheros,
      // cerrar su transcript y, si todos los del turno terminaron, limpiar `speaking`.
      if (ev.type === 'subagent_completed') {
        const r = ev.result;
        const status: SubagentBlockState['status'] =
          r.status === 'completed'
            ? 'completed'
            : r.status === 'cancelled'
              ? 'cancelled'
              : r.status === 'budget_exceeded'
                ? 'budget_exceeded'
                : r.status === 'interrupted'
                  ? 'interrupted'
                  : 'failed';
        const transcripts = new Map(state.subagentTranscripts);
        const prevT = transcripts.get(ev.subagentId);
        if (prevT) {
          transcripts.set(ev.subagentId, {
            ...prevT,
            status,
            iterations: r.usage.iterations,
            tokens: r.usage.tokens,
            durationMs: r.usage.durationMs,
          });
        }
        return {
          ...state,
          subagentTranscripts: transcripts,
          currentItem: updateCurrentAgent(state.currentItem, (item) => {
            const subagents = (item.subagents ?? []).map((s) =>
              s.id === ev.subagentId
                ? {
                    ...s,
                    status,
                    summary: r.summary,
                    filesChanged: r.filesChanged,
                    iterations: r.usage.iterations,
                    durationMs: r.usage.durationMs,
                    error: r.error,
                  }
                : s,
            );
            const anyRunning = subagents.some(
              (s) => s.status === 'running' || s.status === 'queued',
            );
            return {
              ...item,
              subagents,
              speakingSubagentId: anyRunning ? item.speakingSubagentId : null,
            };
          }),
        };
      }

      // Hito 2.5 (F7): el agente abrió la tanda única de preguntas. El gate se
      // resuelve desde <QuestionPrompt> (igual que el destructivo y el de plan);
      // questions_answered solo confirma el cierre.
      if (ev.type === 'questions_asked') {
        return { ...state, pendingQuestions: ev.questions };
      }
      if (ev.type === 'questions_answered') {
        return { ...state, pendingQuestions: null };
      }

      // Hito 11: la lista de tareas cambió (o se reinyectó al arrancar el turno).
      if (ev.type === 'todo_updated') {
        return { ...state, todos: ev.items, todoStale: ev.stale };
      }

      // Hito 7 — Fase 2: el agente propuso un plan; abrir el gate de aprobación.
      if (ev.type === 'plan_proposed') {
        return { ...state, plan: ev.plan, pendingApproval: true };
      }

      // Hito 7 — Fase 3: actualización in-place del estado de un paso.
      if (ev.type === 'plan_step_update') {
        if (!state.plan) return state;
        return {
          ...state,
          plan: {
            ...state.plan,
            steps: state.plan.steps.map((s) =>
              s.id === ev.stepId ? { ...s, status: ev.status } : s,
            ),
          },
        };
      }

      if (ev.type === 'done') {
        const rawCurrent = state.currentItem;
        const finalItem =
          rawCurrent && rawCurrent.kind === 'agent'
            ? { ...rawCurrent, streaming: false }
            : rawCurrent;
        const completed = finalItem
          ? [...state.completedItems, finalItem]
          : [...state.completedItems];

        // Hito 7: al terminar un plan en ejecución, colapsar <PlanView> a una
        // línea de resumen (UI §5.4) y volver al modo normal.
        if (state.plan && state.planMode === 'execute') {
          const total = state.plan.steps.length;
          const doneCount = state.plan.steps.filter((s) => s.status === 'done').length;
          const skipped = state.plan.steps.filter((s) => s.status === 'skipped').length;
          const pending = total - doneCount - skipped;
          const summary: ConvItem =
            pending === 0
              ? {
                  kind: 'agent',
                  text: `✓ Plan completado — ${total} paso${total === 1 ? '' : 's'} · ${doneCount} ejecutado${doneCount === 1 ? '' : 's'}${skipped ? ` · ${skipped} omitido${skipped === 1 ? '' : 's'}` : ''}`,
                  toolCalls: [],
                  streaming: false,
                }
              : {
                  kind: 'agent',
                  text: `⚠ Plan incompleto — ${doneCount + skipped}/${total} pasos · interrumpido`,
                  toolCalls: [],
                  streaming: false,
                };
          return {
            ...state,
            completedItems: [...completed, summary],
            currentItem: null,
            thinking: false,
            pendingConfirm: null,
            pendingQuestions: null,
            planMode: 'normal',
            plan: null,
            pendingApproval: false,
          };
        }

        return {
          ...state,
          completedItems: completed,
          currentItem: null,
          thinking: false,
          pendingConfirm: null,
          pendingQuestions: null,
          planMode: 'normal',
          pendingApproval: false,
        };
      }

      // Error fatal (§11): bloque <FatalError> dedicado, no texto inline. El
      // input queda bloqueado permanentemente mientras `fatalError` no sea null.
      if (ev.type === 'error' && ev.fatal) {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            streaming: false,
          })),
          thinking: false,
          fatalError: { message: ev.message },
        };
      }

      // `thinking` no se renderiza por defecto (§11): solo con /debug activo.
      if (ev.type === 'thinking') {
        if (!state.debug) return state;
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            thinkingBlocks: [...(item.thinkingBlocks ?? []), ev.text],
          })),
        };
      }

      return state;
    }

    case 'CONTEXT_UPDATE':
      return {
        ...state,
        contextUsed: action.used,
        contextMax: action.max,
        contextEstimated: action.estimated,
        tokens: action.tokens ?? state.tokens,
      };

    case 'CHANGES_UPDATE':
      return { ...state, changes: action.summary };

    case 'INPUT_CHANGE':
      return { ...state, inputValue: action.value };

    // ----- Inspector de subagentes (Hito 8C, §5.7) -----
    case 'OPEN_SUBAGENT_PICKER':
      return { ...state, subagentPicker: true, inputValue: '' };

    case 'CLOSE_SUBAGENT_PICKER':
      return { ...state, subagentPicker: false };

    case 'ENTER_SUBAGENT_VIEW':
      return {
        ...state,
        subagentPicker: false,
        viewingSubagentId: action.id,
        focusState: 'subagent-view',
        focusedBlockIndex: 0,
      };

    case 'EXIT_SUBAGENT_VIEW':
      return {
        ...state,
        viewingSubagentId: null,
        focusState: 'input',
      };

    default:
      return state;
  }
}

interface Props {
  agent: StratumAgent;
  version: string;
  mcpManager?: McpManager;
  /** `mcp.startup === 'eager'`: el banner muestra el panel de arranque (§14). */
  mcpEager?: boolean;
  logoPreRendered: boolean;
  /** Id de la sesión en curso; se propaga al ToolContext para la auditoría SSH. */
  sessionId?: string;
  /** Registry activo, para re-registrar tools MCP tras `/mcp reload`. */
  registry?: ToolRegistry;
}

export function App({
  agent,
  version,
  mcpManager,
  mcpEager,
  logoPreRendered,
  sessionId,
  registry,
}: Props) {
  const { exit } = useApp();

  // Getter de un solo uso: devuelve el plan reanudado (si lo hay) para init de UI.
  // useState con función initializer garantiza que getResumePlan() se llame una sola vez.
  const [resumeInfo] = useState(() => agent.getResumePlan());
  // Hito 15 — perfil principal activo (badge `◆`) y filas de la paleta `@`. Los
  // perfiles se descubren una vez por sesión, así que las filas no cambian.
  const [activeAgent, setActiveAgent] = useState<string | null>(
    () => agent.getActiveProfile()?.name ?? null,
  );
  const [profileRows] = useState(() =>
    agent.delegableProfiles().map((p) => ({
      name: p.name,
      description: describeProfile(p).replace(/\\\|/g, '|'),
    })),
  );
  // PlanStore para re-persistir las actualizaciones de pasos de un plan reanudado.
  const resumePlanStoreRef = useRef<PlanStore | null>(
    resumeInfo ? new PlanStore(process.cwd()) : null,
  );
  // SubagentStore (Hito 8B): persiste resultados de subagentes en cada run para
  // que un cuelgue a mitad de un delegate_task se detecte como interrumpido.
  const subagentStoreRef = useRef<SubagentStore>(new SubagentStore(process.cwd()));

  const ctxInit = agent.getContextUsage();
  const [state, dispatch] = useReducer(reducer, {
    phase: 'banner',
    completedItems: [],
    currentItem: null,
    inputValue: '',
    thinking: false,
    contextUsed: ctxInit.used,
    contextMax: ctxInit.max,
    contextEstimated: ctxInit.estimated,
    focusState: 'input',
    focusedBlockIndex: 0,
    expandedBlockIds: new Set<string>(),
    pendingConfirm: null,
    pendingQuestions: null,
    planMode: resumeInfo ? 'execute' : 'normal',
    plan: resumeInfo?.plan ?? null,
    pendingApproval: false,
    subagentTranscripts: new Map<string, SubagentTranscript>(),
    subagentPicker: false,
    viewingSubagentId: null,
    maxConcurrency: agent.getConfig().agents.maxConcurrency,
    fatalError: null,
    debug: false,
    todos: agent.getTodos(),
    todoStale: 0,
    todoCollapsed: false,
    changes: EMPTY_SUMMARY,
    tokens: { status: 'unavailable' },
  });

  // -------------------------------------------------------------------------
  // Estado MCP: polling del resumen de conectividad para el status bar.
  // Se actualiza cada 5 s mientras haya servers configurados.
  // -------------------------------------------------------------------------
  const [mcpStatus, setMcpStatus] = useState<McpStatusSummary | undefined>(
    mcpManager ? mcpManager.getStatusSummary() : undefined,
  );
  useEffect(() => {
    if (!mcpManager) return;
    const id = setInterval(() => {
      setMcpStatus(mcpManager.getStatusSummary());
    }, 5000);
    return () => clearInterval(id);
  }, [mcpManager]);

  // -------------------------------------------------------------------------
  // Health check del provider (Hito 6): polling no bloqueante cada 30 s.
  // El `●` izquierdo del status bar refleja el resultado en tiempo real.
  // -------------------------------------------------------------------------
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>('checking');
  const refreshProviderHealth = useCallback(() => {
    setProviderStatus('checking');
    agent
      .healthCheck()
      .then((ok) => setProviderStatus(ok ? 'connected' : 'disconnected'))
      .catch(() => setProviderStatus('disconnected'));
  }, [agent]);
  useEffect(() => {
    refreshProviderHealth();
    const id = setInterval(refreshProviderHealth, 30000);
    return () => clearInterval(id);
  }, [refreshProviderHealth]);

  // -------------------------------------------------------------------------
  // Confirmación destructiva (UI §12): el dispatcher pausa la ejecución y
  // espera la promesa; el usuario resuelve con S/N/! desde <DestructiveConfirm>.
  // -------------------------------------------------------------------------
  const confirmResolverRef = useRef<((d: DestructiveDecision) => void) | null>(null);
  const allowAllRef = useRef(false);

  const onConfirmDestructive = useCallback((req: ConfirmRequest): Promise<DestructiveDecision> => {
    return new Promise<DestructiveDecision>((resolve) => {
      confirmResolverRef.current = resolve;
      dispatch({
        type: 'CONFIRM_SHOW',
        request: { callId: req.callId, toolName: req.toolName, description: req.description },
      });
    });
  }, []);

  const resolveConfirm = useCallback((decision: DestructiveDecision) => {
    if (decision === 'allow-all') allowAllRef.current = true;
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    dispatch({ type: 'CONFIRM_RESOLVE' });
    resolver?.(decision);
  }, []);

  // -------------------------------------------------------------------------
  // Tanda única de preguntas (Hito 2.5, F7): el loop intercepta la tool
  // `question`, emite questions_asked (que abre el gate en el reducer) y espera
  // aquí; <QuestionPrompt> resuelve con las respuestas o con null si se omite.
  // -------------------------------------------------------------------------
  const questionsResolverRef = useRef<((a: QuestionAnswer[] | null) => void) | null>(null);

  const onAskQuestions = useCallback((): Promise<QuestionAnswer[] | null> => {
    return new Promise<QuestionAnswer[] | null>((resolve) => {
      questionsResolverRef.current = resolve;
    });
  }, []);

  const resolveQuestions = useCallback((answers: QuestionAnswer[] | null) => {
    const resolve = questionsResolverRef.current;
    questionsResolverRef.current = null;
    dispatch({ type: 'QUESTIONS_RESOLVE' });
    resolve?.(answers);
  }, []);

  // Refs que reflejan el estado del plan para getRunOptions (sin necesitar deps de state).
  const planModeRef = useRef(state.planMode);
  planModeRef.current = state.planMode;
  const planDataRef = useRef<Plan | null>(state.plan);
  planDataRef.current = state.plan;

  const getRunOptions = useCallback((): Partial<RunOptions> => {
    const opts: Partial<RunOptions> = {
      sessionId,
      // Hito 15: la política de un perfil principal solo endurece la de la sesión.
      destructivePolicy: strictestPolicy(
        allowAllRef.current ? 'allow' : 'ask',
        agent.getActiveProfile()?.destructivePolicy,
      ),
      onConfirmDestructive,
      onAskQuestions,
      onSubagentPersist: (rec) =>
        rec.result
          ? subagentStoreRef.current.saveResult(rec.id, rec.profile, rec.task, rec.result)
          : subagentStoreRef.current.saveRunning(rec.id, rec.profile, rec.task),
    };
    // Reanudación de plan (§12.6): inyectar mode/plan para que update_plan esté
    // disponible y el loop pueda actualizar los estados de los pasos.
    if (planModeRef.current === 'execute' && planDataRef.current) {
      opts.mode = 'execute';
      opts.plan = planDataRef.current;
      // El preámbulo de reanudación ya está en el historial; no re-inyectar el checklist.
      opts.isResumePlan = true;
      if (resumeInfo && resumePlanStoreRef.current) {
        const planRef = agent.getPlanRef();
        if (planRef) {
          opts.onPlanPersist = (p, _done) =>
            resumePlanStoreRef.current!.save(planRef, resumeInfo.task, p, resumeInfo.createdAt);
        }
      }
    }
    return opts;
  }, [onConfirmDestructive, onAskQuestions, resumeInfo, agent, sessionId]);

  const { send, cancel } = useAgentStream(agent, dispatch, getRunOptions);

  // -------------------------------------------------------------------------
  // Helpers de los comandos de sesión (§5.2, Hito 10)
  // -------------------------------------------------------------------------

  /** Repinta el status bar tras una operación que altera el historial. */
  const refreshContext = useCallback(() => {
    const u = agent.getContextUsage();
    dispatch({ type: 'CONTEXT_UPDATE', used: u.used, max: u.max, estimated: u.estimated });
  }, [agent]);

  /**
   * Estado del working tree (Hito 13). Se recalcula al arrancar y cada vez que
   * el agente termina un turno: dos invocaciones de git por turno son baratas,
   * hacerlo por tool call no lo sería.
   */
  const refreshChanges = useCallback(() => {
    void collectWorkingTreeChanges(process.cwd())
      .then((summary) => dispatch({ type: 'CHANGES_UPDATE', summary }))
      .catch(() => {
        /* el panel es informativo: un fallo de git nunca interrumpe la sesión */
      });
  }, []);

  useEffect(() => {
    if (!state.thinking) refreshChanges();
  }, [state.thinking, refreshChanges]);

  /** Store de sesiones resuelto desde la config activa (mismas rutas que la CLI). */
  const sessionStore = useCallback(
    () => new SessionStore(resolveMemoryPaths(agent.getConfig()).sessionsDir),
    [agent],
  );

  // -------------------------------------------------------------------------
  // Plan & Execute (Hito 7, UI §5.4): el loop emite plan_proposed y espera la
  // decisión del usuario vía onApprovePlan. Se resuelve desde <PlanApproval>,
  // igual que el gate destructivo.
  // -------------------------------------------------------------------------
  const planResolverRef = useRef<((d: PlanDecision) => void) | null>(null);

  const onApprovePlan = useCallback((_proposed: Plan): Promise<PlanDecision> => {
    // El evento plan_proposed (ya despachado por el stream) abrió el gate;
    // aquí solo guardamos el resolver que <PlanApproval> invocará.
    return new Promise<PlanDecision>((resolve) => {
      planResolverRef.current = resolve;
    });
  }, []);

  const resolvePlanApprove = useCallback((finalPlan: Plan) => {
    const resolve = planResolverRef.current;
    planResolverRef.current = null;
    dispatch({ type: 'APPROVE_PLAN', plan: finalPlan });
    resolve?.({ decision: 'approve', plan: finalPlan });
  }, []);

  const resolvePlanReject = useCallback(() => {
    const resolve = planResolverRef.current;
    planResolverRef.current = null;
    dispatch({ type: 'REJECT_PLAN' });
    // Limpiar la ref del plan para que la sesión no se guarde con un planRef
    // apuntando a un plan que nunca llegó a ejecutarse.
    agent.clearPlanRef();
    resolve?.({ decision: 'reject' });
  }, [agent]);

  /**
   * Lanza el modo plan-and-execute (Fase 1 → 2 → 3) en un único turno del
   * agente. La tarea se envuelve en PLAN_MODE_PROMPT; el plan se persiste de
   * forma incremental en .stratum/plans/ para permitir la reanudación (§12.6).
   */
  const runPlan = useCallback(
    (task: string) => {
      const prompt = PLAN_MODE_PROMPT.replaceAll('$ARGUMENTS', task);
      const planRef = generatePlanId();
      const planStore = new PlanStore(process.cwd());
      const createdAt = new Date().toISOString();
      agent.setPlanRef(planRef);

      dispatch({ type: 'PLAN_MODE_START' });
      void send(prompt, {
        displayText: `/plan ${task}`,
        runOptions: {
          mode: 'plan',
          onApprovePlan,
          onPlanPersist: (p, _done) => planStore.save(planRef, task, p, createdAt),
        },
      });
    },
    [agent, send, onApprovePlan],
  );

  // -------------------------------------------------------------------------
  // Overlays de sesión (Hito 3.5): /model y /config_provider
  // -------------------------------------------------------------------------
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  /** Valor en edición del input de modelo manual (overlay model-manual, Hito 6). */
  const [modelManualValue, setModelManualValue] = useState('');
  /** Hint inline de la Vista de Subagente cuando se teclea algo distinto de /quit (§5.7). */
  const [subagentViewHint, setSubagentViewHint] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Paleta de /comandos (UI §5.2)
  // -------------------------------------------------------------------------
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);

  const paletteEligible =
    !state.thinking &&
    !state.pendingConfirm &&
    !state.pendingQuestions &&
    !overlay &&
    state.focusState === 'input' &&
    !paletteDismissed &&
    /^[/@]/.test(state.inputValue.trimStart());
  const paletteItems = !paletteEligible
    ? []
    : state.inputValue.trimStart().startsWith('@')
      ? filterProfiles(state.inputValue, profileRows)
      : filterCommands(state.inputValue, SESSION_COMMANDS);
  const effPaletteIndex = Math.min(paletteIndex, Math.max(paletteItems.length - 1, 0));

  const handleInputChange = useCallback((value: string) => {
    setPaletteDismissed(false);
    setPaletteIndex(0);
    dispatch({ type: 'INPUT_CHANGE', value });
  }, []);

  /** Completa el comando seleccionado en el input (Tab, o Enter en comandos con args). */
  const completePaletteSelection = useCallback((cmdName: string, hasArgs: boolean) => {
    dispatch({ type: 'INPUT_CHANGE', value: hasArgs ? `${cmdName} ` : cmdName });
    setPaletteIndex(0);
  }, []);

  const ctrlCCountRef = useRef(0);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----- Historial de inputs enviados (§10) -----
  // Vive en memoria y no persiste entre sesiones. `draft` guarda lo que el
  // usuario tenía escrito antes de empezar a navegar, para restaurarlo con ↓.
  const historyRef = useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const draftRef = useRef('');
  // `executeCommand` se define más abajo; Ctrl+L lo alcanza por ref.
  const executeCommandRef = useRef<((cmd: string) => void) | null>(null);

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || (key as { name?: string }).name === 'c')) {
      if (overlay) {
        setOverlay(null);
        return;
      }
      if (state.pendingConfirm) {
        resolveConfirm('deny');
        return;
      }
      if (state.pendingQuestions) {
        resolveQuestions(null);
        return;
      }
      if (state.pendingApproval) {
        resolvePlanReject();
        return;
      }
      if (state.thinking) {
        cancel();
        return;
      }
      ctrlCCountRef.current++;
      if (ctrlCCountRef.current === 1) {
        ctrlCTimerRef.current = setTimeout(() => {
          ctrlCCountRef.current = 0;
        }, 1000);
      } else {
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        exit();
      }
      return;
    }

    // Vista de Subagente (Hito 8C, §5.7): Esc cierra y vuelve al agente principal;
    // el resto del input lo teclea el TextInput (solo /quit es válido al enviar).
    if (state.focusState === 'subagent-view') {
      if (key.escape) {
        setSubagentViewHint(null);
        dispatch({ type: 'EXIT_SUBAGENT_VIEW' });
      }
      return;
    }

    // Desplegable de selección de subagente (§5.7): lo gobierna su <SelectList>
    // cuando hay elementos; si está vacío, Esc lo cierra aquí.
    if (state.subagentPicker) {
      if (key.escape && state.subagentTranscripts.size === 0) {
        dispatch({ type: 'CLOSE_SUBAGENT_PICKER' });
      }
      return;
    }

    // Overlay de modelo manual (Hito 6): el TextInput no gestiona Esc, así que
    // lo cancelamos aquí antes del return genérico de overlays.
    if (overlay?.kind === 'model-manual' && key.escape) {
      setOverlay(null);
      return;
    }

    // Los overlays gestionan su propio input (SelectList / wizard)
    if (overlay) return;

    // El prompt de confirmación gestiona su propio input (S/N/!)
    if (state.pendingConfirm) return;

    // El gate de aprobación de plan gestiona su propio input (A/E/R)
    if (state.pendingApproval) return;

    // La tanda de preguntas gestiona su propio input (selector / texto libre)
    if (state.pendingQuestions) return;

    // ----- Paleta de /comandos (§5.2): ↑↓ navega, Tab completa, Esc cierra -----
    if (paletteItems.length > 0) {
      const len = paletteItems.length;
      if (key.upArrow) {
        setPaletteIndex((effPaletteIndex - 1 + len) % len);
        return;
      }
      if (key.downArrow) {
        setPaletteIndex((effPaletteIndex + 1) % len);
        return;
      }
      if (key.tab) {
        const sel = paletteItems[effPaletteIndex];
        if (sel) completePaletteSelection(sel.name, sel.hasArgs);
        return;
      }
      if (key.escape) {
        setPaletteDismissed(true);
        return;
      }
    }

    // ----- Edición de línea (§10) -----
    // Se evalúan tras la paleta: con el desplegable abierto, ↑↓ le pertenecen.
    if (key.ctrl && input === 'l') {
      executeCommandRef.current?.('/clear');
      return;
    }

    // Ctrl+T colapsa el panel de tareas (Hito 11). Ctrl+Shift+T, que sería el
    // atajo natural, no llega al proceso en la mayoría de terminales.
    if (key.ctrl && input === 't') {
      dispatch({ type: 'TOGGLE_TODO' });
      return;
    }

    if (key.ctrl && input === 'u') {
      draftRef.current = '';
      setHistoryIndex(null);
      dispatch({ type: 'INPUT_CHANGE', value: '' });
      return;
    }

    // ----- Historial de inputs enviados (§10) -----
    if (state.focusState === 'input' && (key.upArrow || key.downArrow)) {
      if (historyRef.current.length === 0) return;
      if (historyIndex === null) draftRef.current = state.inputValue;
      const nav = key.upArrow
        ? historyPrev(historyRef.current, historyIndex, draftRef.current)
        : historyNext(historyRef.current, historyIndex, draftRef.current);
      setHistoryIndex(nav.index);
      dispatch({ type: 'INPUT_CHANGE', value: nav.value });
      return;
    }

    // ----- Máquina de foco (§10): input ↔ block-focus -----
    if (key.tab) {
      if (state.focusState === 'block-focus') {
        dispatch({ type: 'FOCUS_MOVE', delta: key.shift ? -1 : 1 });
      } else if (!/^[/@]/.test(state.inputValue)) {
        dispatch({ type: 'FOCUS_BLOCKS' });
      }
      return;
    }

    if (state.focusState === 'block-focus') {
      if (input === ' ') {
        dispatch({ type: 'TOGGLE_EXPAND' });
      } else if (key.escape) {
        dispatch({ type: 'FOCUS_EXIT' });
      }
    }
  });

  /**
   * Lanza /init usando el agente regular para explorar el repo libremente.
   * El agente usa read_file, write_file y exec para explorar y escribir
   * STRATUM.md, igual que opencode.
   *
   * Las actualizaciones de UI se limitan a tool_call_start y tool_result
   * para evitar el parpadeo de Ink causado por los text_delta a alta frecuencia.
   */
  const runInit = useCallback(
    (focus?: string) => {
      dispatch({ type: 'INIT_START' });

      const cwd = process.cwd();
      const prompt = INITIALIZE_PROMPT.replaceAll('${path}', cwd).replaceAll(
        '$ARGUMENTS',
        focus?.trim() || '(none)',
      );

      void (async () => {
        try {
          let currentTool = '';
          let toolCount = 0;
          let wroteStratum = false;
          let agentText = '';
          // ids de write_file apuntando a STRATUM.md, para confirmar la escritura real
          const stratumWriteIds = new Set<string>();

          const consume = async (input: string): Promise<void> => {
            agentText = '';
            for await (const event of agent.run(input, {
              compressionMode: 'conservative',
              // F7: `/init` es interactivo — el agente puede abrir la tanda única
              // de preguntas antes de escribir STRATUM.md.
              onAskQuestions,
            })) {
              if (event.type === 'questions_asked' || event.type === 'questions_answered') {
                dispatch({ type: 'AGENT_EVENT', event });
              } else if (event.type === 'text_delta') {
                agentText += event.delta;
              } else if (
                event.type === 'tool_call_start' &&
                currentTool !== event.name + event.id
              ) {
                currentTool = event.name + event.id;
                toolCount++;
                dispatch({
                  type: 'INIT_STEP',
                  step: { id: event.id, label: event.name, status: 'running' },
                });
              } else if (event.type === 'tool_call_ready') {
                if (
                  event.name === 'write_file' &&
                  String((event.input as { path?: unknown }).path ?? '').includes('STRATUM.md')
                ) {
                  stratumWriteIds.add(event.id);
                }
              } else if (event.type === 'tool_result') {
                if (stratumWriteIds.has(event.id)) wroteStratum = true;
                dispatch({
                  type: 'INIT_STEP',
                  step: { id: event.id, label: event.name, status: 'completed' },
                });
                currentTool = '';
              } else if (event.type === 'error' && event.fatal) {
                dispatch({
                  type: 'INIT_STEP',
                  step: {
                    id: `err-${toolCount}`,
                    label: 'Error',
                    status: 'failed',
                    detail: event.message,
                  },
                });
              }
            }
          };

          await consume(prompt);

          // Mitigación para modelos pequeños: si el run terminó sin escribir el
          // fichero, reinyectar una instrucción directa una única vez.
          if (!wroteStratum) {
            dispatch({
              type: 'INIT_STEP',
              step: {
                id: 'retry',
                label: 'Reintentando con instrucción directa',
                status: 'running',
              },
            });
            await consume(
              `You have not written the file yet. Based on your investigation so far, call the write_file tool NOW with the complete contents of STRATUM.md at path ${cwd}/STRATUM.md. Do not reply with text only — make the tool call.`,
            );
            dispatch({
              type: 'INIT_STEP',
              step: {
                id: 'retry',
                label: 'Reintentando con instrucción directa',
                status: wroteStratum ? 'completed' : 'failed',
              },
            });
          }

          if (wroteStratum) {
            agent.reloadMemory();
            // §5.2: el bloque colapsa a una línea de resumen. Las secciones se
            // cuentan sobre el fichero recién escrito, no sobre lo que dijo el LLM.
            let sections = 0;
            try {
              const md = readFileSync(join(cwd, 'STRATUM.md'), 'utf-8');
              sections = (md.match(/^##\s+/gm) ?? []).length;
            } catch {
              /* el resumen es informativo: si no se puede leer, se omite el dato */
            }
            const parts = [
              sections > 0 ? `${sections} secciones` : null,
              `${toolCount} operaciones`,
            ].filter(Boolean);
            dispatch({
              type: 'INIT_DONE',
              summary: `STRATUM.md actualizado — ${parts.join(' · ')}`,
            });
            return;
          }

          const detail = agentText.trim()
            ? ` Respuesta del agente: ${agentText.trim().slice(0, 500)}`
            : '';
          dispatch({
            type: 'INIT_DONE',
            summary: `El agente terminó sin escribir STRATUM.md.${detail}`,
          });
          return;
        } catch (err) {
          dispatch({
            type: 'INIT_STEP',
            step: { id: 'fatal', label: 'Error', status: 'failed', detail: String(err) },
          });
          dispatch({ type: 'INIT_DONE' });
        }
      })();
    },
    [agent, onAskQuestions],
  );

  // -------------------------------------------------------------------------
  // /model — selector de modelo en sesión (Hito 3.5)
  // -------------------------------------------------------------------------
  const openModelSelector = useCallback(() => {
    setOverlay({ kind: 'model-loading' });
    const cfg = agent.getActiveProviderConfig();
    // Hito 6: detectar capacidades en vez de fallar en seco. Los modelos vienen
    // SIEMPRE del endpoint en vivo (no de la config), así que un modelo nuevo
    // del provider — p. ej. uno que LiteLLM acaba de añadir — aparece sin tocar
    // .stratumrc.json. Si /models no está soportado, se ofrece entrada manual.
    detectCapabilities(cfg.baseUrl, cfg.apiKey)
      .then((caps) => {
        if (caps.listsModels && caps.models.length > 0) {
          setOverlay({ kind: 'model-select', models: caps.models });
        } else {
          setModelManualValue(agent.model);
          setOverlay({ kind: 'model-manual', note: caps.note });
        }
      })
      .catch((err: unknown) => {
        setModelManualValue(agent.model);
        setOverlay({ kind: 'model-manual', note: String(err) });
      });
  }, [agent]);

  // Aplica un modelo (de la lista o escrito a mano) a la sesión en curso.
  const applyModel = useCallback(
    (model: string) => {
      setOverlay(null);
      const trimmed = model.trim();
      if (!trimmed || trimmed === agent.model) return;
      agent.switchModel(trimmed);
      refreshProviderHealth();
      dispatch({
        type: 'SYSTEM_MESSAGE',
        text: `Modelo cambiado a ${trimmed} (solo esta sesión; no se ha modificado .stratumrc.json).`,
      });
    },
    [agent, refreshProviderHealth],
  );

  // -------------------------------------------------------------------------
  // /config_provider — wizard pre-rellenado con el provider activo (Hito 3.5)
  // -------------------------------------------------------------------------
  const openProviderEditor = useCallback(() => {
    const name = agent.providerName;
    const active = agent.getActiveProviderConfig();
    // Valores crudos del archivo (preservan placeholders ${VAR}); si el provider
    // no está en el archivo escribible, se cae a los valores activos en memoria.
    const raw = readRawProvider(name);
    setOverlay({
      kind: 'wizard',
      initial: {
        name,
        baseUrl: typeof raw?.['baseUrl'] === 'string' ? (raw['baseUrl'] as string) : active.baseUrl,
        apiKey: typeof raw?.['apiKey'] === 'string' ? (raw['apiKey'] as string) : active.apiKey,
        model: typeof raw?.['model'] === 'string' ? (raw['model'] as string) : active.model,
        contextWindow:
          typeof raw?.['contextWindow'] === 'number'
            ? (raw['contextWindow'] as number)
            : active.contextWindow,
      },
    });
  }, [agent]);

  const handleWizardComplete = useCallback(
    (result: { name: string; config: ProviderConfig; makeDefault: boolean }) => {
      setOverlay(null);
      try {
        const { configPath, backupPath } = upsertProvider(result.name, result.config, false);
        if (result.name === agent.providerName) {
          // Aplicar en caliente a la sesión (con env vars expandidas)
          const expanded = expandEnvVars(result.config) as ProviderConfig;
          agent.reconfigureProvider(expanded);
        }
        dispatch({
          type: 'SYSTEM_MESSAGE',
          text:
            `Provider "${result.name}" guardado en ${configPath}` +
            (backupPath ? ` (backup: ${backupPath})` : '') +
            '. Cambios aplicados a la sesión actual.',
        });
      } catch (err) {
        dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al guardar la config: ${String(err)}` });
      }
    },
    [agent],
  );

  const executeCommand = useCallback(
    (cmd: string) => {
      if (cmd === '/quit' || cmd === '/exit') {
        exit();
        return;
      }

      // Hito 15 — `@perfil tarea`: el subagente atiende la tarea directamente,
      // sin pasar por el agente principal. Un `@` que no nombra un perfil se
      // envía como mensaje normal: puede ser un correo, un paquete npm, etc.
      const mention = cmd.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
      const mentioned = mention
        ? agent.listProfiles().find((p) => p.name === mention[1])
        : undefined;
      if (mention && mentioned) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const taskText = (mention[2] ?? '').trim();
        if (!agent.delegableProfiles().some((p) => p.name === mentioned.name)) {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `'${mentioned.name}' es un perfil principal (mode: primary): actívalo con /agent ${mentioned.name}.`,
          });
          return;
        }
        if (!taskText) {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `Uso: @${mentioned.name} <tarea> — delega la tarea en ese subagente.`,
          });
          return;
        }
        void send(taskText, { displayText: cmd, delegateProfile: mentioned.name });
        return;
      }

      if (cmd === '/help') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const width = Math.max(...SESSION_COMMANDS.map((c) => c.name.length)) + 2;
        const lines = SESSION_COMMANDS.map((c) => `  ${c.name.padEnd(width)} ${c.description}`);
        dispatch({ type: 'SYSTEM_MESSAGE', text: `Comandos disponibles:\n\n${lines.join('\n')}` });
        return;
      }

      // ----- Contexto y sesión (§5.2, Hito 10) -----

      // `<Static>` ya volcó los turnos anteriores al scrollback del terminal y
      // no puede "desimprimirlos": hay que limpiar la pantalla a mano.
      if (cmd === '/clear') {
        agent.clearHistory();
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
        dispatch({ type: 'CLEAR' });
        refreshContext();
        return;
      }

      if (cmd === '/compact') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        void (async () => {
          try {
            const result = await agent.compactNow();
            const text =
              result.kind === 'compressed'
                ? `Contexto comprimido: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.roundsCompressed} rondas resumidas).`
                : result.kind === 'truncated'
                  ? `Contexto truncado: ${result.tokensBefore} → ${result.tokensAfter} tokens (${result.roundsRemoved} rondas eliminadas).`
                  : result.kind === 'pressure'
                    ? 'No hay nada que comprimir: toda la conversación está en la zona protegida.'
                    : 'No había nada que comprimir.';
            dispatch({ type: 'SYSTEM_MESSAGE', text });
            refreshContext();
          } catch (err) {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al comprimir: ${String(err)}` });
          }
        })();
        return;
      }

      if (cmd === '/context') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const usage = agent.getContextUsage();
        const source = usage.estimated ? 'estimado (chars/3.5)' : 'reportado por el provider';
        dispatch({
          type: 'SYSTEM_MESSAGE',
          text: [
            'Uso del contexto:',
            '',
            `  contexto       ${usage.used} / ${usage.max} (${usage.pct}%)`,
            `  origen         ${source}`,
            `  mensajes       ${agent.getMessages().length}`,
            `  tool calls     ${agent.toolCallCount}`,
            `  gasto sesión   ${describeTokenUsage(agent.getTokenUsage())}`,
            `  provider       ${agent.providerName} / ${agent.model}`,
            '',
            'El contexto es el tamaño del prompt actual (se reduce al comprimir);',
            'el gasto de sesión es el total consumido, y solo crece.',
          ].join('\n'),
        });
        return;
      }

      // Hito 11: colapsa/despliega el panel de tareas sin tocar la lista. El
      // estado vive en el agente, así que esconderlo no le quita contexto.
      if (cmd === '/todo') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        dispatch({ type: 'TOGGLE_TODO' });
        if (state.todos.length === 0) {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: 'El agente no lleva ninguna lista de tareas ahora mismo.',
          });
        }
        return;
      }

      // Hito 13: el usuario mira `git status` constantemente mientras el agente
      // trabaja. El desglose completo va aquí; la barra solo lleva el total.
      if (cmd === '/changes') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        void (async () => {
          const summary = await collectWorkingTreeChanges(process.cwd());
          dispatch({ type: 'CHANGES_UPDATE', summary });
          dispatch({ type: 'SYSTEM_MESSAGE', text: formatChangesReport(summary) });
        })();
        return;
      }

      if (cmd === '/debug') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        dispatch({ type: 'TOGGLE_DEBUG' });
        dispatch({
          type: 'SYSTEM_MESSAGE',
          text: `Modo debug ${state.debug ? 'desactivado' : 'activado'}: los bloques ⊙ thinking ${state.debug ? 'dejan de mostrarse' : 'se muestran'}.`,
        });
        return;
      }

      if (cmd === '/mcp reload') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        if (!mcpManager || !registry) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'No hay MCP servers configurados.' });
          return;
        }
        dispatch({ type: 'SYSTEM_MESSAGE', text: 'Reiniciando MCP servers...' });
        void (async () => {
          try {
            // Retirar las tools del ciclo anterior: si un server deja de
            // conectar, sus tools no deben quedarse apuntando a un cliente muerto.
            for (const t of registry.list()) {
              if (t.name.startsWith('mcp__')) registry.unregister(t.name);
            }
            await mcpManager.shutdownAll();
            const warnings = await mcpManager.connectAll();
            mcpManager.registerInto(registry);
            mcpManager.startHeartbeat();
            const summary = mcpManager.getStatusSummary();
            const warnText = warnings.length
              ? `\n\n${warnings.map((w) => `  ⚠ ${w.message}`).join('\n')}`
              : '';
            dispatch({
              type: 'SYSTEM_MESSAGE',
              text: `MCP recargado: ${summary.connected}/${summary.total} servers conectados.${warnText}`,
            });
          } catch (err) {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al recargar MCP: ${String(err)}` });
          }
        })();
        return;
      }

      if (cmd === '/sessions list') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        try {
          const sessions = sessionStore().list({ last: 10 });
          if (sessions.length === 0) {
            dispatch({ type: 'SYSTEM_MESSAGE', text: 'No hay sesiones guardadas.' });
            return;
          }
          const lines = sessions.map((s) => {
            const summary = s.summary ? `  ${s.summary}` : '';
            return `  ${s.id}\n    ${new Date(s.updatedAt).toLocaleString()} │ ${s.provider} / ${s.model}${summary}`;
          });
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `Sesiones guardadas (${sessions.length}):\n\n${lines.join('\n\n')}`,
          });
        } catch (err) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: `Error: ${String(err)}` });
        }
        return;
      }

      if (cmd.startsWith('/sessions resume')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const id = cmd.slice('/sessions resume'.length).trim();
        if (!id) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'Uso: /sessions resume <id>' });
          return;
        }
        try {
          const saved = sessionStore().load(id);
          const notice = agent.replaceHistory(saved.messages, saved.activeAgent);
          setActiveAgent(agent.getActiveProfile()?.name ?? null);
          process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
          dispatch({ type: 'CLEAR' });
          dispatch({ type: 'RESTORE_HISTORY', items: messagesToConvItems(saved.messages) });
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text:
              `Sesión ${saved.id} reanudada (${saved.messages.length} mensajes).` +
              (notice ? `\n${notice}` : ''),
          });
          refreshContext();
        } catch (err) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al reanudar: ${String(err)}` });
        }
        return;
      }

      if (cmd.startsWith('/sessions delete')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const id = cmd.slice('/sessions delete'.length).trim();
        if (!id) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'Uso: /sessions delete <id>' });
          return;
        }
        try {
          sessionStore().delete(id);
          dispatch({ type: 'SYSTEM_MESSAGE', text: `Sesión "${id}" eliminada.` });
        } catch (err) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: `Error: ${String(err)}` });
        }
        return;
      }

      if (cmd.startsWith('/config get')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const key = cmd.slice('/config get'.length).trim();
        if (!key) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'Uso: /config get <clave.dot.path>' });
          return;
        }
        const value = getByDotPath(agent.getConfig() as unknown as Record<string, unknown>, key);
        dispatch({
          type: 'SYSTEM_MESSAGE',
          text:
            value === undefined
              ? `Clave no encontrada: ${key}`
              : `${key} = ${formatConfigValue(value)}`,
        });
        return;
      }

      if (cmd.startsWith('/config set')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const rest = cmd.slice('/config set'.length).trim();
        const sp = rest.indexOf(' ');
        if (sp < 0) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'Uso: /config set <clave> <valor>' });
          return;
        }
        const key = rest.slice(0, sp);
        const value = rest.slice(sp + 1).trim();
        try {
          const configPath =
            findConfigFile(process.cwd()) ?? join(process.cwd(), '.stratumrc.json');
          const raw: Record<string, unknown> = existsSync(configPath)
            ? (JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>)
            : {};
          setByDotPath(raw, key, value);
          StratumConfigSchema.parse(raw);
          writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `${key} = ${value} guardado en ${configPath}.\nLos cambios de provider/MCP requieren reiniciar o usar /provider, /model o /mcp reload.`,
          });
        } catch (err) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al guardar: ${String(err)}` });
        }
        return;
      }

      // Inspector de subagentes (Hito 8C, §5.7): abre el desplegable de selección.
      // El caso "sin subagentes" lo resuelve el render del picker (línea dim).
      // ----- Perfiles de agente (Hito 15) -----
      if (cmd === '/agents') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        dispatch({
          type: 'SYSTEM_MESSAGE',
          text: formatProfilesReport(agent.listProfiles(), agent.invalidProfiles(), {
            activeName: agent.getActiveProfile()?.name,
            warnings: agent.profileWarnings(),
          }),
        });
        return;
      }

      if (cmd === '/agent' || cmd.startsWith('/agent ')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const target = cmd.slice('/agent'.length).trim();
        if (!target) {
          const active = agent.getActiveProfile()?.name;
          const rows = agent
            .primaryProfiles()
            .map(
              (p) =>
                `  ${p.name === active ? '◆' : '•'} ${p.name} — ${describeProfile(p).replace(/\\\|/g, '|')}`,
            );
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: [
              `Agente principal: ${active ?? 'por defecto'}`,
              '',
              rows.length > 0
                ? 'Perfiles activables:'
                : 'No hay perfiles activables: declara mode: primary o mode: all en su frontmatter.',
              ...rows,
              '',
              'Uso: /agent <perfil> · /agent off',
            ].join('\n'),
          });
          return;
        }
        // Cambiar el prompt y las tools a mitad de un plan dejaría el checklist
        // aprobado en manos de un agente distinto del que lo propuso.
        if (planModeRef.current !== 'normal') {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: 'No se puede cambiar de agente principal con un plan en curso.',
          });
          return;
        }
        const applied = agent.setPrimaryProfile(
          target === 'off' || target === 'default' ? null : target,
        );
        if (!applied.ok) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: `No se pudo activar: ${applied.error}` });
          return;
        }
        setActiveAgent(applied.profile?.name ?? null);
        const head = applied.profile
          ? `Agente principal: ${applied.profile.name}. El historial se conserva; el system prompt y las tools cambian desde el próximo mensaje.`
          : 'De vuelta al agente por defecto.';
        dispatch({ type: 'SYSTEM_MESSAGE', text: [head, ...applied.notes].join('\n') });
        refreshContext();
        return;
      }

      if (cmd === '/subagents') {
        dispatch({ type: 'OPEN_SUBAGENT_PICKER' });
        return;
      }

      if (cmd === '/memory show') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        import('../../memory/show.js')
          .then(({ renderMemoryShow }) => {
            const config = agent.getConfig();
            dispatch({ type: 'SYSTEM_MESSAGE', text: renderMemoryShow(config) });
          })
          .catch((err: unknown) => {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al cargar memoria: ${String(err)}` });
          });
        return;
      }

      if (cmd === '/memory list') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        import('../../memory/decision-memory.js')
          .then(({ getDecisionMemory }) => {
            const decisions = getDecisionMemory(agent.getConfig()).list();
            if (decisions.length === 0) {
              dispatch({ type: 'SYSTEM_MESSAGE', text: 'No hay decisiones almacenadas.' });
              return;
            }
            const lines = [...decisions]
              .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
              .map(
                (d) =>
                  `  ${d.id}  [${d.type}/${d.importance}]  ${d.timestamp.slice(0, 10)}\n    ${d.title}`,
              );
            dispatch({
              type: 'SYSTEM_MESSAGE',
              text: `Decisiones almacenadas (${decisions.length}):\n\n${lines.join('\n')}`,
            });
          })
          .catch((err: unknown) => {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al listar memoria: ${String(err)}` });
          });
        return;
      }

      if (cmd === '/memory search' || cmd.startsWith('/memory search ')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const query = cmd.slice('/memory search'.length).trim();
        if (!query) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'Uso: /memory search <consulta>' });
          return;
        }
        import('../../memory/decision-memory.js')
          .then(async ({ getDecisionMemory }) => {
            const results = await getDecisionMemory(agent.getConfig()).search(query);
            if (results.length === 0) {
              dispatch({ type: 'SYSTEM_MESSAGE', text: 'Sin resultados relevantes.' });
              return;
            }
            const lines = results.map(
              (r) =>
                `  ${r.record.id}  [${r.record.type}/${r.record.importance}]  score ${r.score.toFixed(2)}\n    ${r.record.title}`,
            );
            dispatch({
              type: 'SYSTEM_MESSAGE',
              text: `Decisiones relevantes para "${query}":\n\n${lines.join('\n')}`,
            });
          })
          .catch((err: unknown) => {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error en la búsqueda: ${String(err)}` });
          });
        return;
      }

      if (cmd === '/memory forget' || cmd.startsWith('/memory forget ')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const id = cmd.slice('/memory forget'.length).trim();
        if (!id) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: 'Uso: /memory forget <id>' });
          return;
        }
        import('../../memory/decision-memory.js')
          .then(async ({ getDecisionMemory }) => {
            const removed = await getDecisionMemory(agent.getConfig()).remove(id);
            dispatch({
              type: 'SYSTEM_MESSAGE',
              text: removed ? `Decisión ${id} eliminada.` : `No se encontró la decisión ${id}.`,
            });
          })
          .catch((err: unknown) => {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error al eliminar: ${String(err)}` });
          });
        return;
      }

      if (cmd === '/init' || cmd.startsWith('/init ')) {
        // /init escribe STRATUM.md: con un perfil que no permite write_file,
        // el agente se quedaría explorando sin poder entregar nada.
        const activeProfile = agent.getActiveProfile();
        if (activeProfile?.allowedTools && !activeProfile.allowedTools.includes('write_file')) {
          dispatch({ type: 'INPUT_CHANGE', value: '' });
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `/init necesita write_file y el perfil activo '${activeProfile.name}' no la permite. Usa /agent off antes.`,
          });
          return;
        }
        const focus = cmd.startsWith('/init ') ? cmd.slice('/init '.length).trim() : undefined;
        runInit(focus);
        return;
      }

      if (cmd === '/plan' || cmd.startsWith('/plan ')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const task = cmd.slice('/plan'.length).trim();
        if (!task) {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: 'Uso: /plan <tarea> — planifica (read-only), pide aprobación y ejecuta.',
          });
          return;
        }
        runPlan(task);
        return;
      }

      if (cmd === '/model') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        openModelSelector();
        return;
      }

      if (cmd === '/provider' || cmd.startsWith('/provider ')) {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const target = cmd.slice('/provider'.length).trim();
        const names = agent.providerNames;
        if (!target) {
          // Sin argumento: listar los providers configurados y el activo.
          const lines = names.map((n) =>
            n === agent.providerName ? `  ▶ ${n} (activo)` : `    ${n}`,
          );
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text:
              `Providers configurados:\n\n${lines.join('\n')}\n\n` +
              `Uso: /provider <alias> para cambiar en esta sesión.`,
          });
          return;
        }
        if (target === agent.providerName) {
          dispatch({ type: 'SYSTEM_MESSAGE', text: `"${target}" ya es el provider activo.` });
          return;
        }
        if (!names.includes(target)) {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `Provider "${target}" no existe. Disponibles: ${names.join(', ')}`,
          });
          return;
        }
        try {
          agent.switchProvider(target);
          refreshProviderHealth();
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `Provider activo: ${target} (modelo ${agent.model}, solo esta sesión; no se ha modificado .stratumrc.json).`,
          });
        } catch (err) {
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `Error al cambiar de provider: ${String(err)}`,
          });
        }
        return;
      }

      if (cmd === '/config_provider') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        openProviderEditor();
        return;
      }

      if (cmd === '/tools') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        // Obtener todas las tools registradas en el agente via el registry del agent
        // Las tools MCP tienen nombre mcp__server__tool; las built-in no.
        import('../../tools/registry.js')
          .then(() => {
            // El registry no es accesible directamente desde App; construimos el
            // listado a partir del catálogo de tools disponibles en el agent.
            // Como el agent no expone el registry, usamos el mcpManager y la
            // lista de tools built-in conocidas.
            const builtins = [
              'read_file',
              'write_file',
              'edit_file',
              'glob',
              'list_directory',
              'grep',
              'exec',
              'web_search',
              'web_fetch',
              'store_decision',
              'recall_decisions',
            ];
            const lines: string[] = ['Tools disponibles:\n'];

            lines.push('  Built-in:');
            for (const t of builtins) lines.push(`    • ${t}`);

            if (mcpManager) {
              const clients = mcpManager.getClients();
              if (clients.length > 0) {
                lines.push('\n  MCP:');
                for (const client of clients) {
                  const icon = client.status === 'connected' ? '●' : '○';
                  lines.push(`    ${icon} ${client.name} [${client.status}]`);
                  for (const t of client.tools) {
                    const parsed = parseMcpToolName(`mcp__${client.name}__${t.name}`);
                    const display = parsed ? `${parsed.server}/${parsed.tool}` : t.name;
                    lines.push(`        • ${display}`);
                  }
                }
              }
            }

            dispatch({ type: 'SYSTEM_MESSAGE', text: lines.join('\n') });
          })
          .catch((err: unknown) => {
            dispatch({ type: 'SYSTEM_MESSAGE', text: `Error: ${String(err)}` });
          });
        return;
      }

      void send(cmd);
    },
    [
      send,
      exit,
      runInit,
      runPlan,
      agent,
      openModelSelector,
      openProviderEditor,
      refreshProviderHealth,
      mcpManager,
      registry,
      refreshContext,
      sessionStore,
      state.debug,
    ],
  );

  // Ctrl+L necesita alcanzar `executeCommand` desde el useInput, que se declara antes.
  executeCommandRef.current = executeCommand;

  // Panel de arranque MCP (§14): solo con `mcp.startup: 'eager'`. Los timeouts
  // se leen de la config para poder distinguir un timeout de un fallo de arranque.
  const [mcpStartup] = useState(() => {
    if (!mcpEager || !mcpManager) return undefined;
    const timeouts: Record<string, number> = {};
    for (const s of agent.getConfig().mcp.servers) timeouts[s.name] = s.startupTimeout;
    return { manager: mcpManager, timeouts };
  });

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      const cmd = text.trim();

      // Historial de inputs (§10): se registra todo lo enviado, comandos incluidos.
      historyRef.current = pushHistory(historyRef.current, cmd);
      setHistoryIndex(null);
      draftRef.current = '';

      // Vista de Subagente (Hito 8C, §5.7): la línea de entrada es read-only; el
      // único comando aceptado es /quit (Esc es alias, gestionado en useInput).
      // Cualquier otra cosa se rechaza con un hint inline sin salir de la vista.
      if (state.focusState === 'subagent-view') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        if (cmd === '/quit' || cmd === '/exit') {
          setSubagentViewHint(null);
          dispatch({ type: 'EXIT_SUBAGENT_VIEW' });
        } else {
          setSubagentViewHint(
            '⚠ Aquí solo está disponible /quit (vuelve al agente principal). Esc también cierra.',
          );
        }
        return;
      }

      if (state.thinking) return;

      // Enter con la paleta abierta: ejecutar (o completar) el comando seleccionado
      if (paletteItems.length > 0) {
        const sel = paletteItems[effPaletteIndex];
        if (sel && sel.name !== cmd) {
          if (sel.hasArgs) {
            completePaletteSelection(sel.name, true);
            return;
          }
          executeCommand(sel.name);
          return;
        }
      }

      executeCommand(cmd);
    },
    [
      state.thinking,
      state.focusState,
      paletteItems,
      effPaletteIndex,
      completePaletteSelection,
      executeCommand,
    ],
  );

  if (state.phase === 'banner') {
    return (
      <Box>
        <Banner
          version={version}
          onSend={handleSend}
          logoPreRendered={logoPreRendered}
          mcpStartup={mcpStartup}
        />
      </Box>
    );
  }

  // ----- Vista de Subagente read-only (Hito 8C, §5.7) -----
  // Sustituye toda el área de conversación mientras está activa. El input solo
  // acepta /quit (Esc como alias); la lógica está en handleSend/useInput.
  if (state.focusState === 'subagent-view') {
    const transcript = state.viewingSubagentId
      ? state.subagentTranscripts.get(state.viewingSubagentId)
      : undefined;
    return (
      <Box flexDirection="column" width="100%">
        {transcript ? (
          <SubagentView transcript={transcript} expandedBlockIds={state.expandedBlockIds} />
        ) : (
          <Box paddingX={1}>
            <Text color={theme.textMuted}>Subagente no encontrado.</Text>
          </Box>
        )}
        {subagentViewHint && (
          <Box paddingX={1}>
            <Text color={theme.warning}>{subagentViewHint}</Text>
          </Box>
        )}
        <Box paddingX={1}>
          <Text color={theme.accent}>❯❯ </Text>
          <TextInput
            value={state.inputValue}
            onChange={handleInputChange}
            onSubmit={handleSend}
            placeholder="/quit para volver al agente principal"
            showCursor
          />
        </Box>
      </Box>
    );
  }

  const activeBlocks = getActiveBlocks(state);
  const focusedBlockId =
    state.focusState === 'block-focus' ? (activeBlocks[state.focusedBlockIndex]?.id ?? null) : null;

  // ----- Overlays de sesión (Hito 3.5) -----
  let overlayNode: React.ReactNode = null;
  if (overlay?.kind === 'model-loading') {
    overlayNode = (
      <Box borderStyle="single" borderColor={theme.borderSubtle} paddingX={1}>
        <Text color={theme.textMuted}>◌ Obteniendo modelos del provider activo...</Text>
      </Box>
    );
  } else if (overlay?.kind === 'model-select') {
    const current = agent.model;
    overlayNode = (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.borderAccent}
        paddingX={1}
      >
        <Text color={theme.accent} bold>
          Modelo
          <Text color={theme.textMuted} bold={false}>
            {'  ·  '}
            {agent.providerName} · solo esta sesión
          </Text>
        </Text>
        <Text> </Text>
        <SelectList
          items={[
            ...overlay.models.map((m) => ({
              label: m,
              value: m,
              hint: m === current ? '(actual)' : undefined,
            })),
            { label: '✎ Escribir modelo manualmente…', value: '\u0000manual' },
          ]}
          initialIndex={Math.max(overlay.models.indexOf(current), 0)}
          onSelect={(item) => {
            if (item.value === '\u0000manual') {
              setModelManualValue(current);
              setOverlay({ kind: 'model-manual' });
              return;
            }
            applyModel(item.value);
          }}
          onCancel={() => setOverlay(null)}
        />
        <Text color={theme.textDisabled}> Esc para cancelar</Text>
      </Box>
    );
  } else if (overlay?.kind === 'model-manual') {
    overlayNode = (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.borderAccent}
        paddingX={1}
      >
        <Text color={theme.accent} bold>
          Modelo (manual)
          <Text color={theme.textMuted} bold={false}>
            {'  ·  '}
            {agent.providerName} · solo esta sesión
          </Text>
        </Text>
        {overlay.note && <Text color={theme.warning}> ⚠ {overlay.note}</Text>}
        <Box>
          <Text color={theme.accent}>❯ </Text>
          <TextInput
            value={modelManualValue}
            onChange={setModelManualValue}
            onSubmit={(v) => applyModel(v)}
            placeholder="nombre exacto del modelo"
            showCursor
          />
        </Box>
        <Text color={theme.textDisabled}> Enter para aplicar · Esc para cancelar</Text>
      </Box>
    );
  } else if (overlay?.kind === 'wizard') {
    overlayNode = (
      <ProviderWizard
        mode="edit"
        existingNames={[]}
        initial={overlay.initial}
        onComplete={handleWizardComplete}
        onCancel={() => setOverlay(null)}
      />
    );
  }

  // ----- Desplegable de selección de subagente (Hito 8C, §5.7) -----
  if (state.subagentPicker) {
    const list = [...state.subagentTranscripts.values()].reverse(); // más reciente primero
    const icon = (s: SubagentTranscript['status']): string =>
      s === 'completed'
        ? '✓'
        : s === 'failed'
          ? '✗'
          : s === 'running'
            ? '⊳'
            : s === 'budget_exceeded'
              ? '⏱'
              : s === 'cancelled'
                ? '⊘'
                : s === 'interrupted'
                  ? '⚠'
                  : '⋯';
    overlayNode = (
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.borderAccent}
        paddingX={1}
      >
        <Text color={theme.accent} bold>
          Subagentes de la sesión
        </Text>
        <Text> </Text>
        {list.length === 0 ? (
          <>
            <Text color={theme.textDisabled} dimColor>
              — ningún subagente en esta sesión —
            </Text>
            <Text color={theme.textDisabled}> Esc para cerrar</Text>
          </>
        ) : (
          <>
            <SelectList
              items={list.map((t) => ({
                label: `${icon(t.status)} ⊳ ${t.profile}#${t.n}`,
                value: t.id,
                hint:
                  `${t.status}` +
                  (t.iterations !== undefined ? ` · ${t.iterations} it` : '') +
                  (t.durationMs !== undefined ? ` · ${(t.durationMs / 1000).toFixed(1)}s` : ''),
              }))}
              onSelect={(item) => dispatch({ type: 'ENTER_SUBAGENT_VIEW', id: item.value })}
              onCancel={() => dispatch({ type: 'CLOSE_SUBAGENT_PICKER' })}
            />
            <Text color={theme.textDisabled}> ↑↓ seleccionar · Enter abrir · Esc cerrar</Text>
          </>
        )}
      </Box>
    );
  }

  const paletteNode =
    paletteItems.length > 0 ? (
      <CommandPalette items={paletteItems} selectedIndex={effPaletteIndex} />
    ) : null;

  return (
    <Box flexDirection="column" width="100%">
      <ConversationView
        completedItems={state.completedItems}
        currentItem={state.currentItem}
        inputValue={state.inputValue}
        onInputChange={handleInputChange}
        onInputSubmit={handleSend}
        thinking={state.thinking}
        providerName={agent.providerName}
        model={agent.model}
        contextUsed={state.contextUsed}
        contextMax={state.contextMax}
        contextEstimated={state.contextEstimated}
        focusedBlockId={focusedBlockId}
        expandedBlockIds={state.expandedBlockIds}
        fatalError={state.fatalError}
        debug={state.debug}
        pendingConfirm={state.pendingConfirm}
        onConfirmApprove={() => resolveConfirm('approve')}
        onConfirmDeny={() => resolveConfirm('deny')}
        onConfirmAllowAll={() => resolveConfirm('allow-all')}
        palette={paletteNode}
        overlay={overlayNode}
        mcpStatus={mcpStatus}
        providerStatus={providerStatus}
        changes={formatCompact(state.changes)}
        tokens={state.tokens}
        activeAgent={activeAgent}
        todos={state.todoCollapsed ? [] : state.todos}
        todoStale={state.todoStale}
        planMode={state.planMode}
        plan={state.plan}
        pendingApproval={state.pendingApproval}
        onPlanApprove={resolvePlanApprove}
        onPlanReject={resolvePlanReject}
        pendingQuestions={state.pendingQuestions}
        onQuestionsSubmit={(answers) => resolveQuestions(answers)}
        onQuestionsCancel={() => resolveQuestions(null)}
      />
    </Box>
  );
}
