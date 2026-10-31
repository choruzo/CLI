/**
 * M16 — cuándo y qué avisar al sistema de una rutina que terminó (PRD §23.5).
 * Todo puro: de los eventos de run de una sesión con `routineId` y de la rutina
 * tal como la contesta `routines.list` sale el aviso; quién lo muestra es el lado
 * nativo (`notify.rs`). Un aviso informa y abre la sesión: nunca resuelve una
 * aprobación ni lleva acciones.
 */
import type { ProtocolRoutine } from './index';

/** Cuánto del resumen entra en el cuerpo del aviso. */
export const NOTICE_SUMMARY_CHARS = 200;

export type RoutineRunEnd = 'completed' | 'failed' | 'cancelled';

/** Un run de la sesión de una rutina que empezó o terminó, leído de un evento. */
export interface RoutineRunEvent {
  sessionId: string;
  runId: string;
  kind: 'started' | RoutineRunEnd;
}

const KINDS: Record<string, RoutineRunEvent['kind']> = {
  'run.started': 'started',
  'run.completed': 'completed',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
};

/** De un lote de eventos sin validar, los de inicio y fin de run. Lo demás se ignora. */
export function routineRunEvents(sessionId: string, raws: readonly unknown[]): RoutineRunEvent[] {
  const out: RoutineRunEvent[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'object' || raw === null) continue;
    const event = raw as { type?: unknown; runId?: unknown; data?: unknown };
    const kind = typeof event.type === 'string' ? KINDS[event.type] : undefined;
    if (!kind) continue;
    const run = (event.data as { run?: { id?: unknown } } | null | undefined)?.run;
    const runId = typeof run?.id === 'string' ? run.id : typeof event.runId === 'string' ? event.runId : null;
    if (runId) out.push({ sessionId, runId, kind });
  }
  return out;
}

export interface RoutineNotice {
  routineId: string;
  sessionId: string;
  runId: string;
  title: string;
  body: string;
}

const VERB: Record<RoutineRunEnd, string> = {
  completed: 'finished',
  failed: 'failed',
  cancelled: 'was cancelled',
};

const STATUS_TEXT: Record<RoutineRunEnd, string> = {
  completed: 'The run finished.',
  failed: 'The run failed.',
  cancelled: 'The run was cancelled.',
};

function trimTo(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * El aviso de un run terminado. Si `lastResult` es el de **ese** run, manda su
 * estado y su resumen (ya redactado por el daemon); si todavía es el de uno
 * anterior —la rutina se refrescó antes de que el daemon lo anotara—, vale el
 * estado del evento y el cuerpo es solo el estado: nunca el resumen de otro run.
 */
export function buildRoutineNotice(
  end: { sessionId: string; runId: string; kind: RoutineRunEnd },
  routine: ProtocolRoutine,
): RoutineNotice {
  const result = routine.lastResult && routine.lastResult.runId === end.runId ? routine.lastResult : null;
  const kind: RoutineRunEnd =
    result && (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled')
      ? result.status
      : end.kind;
  const summary = result?.summary ? trimTo(result.summary, NOTICE_SUMMARY_CHARS) : '';
  return {
    routineId: routine.id,
    sessionId: end.sessionId,
    runId: end.runId,
    title: `${routine.name} ${VERB[kind]}`,
    body: summary || STATUS_TEXT[kind],
  };
}

/** Sin aviso si la ventana tiene el foco y la persona ya está mirando esa sesión. */
export function shouldNotify(view: { windowFocused: boolean; sessionOnScreen: boolean }): boolean {
  return !(view.windowFocused && view.sessionOnScreen);
}

/**
 * Los runs ya avisados, en memoria: un run se avisa una sola vez aunque su fin
 * llegue repetido (una foto nueva, una reconexión). Acotado: olvida los más viejos.
 */
export class NoticeLedger {
  private readonly seen = new Set<string>();

  constructor(private readonly limit = 200) {}

  /** `true` la primera vez que se pregunta por ese run; `false` después. */
  take(runId: string): boolean {
    if (this.seen.has(runId)) return false;
    this.seen.add(runId);
    if (this.seen.size > this.limit) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.seen.clear();
  }
}
