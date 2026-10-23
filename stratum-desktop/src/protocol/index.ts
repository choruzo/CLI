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
  ProtocolChatMessage,
  ProtocolContextReport,
  ProtocolEvent,
  ProtocolHistoryPage,
  ProtocolJob,
  ProtocolModel,
  ProtocolOverviewSnapshot,
  ProtocolPlanRequest,
  ProtocolQuestionRequest,
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
} from '../../../stratum-cli/src/protocol/index';
export {
  EMPTY_OVERVIEW,
  HISTORY_LIMITS,
  LIMITS,
  STRATUM_PROTOCOL_VERSION,
  applyOverviewEvent,
  followSession,
  isStateEvent,
} from '../../../stratum-cli/src/protocol/index';
