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

export type ConvItem = { kind: 'user'; text: string } | AgentConvItem;

interface AppState {
  phase: 'banner' | 'conversation';
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  inputValue: string;
  /** true cuando el agente o el init están procesando (deshabilita input normal) */
  thinking: boolean;
  contextUsed: number;
  contextMax: number;
  contextEstimated: boolean;
  /**
   * Cuando /init está esperando que el usuario responda un merge_conflict,
   * guarda el nombre de la sección. El input se usa para la respuesta s/N.
   */
  mergeConflictSection: string | null;
}

export type AppAction =
  | { type: 'AGENT_START'; input: string }
  | { type: 'AGENT_EVENT'; event: AgentEvent }
  | { type: 'CONTEXT_UPDATE'; used: number; max: number; estimated: boolean }
  | { type: 'INPUT_CHANGE'; value: string }
  | { type: 'SYSTEM_MESSAGE'; text: string }
  | { type: 'INIT_START' }
  | { type: 'INIT_PROGRESS'; text: string }
  | { type: 'INIT_CONFLICT'; section: string }
  | { type: 'INIT_CONFLICT_DONE' }
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
        text: '⟳ Escaneando proyecto...',
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
        mergeConflictSection: null,
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

    case 'INIT_CONFLICT': {
      // Mostrar la pregunta, desbloquear el input para recibir s/N
      return {
        ...state,
        currentItem: updateCurrentAgent(state.currentItem, (item) => ({
          ...item,
          text:
            item.text +
            `\n\n⚠  La sección "## ${action.section}" tiene contenido manual.\n   ¿Actualizar con la información del scan? (s/N)`,
        })),
        thinking: false, // desbloquear input
        mergeConflictSection: action.section,
      };
    }

    case 'INIT_CONFLICT_DONE': {
      return {
        ...state,
        thinking: true, // volver a bloquear mientras continúa
        mergeConflictSection: null,
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
        mergeConflictSection: null,
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
    mergeConflictSection: null,
  });

  const { send, cancel } = useAgentStream(agent, dispatch);

  // Ref para resolver conflictos de merge desde el input del usuario
  const mergeResolverRef = useRef<((update: boolean) => void) | null>(null);

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

  /** Lanza /init conduciendo InitAgent en el área de conversación. */
  const runInit = useCallback(() => {
    dispatch({ type: 'INIT_START' });

    (async () => {
      try {
        const [{ InitAgent }, { loadConfig }] = await Promise.all([
          import('../../agent/init-agent.js'),
          import('../../config/loader.js'),
        ]);

        const config = loadConfig();
        const provider = agent.getProvider();
        const model = agent.model;
        const initAgent = new InitAgent(provider, model);

        let scannedCount = 0;
        let detectedStack = '';

        const resolveConflict = (
          section: string,
          _existing: string,
          _proposed: string,
        ): Promise<boolean> => {
          return new Promise((resolve) => {
            dispatch({ type: 'INIT_CONFLICT', section });
            mergeResolverRef.current = resolve;
          });
        };

        for await (const ev of initAgent.run(process.cwd(), { resolveConflict })) {
          if (ev.type === 'scan_progress') {
            scannedCount++;
            dispatch({
              type: 'INIT_PROGRESS',
              text: `⟳ Escaneando proyecto... (${scannedCount} archivos)`,
            });
          } else if (ev.type === 'section_ready') {
            if (ev.section === 'Stack Tecnológico') detectedStack = ev.content.split('\n')[0] ?? '';
            dispatch({
              type: 'INIT_PROGRESS',
              text: `⟳ Generando secciones... (${ev.section} listo)${detectedStack ? '\n   Stack: ' + detectedStack : ''}`,
            });
          } else if (ev.type === 'merge_conflict') {
            // El reducer INIT_CONFLICT ya actualiza el texto y desbloquea el input
          } else if (ev.type === 'merge_conflict_resolved') {
            dispatch({ type: 'INIT_CONFLICT_DONE' });
          } else if (ev.type === 'done') {
            const verb = ev.isNew ? 'creado' : 'actualizado';
            dispatch({
              type: 'INIT_PROGRESS',
              text: `✓ STRATUM.md ${verb} en ${ev.path}\n\nEl contexto del proyecto se cargará en el próximo mensaje.`,
            });
            agent.reloadMemory();
          } else if (ev.type === 'error') {
            dispatch({ type: 'INIT_PROGRESS', text: `✗ Error: ${ev.message}` });
          }
        }
      } catch (err) {
        dispatch({ type: 'INIT_PROGRESS', text: `✗ Error inesperado: ${String(err)}` });
      } finally {
        dispatch({ type: 'INIT_DONE' });
      }
    })();
  }, [agent]);

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      // Si hay un conflicto de merge pendiente, redirigir la respuesta al resolver
      if (state.mergeConflictSection !== null && mergeResolverRef.current) {
        const update = text.trim().toLowerCase() === 's';
        mergeResolverRef.current(update);
        mergeResolverRef.current = null;
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        // INIT_CONFLICT_DONE se disparará desde el generador al recibir merge_conflict_resolved
        return;
      }

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

      if (cmd === '/init') {
        runInit();
        return;
      }

      void send(cmd);
    },
    [send, state.thinking, state.mergeConflictSection, exit, runInit, agent],
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
        thinking={state.thinking && state.mergeConflictSection === null}
        providerName={agent.providerName}
        model={agent.model}
        contextUsed={state.contextUsed}
        contextMax={state.contextMax}
        contextEstimated={state.contextEstimated}
      />
    </Box>
  );
}
