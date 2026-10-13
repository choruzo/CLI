/**
 * El Stratum Protocol, tal como lo ve Dot. **No hay tipos ni reglas propias
 * aquí**: todo se reexporta del contrato (`stratum-cli/src/protocol/`, puro y
 * sin Node). Un cambio del contrato llega a Dot al compilar, no por copia.
 *
 * Lo único que Dot añade está en `apply.ts` (qué hacer con lo que no valida) y
 * en `view.ts` / `activity.ts` (cómo se pinta), y ninguno decide estado.
 */
export type {
  Capability,
  ProtocolApproval,
  ProtocolEvent,
  ProtocolJob,
  ProtocolPlanRequest,
  ProtocolQuestionRequest,
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
  STRATUM_PROTOCOL_VERSION,
  applySessionEvent,
  isStateEvent,
} from '../../../stratum-cli/src/protocol/index';
