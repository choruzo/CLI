import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { theme } from './theme.js';
import { StatusBar } from './StatusBar.js';
import type { EnvironmentBadge, ProviderStatus } from './StatusBar.js';
import { MessageList } from './MessageList.js';
import { InputArea } from './InputArea.js';
import { DestructiveConfirm } from './DestructiveConfirm.js';
import { PlanView } from './PlanView.js';
import { TodoView } from './TodoView.js';
import { JobsView, visibleJobs } from './JobsView.js';
import type { BackgroundJob } from '../../jobs/types.js';
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
  // ----- Jobs en segundo plano -----
  /** Jobs de la sesión; el panel solo pinta los vivos y los recién terminados. */
  jobs?: BackgroundJob[];
  /** Reloj con el que se calcula el tiempo transcurrido de cada job. */
  jobsNow?: number;
  // ----- Tanda única de preguntas (Hito 2.5, F7) -----
  /** Preguntas pendientes de responder; null fuera del gate. */
  pendingQuestions?: QuestionItem[] | null;
  onQuestionsSubmit?: (answers: QuestionAnswer[]) => void;
  onQuestionsCancel?: () => void;
  /** Mensajes del usuario encolados para el turno en curso y aún sin entregar. */
  pendingSteering?: number;
  /** Aviso de una línea sobre el input (p. ej. por qué no se encoló algo). */
  inputHint?: string | null;
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
  jobs,
  jobsNow,
  pendingQuestions,
  onQuestionsSubmit,
  onQuestionsCancel,
  pendingSteering = 0,
  inputHint,
}: Props) {
  const liveNow = useLiveClock(thinking);
  // Un gate (confirmación, preguntas, aprobación de plan) es dueño del teclado.
  const gateOpen = !!pendingConfirm || !!pendingQuestions?.length || !!pendingApproval;
  // Con el agente trabajando el input sigue vivo: lo enviado es steering.
  const steerable = thinking && !gateOpen && !fatalError;
  const { stdout } = useStdout();
  const terminalRows = stdout.rows ?? 24;
  const panelMaxSteps = Math.max(2, Math.min(5, Math.floor(terminalRows / 5)));
  const jobsClock = jobsNow ?? Date.now();
  const showJobs = Boolean(jobs && visibleJobs(jobs, jobsClock).length > 0);
  const pinnedPanels =
    Number(Boolean(plan && planMode === 'execute')) +
    Number(Boolean(todos?.length)) +
    Number(showJobs);
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
      {showJobs && <JobsView jobs={jobs ?? []} now={jobsClock} maxRows={panelMaxSteps} />}
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
      {!overlay && pendingSteering > 0 && (
        <Text color={theme.warning}>
          {' '}
          ⧗ {pendingSteering} steering {pendingSteering === 1 ? 'update' : 'updates'} pending
          <Text color={theme.textMuted}>
            {thinking
              ? ' · the agent picks them up at its next safe point'
              : ' · delivered with your next message'}
          </Text>
        </Text>
      )}
      {!overlay && inputHint && <Text color={theme.textMuted}> {inputHint}</Text>}
      {!overlay && (
        <InputArea
          value={inputValue}
          onChange={onInputChange}
          onSubmit={onInputSubmit}
          disabled={gateOpen || !!fatalError || (thinking && !steerable)}
          steering={steerable}
        />
      )}
    </Box>
  );
}
