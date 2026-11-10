/**
 * El Stratum Protocol, tal como lo ve Stratum Desktop (M12). **No hay tipos ni
 * reglas propias aquí**: todo se reexporta del contrato
 * (`stratum-cli/src/protocol/`, puro y sin Node), igual que en Stratum Dot.
 * Un cambio del contrato llega a Desktop al compilar, no por copia.
 *
 * Seguir una sesión (`followSession`) y la foto de conjunto
 * (`applyOverviewEvent`) son también del contrato: Desktop y Dot no tienen un
 * reductor cada uno.
 */
export type {
  Capability,
  ClassifiedEvent,
  ClientKind,
  FollowResult,
  ProtocolAgent,
  ProtocolApproval,
  ProtocolBrowserScreen,
  ProtocolBrowserState,
  ProtocolBrowserStatus,
  ProtocolChangeStatus,
  ProtocolChangesSummary,
  ProtocolChatMessage,
  ProtocolContextReport,
  ProtocolDecision,
  ProtocolDreamResult,
  ProtocolProposal,
  ProtocolMemorySection,
  ProtocolEvent,
  ProtocolFileDiff,
  ProtocolHistoryPage,
  ProtocolJob,
  ProtocolModel,
  ProtocolOverviewSnapshot,
  ProtocolPlanRequest,
  ProtocolQuestionAnswer,
  ProtocolQuestionRequest,
  ProtocolResolver,
  ProtocolRevertPlan,
  ProtocolRun,
  ProtocolRunStatus,
  ProtocolSession,
  ProtocolSessionMemory,
  ProtocolSessionSnapshot,
  ProtocolSessionState,
  ProtocolSkill,
  ProtocolStateEvent,
  ProtocolTodo,
  ProtocolToolCall,
  ProtocolWorkingTreeChange,
  RevertStatus,
} from '../../../stratum-cli/src/protocol/index';
export {
  EMPTY_OVERVIEW,
  GIT_CHANGES_LIMITS,
  GIT_DIFF_LIMITS,
  HISTORY_LIMITS,
  LIMITS,
  PROTOCOL_MEMORY_SECTIONS,
  STRATUM_PROTOCOL_VERSION,
  applyOverviewEvent,
  checkApprovalResolution,
  checkQuestionAnswers,
  followSession,
  groupDecisionsBySection,
  memorySectionOf,
  isStateEvent,
} from '../../../stratum-cli/src/protocol/index';
