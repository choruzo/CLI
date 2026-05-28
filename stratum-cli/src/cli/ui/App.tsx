import React, { useReducer, useCallback, useRef } from 'react';
import { Box, useApp, useInput } from 'ink';
import type { StratumAgent } from '../../agent/core.js';
import type { AgentEvent } from '../../agent/types.js';
import type { ToolCallState } from './ToolCallBlock.js';
import { Banner } from './Banner.js';
import { ConversationView } from './ConversationView.js';
import { useAgentStream } from './useAgentStream.js';

export type AgentConvItem = {
  kind: 'agent';
  text: string;
  toolCalls: ToolCallState[];
  streaming: boolean;
};

export type ConvItem =
  | { kind: 'user'; text: string }
  | AgentConvItem;

interface AppState {
  phase: 'banner' | 'conversation';
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  inputValue: string;
  thinking: boolean;
  contextUsed: number;
  contextMax: number;
}

export type AppAction =
  | { type: 'AGENT_START'; input: string }
  | { type: 'AGENT_EVENT'; event: AgentEvent }
  | { type: 'CONTEXT_UPDATE'; used: number; max: number }
  | { type: 'INPUT_CHANGE'; value: string };

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
  return toolCalls.map(tc => (tc.id === id ? updater(tc) : tc));
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'AGENT_START': {
      const userItem: ConvItem = { kind: 'user', text: action.input };
      const agentItem: AgentConvItem = {
        kind: 'agent',
        text: '',
        toolCalls: [],
        streaming: true,
      };
      return {
        ...state,
        phase: 'conversation',
        completedItems: [...state.completedItems, userItem],
        currentItem: agentItem,
        inputValue: '',
        thinking: true,
      };
    }

    case 'AGENT_EVENT': {
      const ev = action.event;

      if (ev.type === 'text_delta') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, item => ({
            ...item,
            text: item.text + ev.delta,
          })),
        };
      }

      if (ev.type === 'tool_call_start') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, item => {
            const exists = item.toolCalls.find(tc => tc.id === ev.id);
            if (exists) {
              return {
                ...item,
                toolCalls: updateToolCall(item.toolCalls, ev.id, tc => ({
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
          currentItem: updateCurrentAgent(state.currentItem, item => ({
            ...item,
            toolCalls: updateToolCall(item.toolCalls, ev.id, tc => ({
              ...tc,
              input: ev.input,
            })),
          })),
        };
      }

      if (ev.type === 'tool_result') {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, item => ({
            ...item,
            toolCalls: updateToolCall(item.toolCalls, ev.id, tc => ({
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
          currentItem: updateCurrentAgent(state.currentItem, item => ({
            ...item,
            toolCalls: updateToolCall(item.toolCalls, ev.id, tc => ({
              ...tc,
              status: 'error' as const,
              errorMsg: ev.error,
            })),
          })),
        };
      }

      if (ev.type === 'done') {
        const rawCurrent = state.currentItem;
        const finalItem: ConvItem | null = rawCurrent && rawCurrent.kind === 'agent'
          ? { ...rawCurrent, streaming: false }
          : rawCurrent;
        return {
          ...state,
          completedItems: finalItem
            ? [...state.completedItems, finalItem]
            : state.completedItems,
          currentItem: null,
          thinking: false,
        };
      }

      if (ev.type === 'error' && ev.fatal) {
        return {
          ...state,
          currentItem: updateCurrentAgent(state.currentItem, item => ({
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
      return { ...state, contextUsed: action.used, contextMax: action.max };

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

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || state.thinking) return;
    if (text.trim() === '/quit' || text.trim() === '/exit') {
      exit();
      return;
    }
    void send(text.trim());
  }, [send, state.thinking, exit]);

  if (state.phase === 'banner') {
    return (
      <Box>
        <Banner version={version} onSend={text => void send(text)} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%">
      <ConversationView
        completedItems={state.completedItems}
        currentItem={state.currentItem}
        inputValue={state.inputValue}
        onInputChange={value => dispatch({ type: 'INPUT_CHANGE', value })}
        onInputSubmit={handleSend}
        thinking={state.thinking}
        providerName={agent.providerName}
        model={agent.model}
        contextUsed={state.contextUsed}
        contextMax={state.contextMax}
      />
    </Box>
  );
}
