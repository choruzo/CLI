import React from 'react';
import { Box, useStdout } from 'ink';
import { StatusBar } from './StatusBar.js';
import type { EnvironmentBadge, ProviderStatus } from './StatusBar.js';
import { MessageList } from './MessageList.js';
import { InputArea } from './InputArea.js';
import { DestructiveConfirm } from './DestructiveConfirm.js';
import { PlanView } from './PlanView.js';
import { TodoView } from './TodoView.js';
import { PlanApproval } from './PlanApproval.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { FatalError } from './FatalError.js';
import type { ConvItem, PendingConfirm } from './App.js';
import type { McpStatusSummary } from '../../tools/mcp/manager.js';
import type {
  AgentMode,
  Plan,
  QuestionAnswer,
  QuestionItem,
  TokenAccounting,
} from '../../agent/types.js';
import type { TodoItem } from '../../agent/todo.js';
import { useLiveClock } from './spinner.js';

interface Props {
  completedItems: ConvItem[];
  currentItem: ConvItem | null;
  inputValue: string;
  onInputChange: (value: string) => void;
  onInputSubmit: (value: string) => void;
  thinking: boolean;
  providerName: string;
  model: string;
  contextUsed: number;
  contextMax: number;
  contextEstimated?: boolean;
  focusedBlockId?: string | null;
  expandedBlockIds?: ReadonlySet<string>;
  /** Error fatal (§11): bloque rojo + input bloqueado permanentemente. */
  fatalError?: { message: string } | null;
  /** `/debug`: pinta los bloques `⊙ thinking` del agente (§11). */
  debug?: boolean;
  pendingConfirm?: PendingConfirm | null;
  onConfirmApprove?: () => void;
  onConfirmDeny?: () => void;
  onConfirmAllowAll?: () => void;
  /** Panel de autocompletado de /comandos (§5.2), renderizado encima del input. */
  palette?: React.ReactNode;
  /** Overlay interactivo (/model, /config_provider). Sustituye al input mientras está activo. */
  overlay?: React.ReactNode;
  /** Estado de conectividad MCP para el indicador del status bar. */
  mcpStatus?: McpStatusSummary;
  /** Salud del provider activo para el `●` del status bar (Hito 6). */
  providerStatus?: ProviderStatus;
  /** Cambios del working tree ya formateados (`+N/-M`) para el status bar (Hito 13). */
  changes?: string;
  /** Contabilidad de tokens de la sesión para el medidor del status bar (Hito 13). */
  tokens?: TokenAccounting;
  /** Perfil activo como agente principal para el badge `◆` del status bar (Hito 15). */
  activeAgent?: string | null;
  /** Hito 17 — badges de sesión del status bar. */
  readOnly?: boolean;
  sessionProfile?: string | null;
  environment?: EnvironmentBadge | null;
  // ----- Plan & Execute (Hito 7) -----
  /** Modo del agente para el badge del status bar y el render del plan. */
  planMode?: AgentMode;
  /** Plan propuesto/aprobado con sus estados de paso. */
  plan?: Plan | null;
  /** Gate de aprobación (Fase 2) activo. */
  pendingApproval?: boolean;
  onPlanApprove?: (plan: Plan) => void;
  onPlanReject?: () => void;
  // ----- Lista de tareas (Hito 11) -----
  /** Tareas vivas; vacio tambien cuando el usuario colapso el panel. */
  todos?: TodoItem[];
  /** Turnos con tareas abiertas sin actualizar (marca de staleness). */
  todoStale?: number;
  // ----- Tanda única de preguntas (Hito 2.5, F7) -----
  /** Preguntas pendientes de responder; null fuera del gate. */
  pendingQuestions?: QuestionItem[] | null;
  onQuestionsSubmit?: (answers: QuestionAnswer[]) => void;
  onQuestionsCancel?: () => void;
}

export function ConversationView({
  completedItems,
  currentItem,
  inputValue,
  onInputChange,
  onInputSubmit,
  thinking,
  providerName,
  model,
  contextUsed,
  contextMax,
  contextEstimated,
  focusedBlockId,
  expandedBlockIds,
  fatalError,
  debug,
  pendingConfirm,
  onConfirmApprove,
  onConfirmDeny,
  onConfirmAllowAll,
  palette,
  overlay,
  mcpStatus,
  providerStatus,
  changes,
  tokens,
  activeAgent,
  readOnly,
  sessionProfile,
  environment,
  planMode,
  plan,
  pendingApproval,
  onPlanApprove,
  onPlanReject,
  todos,
  todoStale,
  pendingQuestions,
  onQuestionsSubmit,
  onQuestionsCancel,
}: Props) {
  const liveNow = useLiveClock(thinking);
  const { stdout } = useStdout();
  const terminalRows = stdout.rows ?? 24;
  const panelMaxSteps = Math.max(2, Math.min(5, Math.floor(terminalRows / 5)));
  const pinnedPanels =
    Number(Boolean(plan && planMode === 'execute')) + Number(Boolean(todos?.length));
  const availableConversationRows = Math.max(8, terminalRows - pinnedPanels * (panelMaxSteps + 3));
  return (
    <Box flexDirection="column" width="100%">
      <StatusBar
        providerName={providerName}
        model={model}
        contextUsed={contextUsed}
        contextMax={contextMax}
        estimated={contextEstimated}
        mcpStatus={mcpStatus}
        providerStatus={providerStatus}
        mode={planMode}
        changes={changes}
        tokens={tokens}
        activeAgent={activeAgent}
        readOnly={readOnly}
        sessionProfile={sessionProfile}
        environment={environment}
      />
      {plan && planMode === 'execute' && <PlanView plan={plan} maxSteps={panelMaxSteps} />}
      {todos && todos.length > 0 && (
        <TodoView items={todos} stale={todoStale ?? 0} maxSteps={panelMaxSteps} />
      )}
      <MessageList
        completedItems={completedItems}
        currentItem={currentItem}
        focusedBlockId={focusedBlockId}
        expandedBlockIds={expandedBlockIds}
        debug={debug}
        now={liveNow}
        availableRows={availableConversationRows}
      />
      {fatalError && <FatalError message={fatalError.message} />}
      {plan && pendingApproval && (
        <PlanApproval
          plan={plan}
          onApprove={onPlanApprove ?? (() => undefined)}
          onReject={onPlanReject ?? (() => undefined)}
        />
      )}
      {pendingQuestions && pendingQuestions.length > 0 && (
        <QuestionPrompt
          questions={pendingQuestions}
          onSubmit={onQuestionsSubmit ?? (() => undefined)}
          onCancel={onQuestionsCancel ?? (() => undefined)}
        />
      )}
      {pendingConfirm && (
        <DestructiveConfirm
          toolName={pendingConfirm.toolName}
          description={pendingConfirm.description}
          confirmPhrase={pendingConfirm.confirmPhrase}
          environment={pendingConfirm.environment}
          forced={pendingConfirm.forced}
          onApprove={onConfirmApprove ?? (() => undefined)}
          onDeny={onConfirmDeny ?? (() => undefined)}
          onAllowAll={onConfirmAllowAll ?? (() => undefined)}
        />
      )}
      {overlay}
      {!overlay && palette}
      {!overlay && (
        <InputArea
          value={inputValue}
          onChange={onInputChange}
          onSubmit={onInputSubmit}
          disabled={thinking || !!pendingConfirm || !!pendingQuestions?.length || !!fatalError}
        />
      )}
    </Box>
  );
}
