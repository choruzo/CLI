import React from 'react';
import { Box } from 'ink';
import { StatusBar } from './StatusBar.js';
import type { ProviderStatus } from './StatusBar.js';
import { MessageList } from './MessageList.js';
import { InputArea } from './InputArea.js';
import { DestructiveConfirm } from './DestructiveConfirm.js';
import { PlanView } from './PlanView.js';
import { PlanApproval } from './PlanApproval.js';
import type { ConvItem, PendingConfirm } from './App.js';
import type { McpStatusSummary } from '../../tools/mcp/manager.js';
import type { AgentMode, Plan } from '../../agent/types.js';

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
  // ----- Plan & Execute (Hito 7) -----
  /** Modo del agente para el badge del status bar y el render del plan. */
  planMode?: AgentMode;
  /** Plan propuesto/aprobado con sus estados de paso. */
  plan?: Plan | null;
  /** Gate de aprobación (Fase 2) activo. */
  pendingApproval?: boolean;
  onPlanApprove?: (plan: Plan) => void;
  onPlanReject?: () => void;
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
  pendingConfirm,
  onConfirmApprove,
  onConfirmDeny,
  onConfirmAllowAll,
  palette,
  overlay,
  mcpStatus,
  providerStatus,
  planMode,
  plan,
  pendingApproval,
  onPlanApprove,
  onPlanReject,
}: Props) {
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
      />
      {plan && planMode === 'execute' && <PlanView plan={plan} />}
      <MessageList
        completedItems={completedItems}
        currentItem={currentItem}
        focusedBlockId={focusedBlockId}
        expandedBlockIds={expandedBlockIds}
      />
      {plan && pendingApproval && (
        <PlanApproval
          plan={plan}
          onApprove={onPlanApprove ?? (() => undefined)}
          onReject={onPlanReject ?? (() => undefined)}
        />
      )}
      {pendingConfirm && (
        <DestructiveConfirm
          toolName={pendingConfirm.toolName}
          description={pendingConfirm.description}
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
          disabled={thinking || !!pendingConfirm}
        />
      )}
    </Box>
  );
}
