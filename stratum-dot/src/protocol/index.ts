/**
 * El Stratum Protocol, tal como lo ve Dot. **No hay tipos ni reglas propias
 * aquí**: todo se reexporta del contrato (`stratum-cli/src/protocol/`, puro y
 * sin Node). Un cambio del contrato llega a Dot al compilar, no por copia.
 *
 * Lo único que Dot añade está en `apply.ts` (qué hacer con lo que no valida) y
 * en `view.ts` / `activity.ts` / `interactions.ts` (cómo se pinta), y ninguno
 * decide estado. Qué respuesta vale para una solicitud lo dicen las reglas del
 * contrato (`checkApprovalResolution`, `checkQuestionAnswers`), no Dot.
 */
export type {
  Capability,
  ClassifiedEvent,
  FollowResult,
  ProtocolAgent,
  ProtocolApproval,
  ProtocolChatMessage,
  ProtocolEvent,
  ProtocolJob,
  ProtocolModel,
  ProtocolInteractionStatus,
  ProtocolPlanRequest,
  ProtocolQuestion,
  ProtocolQuestionAnswer,
  ProtocolQuestionRequest,
  ProtocolResolver,
  ProtocolRun,
  ProtocolRunStatus,
  ProtocolSession,
  ProtocolSessionSnapshot,
  ProtocolSessionState,
  ProtocolStateEvent,
  ProtocolToolCall,
} from '../../../stratum-cli/src/protocol/index';
export {
  EVENT_CLASS,
  LIMITS,
  STRATUM_PROTOCOL_VERSION,
  applySessionEvent,
  checkApprovalResolution,
  checkQuestionAnswers,
  followSession,
  isStateEvent,
} from '../../../stratum-cli/src/protocol/index';
