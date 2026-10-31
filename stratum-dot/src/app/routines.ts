/**
 * M16 — las rutinas del asistente: refrescar la lista y vigilar los runs de sus
 * sesiones. Todo por el protocolo (vía el lado nativo), sin estado supuesto: lo
 * que se enseña es lo que contestó `routines.list` o la mutación. Nada de sondeo:
 * se refresca al abrir la vista, tras cada mutación y cuando llega el inicio o el
 * fin de un run de la sesión de una rutina.
 */
import type { NativeBridge } from '../bridge/native';
import { toCommandError, type CommandError } from '../bridge/native';
import type { ProtocolRoutine } from '../protocol';
import {
  NoticeLedger,
  buildRoutineNotice,
  routineRunEvents,
  shouldNotify,
  type RoutineRunEnd,
} from '../protocol/routine-notices';
import { parseRoutines } from '../protocol/results';
import { useRoutines } from '../stores/routineStore';
import { useSessions } from '../stores/sessionStore';
import { useUi } from '../stores/uiStore';
import { describeCommandError } from './actions';

/** Cuánto se espera para releer la rutina si el daemon aún no había anotado el resultado. */
export const RESULT_RETRY_MS = 1_500;

let sequence = 0;

/**
 * Pide `routines.list` y la guarda. Devuelve la lista, o `null` si falló (y
 * entonces el store conserva la última conocida con el error al lado). Una
 * respuesta tardía de un refresco anterior no pisa a la de uno posterior.
 */
export async function refreshRoutines(native: NativeBridge): Promise<ProtocolRoutine[] | null> {
  const mine = ++sequence;
  const store = useRoutines.getState();
  store.setLoading(true);
  try {
    const list = parseRoutines(await native.routinesList());
    if (mine !== sequence) return useRoutines.getState().routines;
    if (!list) {
      useRoutines.getState().setFailure('The daemon answered in a way this version of Dot cannot read.', false);
      return null;
    }
    useRoutines.getState().setList(list.routines, list.readOnly);
    return list.routines;
  } catch (err) {
    if (mine === sequence) {
      const error = toCommandError(err);
      useRoutines.getState().setFailure(describeRoutineError(error), error.reason === 'routines-disabled');
    }
    return null;
  } finally {
    if (mine === sequence) useRoutines.getState().setLoading(false);
  }
}

/** El texto de un error de rutinas: lo del daemon, con sus dos casos conocidos explicados. */
export function describeRoutineError(error: CommandError): string {
  if (error.reason === 'routines-disabled') {
    return 'Routines are not enabled in this daemon: it has no scheduler.';
  }
  if (error.reason === 'read-only') {
    return 'The routines file was written by a newer Stratum or is damaged: routines can be seen but not changed.';
  }
  if (error.code === 'NOT_FOUND') return 'That routine no longer exists.';
  if (error.kind === 'unknown') {
    return 'Result unknown: the daemon did not answer in time. Check the list before trying again.';
  }
  return describeCommandError(error);
}

/** Los campos del formulario, para pintar un error junto al suyo. */
export type RoutineField = 'name' | 'schedule' | 'prompt' | 'model' | 'maxIterations' | 'timeoutMinutes';

/**
 * El campo al que se refiere un `INVALID_PARAMS`. El daemon dice «Invalid
 * &lt;campo&gt;: …» (o «A routine named … already exists»); el lado nativo pasa el
 * mensaje, no la lista `issues`. Sin campo claro, `null`: se pinta en el panel.
 */
export function routineFieldOf(error: CommandError): RoutineField | null {
  if (error.code !== 'INVALID_PARAMS' && error.kind !== 'invalid') return null;
  const message = error.message;
  if (/already exists/i.test(message)) return 'name';
  const named =
    /^Invalid ([A-Za-z.]+):/.exec(message)?.[1] ??
    /^The ([a-z ]+) is /.exec(message)?.[1] ??
    /^Invalid ([a-z ]+)\./.exec(message)?.[1];
  switch (named) {
    case 'name':
      return 'name';
    case 'schedule':
      return 'schedule';
    case 'prompt':
      return 'prompt';
    case 'model':
    case 'model name':
      return 'model';
    case 'limits.maxIterations':
    case 'iteration limit':
      return 'maxIterations';
    case 'limits.timeoutMinutes':
    case 'time limit':
      return 'timeoutMinutes';
    default:
      return null;
  }
}

/** Los runs ya avisados (memoria): un run se avisa una vez. */
const ledger = new NoticeLedger();
/** Los runs cuyo aviso está en camino: una segunda copia del fin no lo duplica. */
const underway = new Set<string>();

/** Para los tests: olvida lo avisado. */
export function resetRoutineWatch(): void {
  ledger.clear();
  underway.clear();
  sequence = 0;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sessionOnScreen(sessionId: string): boolean {
  const ui = useUi.getState();
  if (ui.view === 'assistant') return ui.companionId === sessionId;
  return ui.view === 'sessions' && !ui.composingNew && ui.selectedId === sessionId;
}

function windowFocused(): boolean {
  try {
    return typeof document !== 'undefined' && document.hasFocus();
  } catch {
    return false;
  }
}

/**
 * Llega un lote de eventos de una sesión. Si es la sesión de una rutina (el
 * `routineId` sale de su foto) y trae el inicio o el fin de un run, se refresca
 * la lista; con un fin, además, se avisa al sistema — una vez por run, y no si
 * la persona ya está mirando esa sesión con la ventana en primer plano.
 */
export function watchRoutineRuns(native: NativeBridge, sessionId: string, raws: readonly unknown[]): void {
  const routineId = useSessions.getState().sessions[sessionId]?.snapshot?.session.routineId;
  if (!routineId) return;
  const events = routineRunEvents(sessionId, raws);
  if (events.length === 0) return;
  void (async () => {
    // Un refresco por lote, aunque traiga varios eventos.
    let routines = await refreshRoutines(native);
    for (const event of events) {
      if (event.kind === 'started') continue;
      const end: { sessionId: string; runId: string; kind: RoutineRunEnd } = {
        sessionId,
        runId: event.runId,
        kind: event.kind,
      };
      if (underway.has(end.runId)) continue;
      underway.add(end.runId);
      try {
        let routine = routines?.find((r) => r.id === routineId) ?? null;
        // El fin del run puede llegar antes de que el daemon anote su resultado: una segunda lectura.
        if (routine && routine.lastResult?.runId !== end.runId) {
          await sleep(RESULT_RETRY_MS);
          routines = await refreshRoutines(native);
          routine = routines?.find((r) => r.id === routineId) ?? routine;
        }
        // Sin saber de qué rutina es (nunca contestó la lista) no hay a quién nombrar.
        if (!routine) continue;
        if (!shouldNotify({ windowFocused: windowFocused(), sessionOnScreen: sessionOnScreen(sessionId) })) {
          ledger.take(end.runId);
          continue;
        }
        if (!ledger.take(end.runId)) continue;
        const notice = buildRoutineNotice(end, routine);
        await native
          .notifyRoutine({ title: notice.title, body: notice.body, sessionId: notice.sessionId })
          .catch(() => undefined);
      } finally {
        underway.delete(end.runId);
      }
    }
  })();
}
