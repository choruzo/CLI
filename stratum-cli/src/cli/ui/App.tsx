import React, { useReducer, useCallback, useRef, useState, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { StratumAgent } from '../../agent/core.js';
import type {
  AgentEvent,
  ConfirmRequest,
  DestructiveDecision,
  RunOptions,
} from '../../agent/types.js';
import type { ProviderConfig } from '../../config/schema.js';
import { expandEnvVars } from '../../config/loader.js';
import { upsertProvider, readRawProvider } from '../../config/writer.js';
import { fetchModels } from '../../providers/utils.js';
import type { McpManager, McpStatusSummary } from '../../tools/mcp/manager.js';
import { parseMcpToolName } from '../../tools/mcp/bridge.js';
import type { ToolCallState } from './ToolCallBlock.js';
import { Banner } from './Banner.js';
import { ConversationView } from './ConversationView.js';
import { CommandPalette } from './CommandPalette.js';
import { ProviderWizard } from './ProviderWizard.js';
import { SelectList } from './components/SelectList.js';
import { SESSION_COMMANDS, filterCommands } from './session-commands.js';
import { theme } from './theme.js';
import { useAgentStream } from './useAgentStream.js';
import { INITIALIZE_PROMPT } from '../../agent/initialize-prompt.js';

/** Overlays interactivos de sesión (Hito 3.5): /model y /config_provider. */
type OverlayState =
  | { kind: 'model-loading' }
  | { kind: 'model-select'; models: string[] }
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
  /** Máquina de foco (§10): input ↔ block-focus. */
  focusState: 'input' | 'block-focus';
  focusedBlockIndex: number;
  /** ids de tool call blocks con output expandido (Space). */
  expandedBlockIds: ReadonlySet<string>;
  /** Confirmación destructiva pendiente (UI §12). */
  pendingConfirm: PendingConfirm | null;
}

export type AppAction =
  | { type: 'AGENT_START'; input: string }
  | { type: 'AGENT_EVENT'; event: AgentEvent }
  | { type: 'CONTEXT_UPDATE'; used: number; max: number; estimated: boolean }
  | { type: 'INPUT_CHANGE'; value: string }
  | { type: 'SYSTEM_MESSAGE'; text: string }
  | { type: 'INIT_START' }
  | { type: 'INIT_PROGRESS'; text: string }
  | { type: 'INIT_DONE' }
  | { type: 'CONFIRM_SHOW'; request: PendingConfirm }
  | { type: 'CONFIRM_RESOLVE' }
  | { type: 'FOCUS_BLOCKS' }
  | { type: 'FOCUS_MOVE'; delta: number }
  | { type: 'FOCUS_EXIT' }
  | { type: 'TOGGLE_EXPAND' };

/**
 * Bloques navegables con Tab: los del turno en curso, o los del último turno
 * completado (que MessageList mantiene fuera de <Static> precisamente para esto).
 */
function getActiveBlocks(state: AppState): ToolCallState[] {
  if (state.currentItem?.kind === 'agent' && state.currentItem.toolCalls.length > 0) {
    return state.currentItem.toolCalls;
  }
  const last = state.completedItems[state.completedItems.length - 1];
  if (last?.kind === 'agent') return last.toolCalls;
  return [];
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

    case 'CONFIRM_SHOW':
      return { ...state, pendingConfirm: action.request };

    case 'CONFIRM_RESOLVE':
      return { ...state, pendingConfirm: null };

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
          pendingConfirm: null,
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
  mcpManager?: McpManager;
}

export function App({ agent, version, mcpManager }: Props) {
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
    focusState: 'input',
    focusedBlockIndex: 0,
    expandedBlockIds: new Set<string>(),
    pendingConfirm: null,
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

  const getRunOptions = useCallback(
    (): Partial<RunOptions> => ({
      destructivePolicy: allowAllRef.current ? 'allow' : 'ask',
      onConfirmDestructive,
    }),
    [onConfirmDestructive],
  );

  const { send, cancel } = useAgentStream(agent, dispatch, getRunOptions);

  // -------------------------------------------------------------------------
  // Overlays de sesión (Hito 3.5): /model y /config_provider
  // -------------------------------------------------------------------------
  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  // -------------------------------------------------------------------------
  // Paleta de /comandos (UI §5.2)
  // -------------------------------------------------------------------------
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);

  const paletteEligible =
    !state.thinking &&
    !state.pendingConfirm &&
    !overlay &&
    state.focusState === 'input' &&
    !paletteDismissed &&
    state.inputValue.trimStart().startsWith('/');
  const paletteItems = paletteEligible ? filterCommands(state.inputValue, SESSION_COMMANDS) : [];
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

    // Los overlays gestionan su propio input (SelectList / wizard)
    if (overlay) return;

    // El prompt de confirmación gestiona su propio input (S/N/!)
    if (state.pendingConfirm) return;

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

    // ----- Máquina de foco (§10): input ↔ block-focus -----
    if (key.tab) {
      if (state.focusState === 'block-focus') {
        dispatch({ type: 'FOCUS_MOVE', delta: key.shift ? -1 : 1 });
      } else if (!state.inputValue.startsWith('/')) {
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
            for await (const event of agent.run(input, { compressionMode: 'conservative' })) {
              if (event.type === 'text_delta') {
                agentText += event.delta;
              } else if (
                event.type === 'tool_call_start' &&
                currentTool !== event.name + event.id
              ) {
                currentTool = event.name + event.id;
                toolCount++;
                dispatch({
                  type: 'INIT_PROGRESS',
                  text: `[${toolCount}] ${event.name}...`,
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
                  type: 'INIT_PROGRESS',
                  text: `[${toolCount}] ${event.name} OK`,
                });
                currentTool = '';
              } else if (event.type === 'error' && event.fatal) {
                dispatch({ type: 'INIT_PROGRESS', text: `Error: ${event.message}` });
              }
            }
          };

          await consume(prompt);

          // Mitigación para modelos pequeños: si el run terminó sin escribir el
          // fichero, reinyectar una instrucción directa una única vez.
          if (!wroteStratum) {
            dispatch({
              type: 'INIT_PROGRESS',
              text: 'El agente no escribió STRATUM.md — reintentando con instrucción directa...',
            });
            await consume(
              `You have not written the file yet. Based on your investigation so far, call the write_file tool NOW with the complete contents of STRATUM.md at path ${cwd}/STRATUM.md. Do not reply with text only — make the tool call.`,
            );
          }

          if (wroteStratum) {
            agent.reloadMemory();
            dispatch({ type: 'INIT_PROGRESS', text: 'STRATUM.md generado. Contexto recargado.' });
          } else {
            const detail = agentText.trim()
              ? ` Respuesta del agente: ${agentText.trim().slice(0, 500)}`
              : '';
            dispatch({
              type: 'INIT_PROGRESS',
              text: `El agente terminó sin escribir STRATUM.md.${detail}`,
            });
          }
        } catch (err) {
          dispatch({ type: 'INIT_PROGRESS', text: `Error: ${String(err)}` });
        } finally {
          dispatch({ type: 'INIT_DONE' });
        }
      })();
    },
    [agent],
  );

  // -------------------------------------------------------------------------
  // /model — selector de modelo en sesión (Hito 3.5)
  // -------------------------------------------------------------------------
  const openModelSelector = useCallback(() => {
    setOverlay({ kind: 'model-loading' });
    const cfg = agent.getActiveProviderConfig();
    fetchModels(cfg.baseUrl, cfg.apiKey)
      .then((models) => {
        if (models.length === 0) {
          setOverlay(null);
          dispatch({
            type: 'SYSTEM_MESSAGE',
            text: `El endpoint ${cfg.baseUrl}/models no devolvió modelos.`,
          });
          return;
        }
        setOverlay({ kind: 'model-select', models });
      })
      .catch((err: unknown) => {
        setOverlay(null);
        dispatch({
          type: 'SYSTEM_MESSAGE',
          text:
            `No se pudieron obtener los modelos de ${cfg.baseUrl}: ${String(err)}\n` +
            `Puedes fijar el modelo a mano con: stratum config set provider.providers.${agent.providerName}.model <modelo>`,
        });
      });
  }, [agent]);

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

      if (cmd === '/help') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        const width = Math.max(...SESSION_COMMANDS.map((c) => c.name.length)) + 2;
        const lines = SESSION_COMMANDS.map((c) => `  ${c.name.padEnd(width)} ${c.description}`);
        dispatch({ type: 'SYSTEM_MESSAGE', text: `Comandos disponibles:\n\n${lines.join('\n')}` });
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

      if (cmd === '/model') {
        dispatch({ type: 'INPUT_CHANGE', value: '' });
        openModelSelector();
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
              'bash',
              'web_search',
              'web_fetch',
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
    [send, exit, runInit, agent, openModelSelector, openProviderEditor, mcpManager],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      if (state.thinking) return;

      const cmd = text.trim();

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
    [state.thinking, paletteItems, effPaletteIndex, completePaletteSelection, executeCommand],
  );

  if (state.phase === 'banner') {
    return (
      <Box>
        <Banner version={version} onSend={handleSend} />
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
          items={overlay.models.map((m) => ({
            label: m,
            value: m,
            hint: m === current ? '(actual)' : undefined,
          }))}
          initialIndex={Math.max(overlay.models.indexOf(current), 0)}
          onSelect={(item) => {
            setOverlay(null);
            if (item.value !== current) {
              agent.switchModel(item.value);
              dispatch({
                type: 'SYSTEM_MESSAGE',
                text: `Modelo cambiado a ${item.value} (solo esta sesión; no se ha modificado .stratumrc.json).`,
              });
            }
          }}
          onCancel={() => setOverlay(null)}
        />
        <Text color={theme.textDisabled}> Esc para cancelar</Text>
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
        pendingConfirm={state.pendingConfirm}
        onConfirmApprove={() => resolveConfirm('approve')}
        onConfirmDeny={() => resolveConfirm('deny')}
        onConfirmAllowAll={() => resolveConfirm('allow-all')}
        palette={paletteNode}
        overlay={overlayNode}
        mcpStatus={mcpStatus}
      />
    </Box>
  );
}
