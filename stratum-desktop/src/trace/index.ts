/**
 * La traza de una sesión, tal como la ve el panel de trayectoria de Stratum
 * Desktop. **No hay formato ni cálculos propios aquí**: todo se reexporta del
 * core (`stratum-cli/src/trace/`), puro y sin Node (`records.ts` no tiene
 * imports; `model.ts` solo `providers/cache.ts`, que tampoco), como
 * `../protocol/index.ts` hace con el contrato. Un cambio del formato llega a
 * Desktop al compilar, no por copia.
 */
export type {
  AuxiliaryOverlap,
  CacheBreak,
  TimelineMode,
  TraceModel,
  TraceStep,
} from '../../../stratum-cli/src/trace/model';
export {
  CACHE_BREAK_LABEL,
  KIND_LABEL,
  LANE_NAMES,
  LLM_CALL_ORIGINS,
  ORIGIN_LABEL,
  applyRecords,
  auxiliaryOverlaps,
  cacheBreaks,
  emptyTrace,
  firstLine,
  formatClock,
  formatDuration,
  formatTokenCount,
  isAuxiliaryCall,
  layoutTimeline,
  originOf,
  prefixOf,
  prettyValue,
  stepLabel,
  stepMatches,
  stepResult,
  stepText,
  tokensPerSecond,
  toolCallsOf,
  traceStats,
  usageOf,
} from '../../../stratum-cli/src/trace/model';
export type { TraceKind, TraceRecord, TraceStatus } from '../../../stratum-cli/src/trace/records';
export { TRACE_FORMAT_VERSION } from '../../../stratum-cli/src/trace/records';
