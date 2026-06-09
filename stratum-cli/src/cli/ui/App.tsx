import React, { useReducer, useCallback, useRef } from 'react';
import { Box, useApp, useInput } from 'ink';
import type { StratumAgent } from '../../agent/core.js';
import type { AgentEvent } from '../../agent/types.js';
import type { ToolCallState } from './ToolCallBlock.js';
import { Banner } from './Banner.js';
import { ConversationView } from './ConversationView.js';
import { useAgentStream } from './useAgentStream.js';
import { INITIALIZE_PROMPT } from '../../agent/initialize-prompt.js';

export type AgentConvItem = {
  kind: 'agent';
  text: string;
  toolCalls: ToolCallState[];
  streaming: boolean;
};

export type ConvItem = { kind: 'user'; text: string } | AgentConvItem;

interface AppState {
  phase: 'banner' | 'conversation';
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  inputValue: string;
  thinking: boolean;
  contextUsed: number;
  contextMax: number;
  contextEstimated: boolean;
}

export type AppAction =
  | { type: 'AGENT_START'; input: string }
  | { type: 'AGENT_EVENT'; event: AgentEvent }
  | { type: 'CONTEXT_UPDATE'; used: number; max: number; estimated: boolean }
  | { type: 'INPUT_CHANGE'; value: string }
  | { type: 'SYSTEM_MESSAGE'; text: string }
  | { type: 'INIT_START' }
  | { type: 'INIT_PROGRESS'; text: string }
  | { type: 'INIT_DONE' };

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
        text: 'Explorando proyecto...',
        toolCalls: [],
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

    case 'INIT_PROGRESS': {
      return {
        ...state,
        currentItem: updateCurrentAgent(state.currentItem, (item) => ({
          ...item,
          text: action.text,
        })),
      };
    }

    case 'INIT_DONE': {
      const finalItem =
        state.currentItem && state.currentItem.kind === 'agent'
          ? { ...state.currentItem, streaming: false }
          : state.currentItem;
      return {
        ...state,
        completedItems: finalItem ? [...state.completedItems, finalItem] : state.completedItems,
        currentItem: null,
        thinking: false,
      };
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
                  status: 'running' as const,
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
            toolCalls: updateToolCall(item.toolCalls, ev.id, (tc) => ({ ...tc, input: ev.input })),
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

      if (ev.type === 'done') {
        const rawCurrent = state.currentItem;
        const finalItem =
          rawCurrent && rawCurrent.kind === 'agent'
            ? { ...rawCurrent, streaming: false }
            : rawCurrent;
        return {
          ...state,
          completedItems: finalItem ? [...state.completedItems, finalItem] : state.completedItems,
          currentItem: null,
          thinking: false,
        };
      }

      if (ev.type === 'error' && ev.fatal) {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, (item) => ({
            ...item,
            text: item.text + (item.text ? '\n' : '') + `[Error: ${ev.message}]`,
            streaming: false,
          })),
          thinking: false,
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
      };

    case 'INPUT_CHANGE':
      return { ...state, inputValue: action.value };

    default:
      return state;
  }
}

interface Props {
  agent: StratumAgent;
  version: string;
}

export function App({ agent, version }: Props) {
  const { exit } = useApp();

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
  });

  const { send, cancel } = useAgentStream(agent, dispatch);

  const ctrlCCountRef = useRef(0);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useInput((_, key) => {
    if (key.ctrl && key.name === 'c') {
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
    }
  });

  /**
   * Lanza /init usando el agente regular para explorar el repo libremente.
   * El agente usa read_file, write_file y bash para explorar y escribir
   * STRATUM.md, igual que opencode.
   *
   * Las actualizaciones de UI se limitan a tool_call_start y tool_result
   * para evitar el parpadeo de Ink causado por los text_delta a alta frecuencia.
   */
  const runInit = useCallback(
    (focus?: string) => {
      dispatch({ type: 'INIT_START' });

      const cwd = process.cwd();
      const prompt = INITIALIZE_PROMPT
        .replace('${path}', cwd)
        .replace('$ARGUMENTS', focus?.trim() || '(none)');

      void (async () => {
        try {
          let currentTool = '';
          let toolCount = 0;

          for await (const event of agent.run(prompt)) {
            if (event.type === 'tool_call_start' && currentTool !== event.name + event.id) {
              currentTool = event.name + event.id;
              toolCount++;
              dispatch({
                type: 'INIT_PROGRESS',
                text: `[${toolCount}] ${event.name}...`,
              });
            } else if (event.type === 'tool_result') {
              dispatch({
                type: 'INIT_PROGRESS',
                text: `[${toolCount}] ${event.name} OK`,
              });
              currentTool = '';
            } else if (event.type === 'error' && event.fatal) {
              dispatch({ type: 'INIT_PROGRESS', text: `Error: ${event.message}` });
            }
          }

          agent.reloadMemory();
          dispatch({ type: 'INIT_PROGRESS', text: 'STRATUM.md generado. Contexto recargado.' });
        } catch (err) {
          dispatch({ type: 'INIT_PROGRESS', text: `Error: ${String(err)}` });
        } finally {
          dispatch({ type: 'INIT_DONE' });
        }
      })();
    },
    [agent],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (state.thinking) return;

      const cmd = text.trim();

      if (cmd === '/quit' || cmd === '/exit') {
        exit();
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

      if (cmd === '/init' || cmd.startsWith('/init ')) {
        const focus = cmd.startsWith('/init ') ? cmd.slice('/init '.length).trim() : undefined;
        runInit(focus);
        return;
      }

      void send(cmd);
    },
    [send, state.thinking, exit, runInit, agent],
  );

  if (state.phase === 'banner') {
    return (
      <Box>
        <Banner version={version} onSend={handleSend} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <ConversationView
        completedItems={state.completedItems}
        currentItem={state.currentItem}
        inputValue={state.inputValue}
        onInputChange={(value) => dispatch({ type: 'INPUT_CHANGE', value })}
        onInputSubmit={handleSend}
        thinking={state.thinking}
        providerName={agent.providerName}
        model={agent.model}
        contextUsed={state.contextUsed}
        contextMax={state.contextMax}
        contextEstimated={state.contextEstimated}
      />
    </Box>
  );
}
