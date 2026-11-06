/**
 * Lo que llega del daemon como traza, comprobado en el borde del webview: el
 * lado nativo solo mira el sobre (`trace.records`) y deja pasar cada registro
 * sin interpretar, así que aquí se valida cada variante que el panel usa. Lo
 * que no encaja se descarta (y se cuenta): un registro mal formado no puede
 * tumbar el render. Los tipos de un formato más nuevo también se descartan.
 *
 * Los textos de los fallos son de esta interfaz (los códigos son del daemon
 * o del enlace nativo).
 */
import type { TraceKind, TraceRecord, TraceStatus } from './index';

const TRACE_KINDS = new Set<string>(['system', 'user', 'context', 'model', 'tool', 'subagent', 'notice']);
const TRACE_STATUS = new Set<string>(['ok', 'error', 'cancelled']);

const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Un registro de la traza. `data` es libre: el panel lo pinta como texto. */
export function parseTraceRecord(v: unknown): TraceRecord | null {
  if (!isRecord(v) || !num(v.at)) return null;
  const data = isRecord(v.data) ? { data: v.data } : {};
  const parent = str(v.parent) ? { parent: v.parent } : {};
  const status = str(v.status) && TRACE_STATUS.has(v.status) ? (v.status as TraceStatus) : null;
  switch (v.t) {
    case 'turn':
      return str(v.input) ? { t: 'turn', at: v.at, input: v.input } : null;
    case 'turn_end':
      return { t: 'turn_end', at: v.at, stopReason: str(v.stopReason) ? v.stopReason : null };
    case 'begin':
    case 'point': {
      if (!str(v.id) || !str(v.name) || !str(v.kind) || !TRACE_KINDS.has(v.kind)) return null;
      const base = { at: v.at, id: v.id, kind: v.kind as TraceKind, name: v.name, ...parent, ...data };
      return v.t === 'begin' ? { t: 'begin', ...base } : { t: 'point', ...base, ...(status ? { status } : {}) };
    }
    case 'end':
      return str(v.id) && status ? { t: 'end', at: v.at, id: v.id, status, ...data } : null;
    case 'mark':
      return str(v.id) && str(v.name) ? { t: 'mark', at: v.at, id: v.id, name: v.name } : null;
    case 'meta':
      // De la cabecera el panel solo usa `caps`: sin él no sabría si la traza
      // registraba las llamadas auxiliares o simplemente no hubo ninguna.
      return {
        t: 'meta',
        v: num(v.v) ? v.v : 0,
        at: v.at,
        sessionId: str(v.sessionId) ? v.sessionId : '',
        ...(Array.isArray(v.caps) ? { caps: v.caps.filter(str) } : {}),
      };
    default:
      return null;
  }
}

export interface ParsedRecords {
  records: TraceRecord[];
  /** Cuántos de la tanda no encajaron y se descartaron. */
  rejected: number;
}

/** Los registros válidos de una tanda; `null` si ni siquiera es una lista. */
export function parseTraceRecords(raw: unknown): ParsedRecords | null {
  if (!Array.isArray(raw)) return null;
  const records: TraceRecord[] = [];
  for (const item of raw) {
    const record = parseTraceRecord(item);
    if (record) records.push(record);
  }
  return { records, rejected: raw.length - records.length };
}

/** Por qué no hay trayectoria que enseñar, en una frase para la persona. */
export function describeTraceUnavailable(code: string, reason: string | null): string {
  if (code === 'UNAVAILABLE' && reason === 'peer-hosted') {
    return 'Esta sesión corre en su propia terminal: su traza la escribe ese proceso y el daemon no la retransmite.';
  }
  switch (code) {
    case 'NOT_FOUND':
      return 'El daemon no tiene la traza de esta sesión.';
    case 'FORBIDDEN':
      return 'El daemon no permite a este cliente leer la traza.';
    case 'INVALID_TRACE':
      return 'El daemon envió una traza que no se pudo leer; se ha dejado de seguir.';
    case 'TIMEOUT':
      return 'El daemon no contestó a tiempo a la petición de la traza.';
    case 'FORMAT':
      return 'La traza usa un formato más nuevo que esta versión de Stratum Desktop.';
    default:
      return `La trayectoria no está disponible (${code}).`;
  }
}
